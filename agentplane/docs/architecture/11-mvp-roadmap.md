# 11 — MVP Roadmap(分阶段实施计划)

> 通用 rollback 原则:每阶段独立可回退;数据库迁移 expand-only(只加不删);功能开关(system_settings)控制新路径,关掉即回旧路径。

## Phase 0 — 服务器与脚手架(约 1 周)

**目标**:Rocky Linux 服务器就绪 + monorepo 脚手架 + **两个关键 spike 验证**。

任务:
1. 系统:更新、`agentplane`/`agentplane-agent` 用户、firewalld、fail2ban、SSH 加固
2. 安装:git、tmux(过渡)、Docker + compose、Node 20(nvm/dnf module)、pnpm、PostgreSQL 16、Redis 7、Caddy
3. 目录:建 `/srv/agentplane/{projects,workspaces,uploads,logs,artifacts}` + 权限(见 runbook)
4. monorepo:pnpm workspace + turborepo + apps/packages 骨架 + lint/tsconfig 基线
5. **Spike A(最高优先)**:headless 驱动验证——脚本起 `claude -p` / `codex exec`,捕获 stream-json,验证:注入附件路径可读图、可改文件、退出码可靠、可 SIGTERM 中断。产出报告写入 docs/adr 附录
6. **Spike B**:git worktree 流程手工演练(bare mirror → worktree → diff → 清理)
7. systemd unit 模板 + Caddy 反代(SSE 透传配置)

验收:`curl https://host/healthz` 通;Spike A/B 报告通过;`pnpm build` 全绿。
风险:CLI headless 能力与假设不符(→ 立即调整 04 设计,这正是先 spike 的原因)。
Rollback:纯增量,无需回退。

## Phase 1 — 单用户 MVP(2–3 周)⭐ 核心价值验证

**目标**:手机上完成 创建 Demand → 传截图 → 跑 Agent → 看实时日志 → 看 diff 全链路。

任务:
1. `packages/db`:users(单用户 seed)/projects/demands/demand_attachments/agent_runs/run_steps/run_logs/run_artifacts/workspaces/agent_profiles 迁移
2. `apps/api`:项目注册、Demand CRUD、附件上传(含 §09 安全校验)、`POST /demands/:id/run`、SSE `/runs/:id/events`
3. `apps/worker`:BullMQ 消费 + WorkspaceManager(worktree+附件复制)+ ClaudeExecutor + CodexExecutor + 日志管线(落盘/落库/脱敏/发布)+ diff 收集
4. `apps/portal`:登录(单用户)、Projects、Create Demand(移动优先)、Run Detail + Live Logs、diff 只读展示
5. 模块:shared 状态机、safeJoin、脱敏器(均带单测)

验收(手机实测):iPhone 上传截图建 Demand → 运行 → 断网 30s 重连日志不丢 → 杀浏览器任务照跑 → diff 可见;两个不同项目的 Run 可并发。
风险:agent 长时间运行的流稳定性;移动端 SSE 兼容(iOS Safari 后台冻结——回前台校准拉取)。
Rollback:停 portal/api/worker 三个 unit,回到纯 SSH 工作流,零损失。

## Phase 2 — Review MVP(1–2 周)

**目标**:审核闭环 + 本地 git 闭环。

任务:Diff Review 页(文件树+Monaco)、approvals 表与 API(approve/reject/request-changes)、commit job(模板化 message)、回炉流程(review_feedback 注入 prompt)、ShellExecutor + 项目 test/build 命令模板、Run 内 test 步骤。
验收:Accept 后 bare 仓库出现规范 commit;Request Changes 后新 Run 的 prompt 含审核意见;未批准调 commit 接口必 403。
风险:大 diff 移动端渲染性能(>200 文件 → 分页/折叠)。
Rollback:关闭 commit 功能开关,diff 仍可人工 `git apply`。

## Phase 3 — Queue 强化 + Lock + 状态机完备(1–2 周)

**目标**:并发安全与崩溃自愈,达到"敢开多 worker"。

任务:Project Lock(Redis Lua + PG 持久化 + heartbeat + 对账 job)、worker 多实例 + stalled 恢复(全新 workspace 重跑)、demand/run 状态机迁移强校验(应用层+触发器)、stop/retry/控制信道、TimeoutPolicy/ResourceLimitPolicy(systemd-run scope)、gc 定时任务、Locks 管理 UI。
验收:混沌测试——两写任务同 project+branch 必串行;`kill -9` worker 后 job 自动恢复且无双锁(PG 部分唯一索引验证);锁 TTL 过期可被接管;手机 stop 5s 内生效。
风险:锁边界条件(误续/误删)→ Lua 原子脚本 + 集成测试矩阵。
Rollback:WORKER_CONCURRENCY=1 退化单工人,锁逻辑保留。

## Phase 4 — CI/CD(2 周)

**目标**:push → PR → Actions → preview 全自动,部署受审批门禁。

任务:push job(deploy key 隔离注入)、PR 创建(PAT→GitHub App)、webhook 接收验签 + ci_jobs 回写 + 兜底轮询、compose preview 驱动(起/停/回收/上限)、deployments 表 + staging/production deploy job + rollback、部署审批门禁与确认 UI、(可选)agent Docker sandbox 化。
验收:Approve 一键 ship 后 5 分钟内 PR + CI 状态出现在 Portal;CI 绿自动出 preview URL;production 无 approval 必拒;rollback 实测恢复上一版本。
风险:webhook 公网可达性(内网部署 → 纯轮询模式);preview 资源挤占(并发上限+独立 cgroup)。
Rollback:关闭 auto-preview/deploy 开关,退回"系统出 PR、人工部署"。

## Phase 5 — Multi-user(1–2 周)

**目标**:安全多人协作。

任务:注册/邀请、organizations 启用、project_members + RBAC guard 全接口覆盖、audit_logs 全写路径埋点 + Audit UI、rate limit、reviewer≠owner 强制(high/critical)、双批流程、通知中心(Web Push 可选)。
验收:权限矩阵逐项端到端测试(viewer 不能 run、developer 不能 approve、非 admin 不能 prod deploy);审计可还原任意一次部署的完整链条。
风险:既有单用户数据迁移(写迁移脚本归属默认 org/maintainer)。
Rollback:冻结注册,旧账号不受影响。

## Phase 6 — Daily Demand Stack(1 周+持续调优)

**目标**:每日自动规划,半自动开发节奏成型。

任务:scheduled_date/stack_order 调度器、06:00 规划 cron(评分见 06 §4)、Stack 页拖拽与"采纳计划"流、失败重试与降级策略、(可选)clarify-assist 分析 Run、(可选)低风险 demand 自动执行至 waiting_review 的开关。
验收:连续 5 个工作日,每日早晨可一键采纳合理计划;失败 demand 次日自动回榜且 3 次后打 needs-human;无任何变更绕过 review。
风险:自动化边界蠕变——**铁律:自动化终点永远是 waiting_review**。
Rollback:关闭 cron,退回手动排程,数据结构不变。
