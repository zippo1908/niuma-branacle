# 05 — Workspace Isolation(工作区隔离策略)

## 1. 目录布局(服务器运行时,非 repo 内)

> 以下 `/srv/agentplane` 为默认值,实际由 `AGENTPLANE_DATA_DIR` 环境变量决定;代码中禁止硬编码绝对路径(开源多环境要求,见 docs/oss/open-source-readiness.md)。

```
/srv/agentplane/
├── projects/                     # bare 镜像仓库(唯一 fetch 入口)
│   └── {project_slug}.git/
├── workspaces/                   # per-run 隔离工作区
│   └── {project_slug}/
│       └── {run_id}/             # git worktree
│           ├── ...源码...
│           └── attachments/      # 本次 Run 的附件副本
├── uploads/                      # 附件原件(内容寻址,agent 不可达)
│   └── {yyyy}/{mm}/{sha256}.{ext}
├── artifacts/
│   └── {run_id}/                 # patch / 测试报告 / 构建产物
├── logs/
│   └── {run_id}.log              # 原始全量日志
├── portal/  api/  worker/        # 应用部署目录(由 CI 发布)
└── infra/                        # compose / nginx / systemd 配置
```

权限:`agentplane` 系统用户拥有全部;agent 进程以 `agentplane-agent` 用户运行,仅对自己的 `{run_id}/` 可写,对 `uploads/`、`projects/*.git` 无权限(组权限隔离;MVP 至少做到 uploads 0700 属主 agentplane)。

## 2. 四种方案对比

| 维度 | 直接在项目目录跑 | git clone per run | **git worktree per run** | Docker volume per run |
|---|---|---|---|---|
| 隔离性 | ❌ 无,互踩 | ✅ 完全 | ✅ 完全(各自工作树+分支) | ✅✅ 进程+FS 双隔离 |
| 创建速度 | 即时 | 慢(大仓库分钟级) | **秒级**(共享对象库) |  clone/快照成本 + 容器启动 |
| 磁盘 | 1 份 | N 份全量 | 1 份对象库 + N 份工作树 | 取决于实现 |
| diff 基线 | 混乱 | 清晰 | **清晰**(base_commit 记录) | 清晰 |
| 实现复杂度 | 零 | 低 | 低-中(需管理 worktree 注册表) | 高 |
| 安全上限 | 最低 | 中 | 中(同主机进程) | 最高 |
| 结论 | **禁止** | 备选 | **MVP 推荐** | Phase 4+ 叠加 |

**MVP 决策:git worktree per run**,bare 镜像仓库作为共享对象库;Phase 4+ 在 worktree 外再包一层 Docker sandbox(worktree 目录挂载进容器),两方案叠加而非替换。

## 3. WorkspaceManager 接口与流程

```typescript
interface WorkspaceManager {
  create(run: AgentRun, demand: Demand): Promise<Workspace>;
  copyAttachments(ws: Workspace, atts: Attachment[]): Promise<void>;
  generateDiff(ws: Workspace): Promise<DiffResult>;
  markDirty(ws: Workspace): Promise<void>;     // crash 恢复时弃用
  cleanup(ws: Workspace, opts: {force?: boolean}): Promise<void>;
  gc(): Promise<GcReport>;                      // 定时清理
}
```

**create() 流程**:

```bash
# 1. 确保 bare 镜像最新(串行化 per project,避免并发 fetch 冲突)
git -C /srv/agentplane/projects/{slug}.git fetch origin --prune

# 2. 计算分支:Demand 首个写 Run 创建 work_branch,后续 Run 复用
WORK=demand/{number}-{title_slug}
BASE=$(git -C .../{slug}.git rev-parse origin/{target_branch})

# 3. 建 worktree(同时建/检出分支)
git -C .../{slug}.git worktree add \
    /srv/agentplane/workspaces/{slug}/{run_id} \
    -B $WORK $BASE        # 回炉 Run:基于已有 work_branch HEAD

# 4. 记录 workspaces 行(base_commit=$BASE, status=ready)
# 5. mkdir attachments/ && 复制附件 && chown
```

