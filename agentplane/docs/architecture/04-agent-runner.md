# 04 — Agent Runner 设计

## 1. 定位

Agent Runner 运行于 Worker 进程内,职责:把一个 `agent_run` job 变成"在隔离 workspace 中受控执行的 CLI 进程",并把全部副作用(日志、diff、artifacts、状态)持久化。**Runner 对 agent 一无所知地编排,对 agent 的全部认知封装在 Executor 实现里。**

## 2. AgentProfile

DB 表见 03-data-model §2.19。示例 seed:

```json
[
  {"slug":"claude-code","executor":"claude","binary_path":"/usr/local/bin/claude",
   "default_args":["-p","--output-format","stream-json","--verbose"],
   "supports_vision":true,"allowed_run_modes":["analysis","edit","test"],
   "env_allowlist":["HOME","PATH","ANTHROPIC_API_KEY"]},
  {"slug":"codex","executor":"codex","binary_path":"/usr/local/bin/codex",
   "default_args":["exec","--json"],
   "supports_vision":true,"allowed_run_modes":["analysis","edit","test"],
   "env_allowlist":["HOME","PATH","OPENAI_API_KEY"]},
  {"slug":"shell","executor":"shell","binary_path":"/bin/bash",
   "supports_vision":false,"allowed_run_modes":["test","build","deploy"],
   "env_allowlist":["HOME","PATH"]}
]
```

> ⚠️ 两个 CLI 的 headless 参数随版本演进,Phase 0 必须 spike 验证并把确切参数写入 profile,而不是硬编码。

## 3. AgentExecutor 接口(TypeScript)

```typescript
interface ExecContext {
  run: AgentRun;            // 含 mode、timeout、dangerous_mode
  workspace: Workspace;     // path、branch、base_commit
  attachments: AttachmentRef[];
  prompt: string;           // 已生成的完整 prompt
  policies: { command: CommandPolicy; timeout: TimeoutPolicy; resource: ResourceLimitPolicy };
  emit: (event: RunEvent) => void;   // 统一事件出口(落库+落盘+SSE)
}

interface AgentExecutor {
  prepare(ctx: ExecContext): Promise<void>;        // 校验 binary、组装 args/env(经 env_allowlist 过滤)
  start(ctx: ExecContext): Promise<RunningProcess>;// spawn(pty),返回句柄
  streamLogs(proc: RunningProcess, ctx: ExecContext): AsyncIterable<LogLine>; // 行级解析,识别结构化事件
  stop(proc: RunningProcess, reason: StopReason): Promise<void>; // SIGTERM→5s→SIGKILL(进程组)
  collectDiff(ctx: ExecContext): Promise<DiffResult>;     // git add -A; git diff --staged --binary
  collectArtifacts(ctx: ExecContext): Promise<ArtifactRef[]>;
  cleanup(ctx: ExecContext): Promise<void>;        // 杀残留进程、解除 worktree 占用标记
}
```

实现:

- **ClaudeExecutor** — `claude -p "<prompt>" --output-format stream-json`;解析 JSON 流提取 tool 调用、token 用量;`supports_vision=true` 时 prompt 引导其读取 `./attachments/*.png`。
- **CodexExecutor** — `codex exec --json "<prompt>"`;同上,解析其 JSON 事件流。
- **ShellExecutor** — 执行项目 settings 中预声明的 `test_command` / `build_command` / `deploy_command`;**只允许执行预注册命令模板,不接受自由命令字符串**。

