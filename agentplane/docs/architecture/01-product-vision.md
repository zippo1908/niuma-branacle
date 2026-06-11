# 01 — Product Vision(产品愿景)

## 1. 一句话定义

**AgentPlane 是一个 AI-native development control plane**:用户通过 Web Portal 提交 Demand(需求),系统调度 AI Agent(Codex / Claude Code / 未来其他)在隔离 Workspace 中读代码、改代码、跑测试、生成 diff,经人工审核后走完整 CI/CD 链路(commit → PR → CI → preview → deploy),全程可追踪、可审计、可回滚。

它**不是**聊天机器人,**不是** IDE 插件,**不是** SSH 替代品。它是把"AI 改代码"这件事工程化、产品化、流程化的控制平面。

## 2. 解决的核心痛点

| # | 痛点 | 解法 |
|---|---|---|
| 1 | SSH 断线导致前台任务中断 | 任务跑在 server-side Worker 中,与浏览器会话完全解耦;断线重连后从 DB/日志恢复视图 |
| 2 | iPhone 上 CLI 交互极差 | Web Portal 提供移动端友好的表单、日志流、diff 审核、一键操作 |
| 3 | 手机截图/附件无法直达 Agent | Portal 上传 → Attachment Manager 落盘 → 自动复制/挂载到 Run Workspace,prompt 中注入路径 |
| 4 | 多用户并发互踩 | per-run 隔离 Workspace(git worktree)+ Project Lock(project+branch 写互斥) |
| 5 | 缺少统一远程开发控制面 | Portal + API + Queue + Worker 全栈控制平面 |
| 6 | 缺少 demand-driven CI/CD | Demand Stack:每日需求栈 → 自动拆分 → Agent 执行 → 审核 → CI/CD |

## 3. 核心资产(First-class Citizens)

系统的核心**不是 CLI Agent**,而是以下持久化资产:

1. **Demand** — 一条结构化需求,带验收标准、附件、风险等级
2. **Agent Run** — 一次 Agent 执行,带完整日志、步骤、产物
3. **Workspace** — 一次 Run 的隔离工作区(git worktree)
4. **Diff** — Run 产出的代码变更,审核对象
5. **Approval** — 人工审批记录,门禁
6. **Deployment** — 部署记录,可回滚

CLI Agent 只是 Worker 中可替换的 executor。今天是 Codex/Claude,明天可以是任何 agent,核心资产与流程不变。

## 4. 用户画像与场景

- **P0:单人开发者(solo maintainer)** — iPhone/iPad/Mac 上提需求、看日志、审 diff、点部署。
- **P1:小团队** — 多成员各自提 Demand,RBAC 控制谁能 deploy production。
- **P2:未来** — 半自动模式:低风险 Demand 自动执行至 waiting_review,人只做审批。

典型日常流:

```
早晨:查看 Daily Demand Stack(系统按优先级排好)
  → 选 3 条放入今日队列
白天:Agent 逐条执行,手机上看实时日志
  → 收到 "waiting_review" 通知 → 审 diff → Accept
  → 触发 commit + PR + CI → preview 链接验收
晚上:批准 staging → production 部署,查看 audit log
```

## 5. 非目标(Non-goals)

- ❌ 不做通用 SaaS 多租户平台(MVP 单实例自托管)
- ❌ 不做在线 IDE(diff 审核 ≠ 在线编辑器;Monaco 只读为主)
- ❌ 不替代 GitHub(PR/CI 仍在 GitHub,系统是编排者)
- ❌ 不做 Agent 自研(只做 executor 适配层)
- ❌ MVP 不做 Kubernetes(Docker Compose 足够)

## 6. 成功标准

- 从 iPhone 提交一条 Demand 到看到可审核 diff,全程无需 SSH
- SSH/浏览器断线对运行中任务零影响
- 任意一次代码变更可回答:谁提的需求、哪个 Agent 改的、谁批的、何时部署的、怎么回滚
- 同一 project+branch 永远不会出现两个写任务并发