**diff 生成**(统一口径,不依赖 agent 是否 commit):

```bash
git add -A
git diff --staged --binary --find-renames > /srv/agentplane/artifacts/{run_id}/changes.patch
git diff --staged --numstat   # → diffs.summary
```

prompt 中明确要求 agent **不要自行 commit/push**;若 agent 已 commit,则以 `git diff {base_commit}..HEAD` 为准(实现需兼容两种情况)。

## 4. branch per demand

- 一个 Demand 一个 `demand/{number}-{slug}` 分支,跨多个 Run(重试/回炉)持续累积
- commit 只在 Approve 之后由系统执行(见 10-cicd),作者落款 `AgentPlane Agent <agent@agentplane>` + `Co-Authored-By: {owner}`
- Demand done/rejected 后,分支按 retention 删除(remote 上已 merge 的由 PR 设置自动删)

## 5. Cleanup 与 Retention 策略

| 对象 | 触发 | 策略(默认,system_settings 可调) |
|---|---|---|
| workspace | Run 终态 + Demand 出审核态 | accepted&pushed → 立即清;rejected → 保留 7 天(供翻案)后清 |
| workspace(孤儿) | 每日 gc:目录存在但无对应活跃 run | 标 dirty,48h 后强清 `git worktree remove --force` + `git worktree prune` |
| artifacts | — | 保留 180 天;deploy 相关产物永久 |
| logs(文件) | — | 保留 180 天,gzip 归档 |
| run_logs(表) | — | 90 天后删行(文件仍在) |
| uploads | 引用计数(sha256 不再被任何 demand 引用) | 引用为 0 且 90 天 → 删除 |
| 磁盘水位 | df > 85% | 告警 + gc 提前;>95% 拒绝新写 Run |

清理动作全部写 audit_logs;`cleanup(force)` 仅 admin 可触发。

## 6. Project Lock 设计(并发写互斥)

> 锁与 workspace 同属并发控制域,故并入本文档。

### 6.1 规则

- 锁 key:`lock:{project_id}:{branch}`(branch 为 **target_branch**;同 target 的不同 demand 写任务互斥,避免后续 PR 基线漂移与互相覆盖)
- analysis 模式不取锁;edit/build/deploy 必取
- 同 key 同时最多一把;取不到 → Run 保持 queued,UI 显示 `blocked by run #x (demand #y)`
- TTL 默认 15 分钟;持有方每 60s heartbeat 续期(`PEXPIRE`)
- worker crash → 停止心跳 → TTL 到期自动失效 → 队列中等待者获锁
- 支持 admin 手动 force release(写 audit;原持有 Run 若仍活着,其下一次心跳发现 token 不匹配 → 自我中止)
- 锁记录含 owner(run_id+worker_id)、reason(demand 标题)

### 6.2 Redis 实现(运行时真相)

```
获取:SET lock:{pid}:{branch} "{run_id}:{token}" NX PX 900000
心跳:Lua — GET 校验 token 一致才 PEXPIRE(防误续他人锁)
释放:Lua — GET 校验 token 一致才 DEL(防误删,经典 Redlock 单实例模式)
等待:获取失败 → BullMQ delayed retry(每 15s)直至成功或等待超时(30min → run failed: lock_timeout)
```

### 6.3 PostgreSQL 持久化(审计 + 恢复真相)

`project_locks` 表(见 03 §2.13):每次 acquire 插入 `held` 行,release/expire/force_release 更新终态。

- 部分唯一索引 `UNIQUE(project_id,branch) WHERE status='held'` 做数据库层兜底:即使 Redis 整体丢失(重启未持久化),也不会出现两行并存的 held
- Worker 启动自检:扫描本 worker_id 的 held 行,Redis 中无对应 key → 标 expired
- 每日对账 job:held 行 vs Redis key 双向核对,不一致告警

### 6.4 锁与 git 操作的关系

bare 仓库的 fetch/worktree add 操作另有 per-project 进程内互斥(轻量 mutex),与业务锁分离——业务锁管"谁能写这个分支",仓库锁管"git 元数据操作不并发"。