新 agent 接入 = 实现接口 + 注册 profile,核心零改动(设计原则 #15)。

## 4. 安全与策略组件

### 4.1 SafetyGuard(执行前闸门)
顺序校验,任一失败即拒绝并落 audit:
1. agent_profile.is_enabled 且 run_mode ∈ allowed_run_modes
2. dangerous_mode ⇒ project.allow_dangerous_mode ∧ risk ≤ medium ∧ 非 deploy
3. workspace.path realpath 必须位于 `/srv/agentplane/workspaces/`(防穿越)
4. env 经 allowlist 白名单过滤;**生产 secrets 变量名在全局 denylist,任何 executor 不可见**
5. 写模式 ⇒ 已持有有效 lock

### 4.2 CommandPolicy
- analysis 模式:agent 以只读意图运行(prompt 约束 + 事后 `git status` 校验,发现写入则 Run 标记 failed + 告警)
- ShellExecutor:仅模板命令;模板参数经 shell-escape
- denylist 兜底(对 agent 自身命令确认机制失效时的最后防线,日志侧检测):`rm -rf /`、`curl|sh`、写 `/etc`、`docker run --privileged`、访问 `/srv/agentplane/uploads` 等模式 → 立即 stop + failed

### 4.3 TimeoutPolicy
- 总时长:run.timeout_seconds(默认 3600,上限 profile.max_timeout_seconds)
- 静默超时:连续 10 分钟无输出 → 判定挂死 → stop → `timed_out`
- waiting_user_input 状态最长 30 分钟,超时 → `timed_out`

### 4.4 ResourceLimitPolicy
- MVP:`systemd-run --scope -p MemoryMax=4G -p CPUQuota=200% -p TasksMax=256` 包裹 agent 进程(进程组级,可靠 cgroup 限制)
- Phase 4+:Docker sandbox(`--network=none` 可选、只读挂载 bare repo)

## 5. Run 执行流程(Worker 内)

```
 1. receive job(run_id)            → BullMQ;置 status,记录 worker_id
 2. acquire project lock           → 仅写模式;阻塞等待带超时(默认 30min),期间 status=queued + blocked_by 提示
 3. create workspace               → WorkspaceManager.create()(worktree,见 05)
 4. copy attachments               → uploads → {ws}/attachments/;校验 sha256
 5. generate agent prompt          → 模板:Demand(title/desc/acceptance criteria)
                                      + context_files + attachments 清单
                                      + review_feedback 评论(若为回炉 Run)
                                      + 模式约束("不要 commit,不要 push,改完即停")
 6. launch CLI process             → executor.start();pty;进程组;systemd-run scope
 7. stream logs                    → 行级:落盘 → 脱敏 → 落库(批量)→ Redis publish
 8. detect completion              → exit code + 结构化流终止事件;心跳续锁贯穿全程
 9. run tests/build if required    → ShellExecutor 步骤(run_steps 独立记录)
10. collect diff                   → git add -A && git diff --staged --binary;空 diff 也记录(is_empty)
11. store artifacts                → patch、测试报告等 → /artifacts/{run_id}/
12. release lock                   → 成功失败都释放(finally 语义)
13. update status                  → succeeded→demand=waiting_review(有 diff 时)
                                      / failed / timed_out;发终态事件
```

每一步对应一条 `run_steps` 记录,Run Detail 页据此渲染 timeline。

## 6. 异常处理矩阵

| 场景 | 检测 | 处理 |
|---|---|---|
| **SSH/浏览器断线** | 无需检测 | 零影响。任务在 Worker;SSE 重连用 Last-Event-ID 从 run_logs 续传 |
| **Worker crash** | BullMQ stalled 检测(job 锁过期);Redis lock TTL 到期 | job 回队列重投(attempts 上限 2);新 worker 领取后:发现旧 workspace → 标记 dirty 弃用,**全新 workspace 重跑**(不续跑半成品);PG lock 行标 expired |
| **process timeout** | TimeoutPolicy 双计时器 | stop(进程组 SIGTERM→SIGKILL)→ 收集已有日志/部分 diff 存档 → timed_out |
| **user stop** | POST /runs/:id/stop → Redis 控制信道 | worker 订阅 run:{id}:control → 优雅停止 → cancelled;diff 仍收集存档供查看 |
| **agent waiting input** | 解析结构化流中的 ask/permission 事件 | status=waiting_user_input,Portal 弹卡片;用户回复经控制信道写入 agent stdin;MVP 简化策略:headless + 预授权,尽量不进入此态 |
| **malformed output** | JSON 解析失败 | 降级为纯文本日志,不中断 Run;终态以 exit code 为准;连续解析失败计数告警 |
| **partial changes** | exit≠0 但 git status 有改动 | 仍 collect diff 存档,Run=failed,diff 标记 partial=true 供人工判断挽救 |
| **build failure** | ShellExecutor step exit≠0 | Run=failed,build 日志为 artifact;diff 保留;可"修复式重试"(新 Run,prompt 注入失败日志) |
| **retry** | 用户触发 / 自动(仅基础设施类失败自动重试 1 次) | 同 Demand 新 Run(attempt+1),全新 workspace;Agent 输出性失败**不自动重试**,必须人看 |
| **rollback(代码)** | — | 未 commit:删 workspace 即回滚;已 commit 未 merge:删分支;已部署:走 deployments.rollback(见 10-cicd) |

## 7. 控制信道

每个 run 一个 Redis channel `run:{id}:control`,消息:`{type: "stop"|"input", payload}`。Worker 在 streamLogs 循环中非阻塞轮询。这是"用户从手机停止任务/回答 agent 提问"的通路,与日志通道(`run:{id}:events`)分离。
