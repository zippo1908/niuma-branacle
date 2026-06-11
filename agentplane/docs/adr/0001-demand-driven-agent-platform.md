# ADR-0001: Demand-driven Agent Platform(需求驱动的 Agent 开发平台)

- 状态:**Proposed**(待 Q1–Q12 确认后转 Accepted)
- 日期:2026-06-12
- 决策者:项目维护者(maintainer)

## 背景

当前工作流为 iPhone → SSH → 服务器上手动运行 Codex CLI / Claude Code。痛点:会话脆弱(断线即断任务)、移动端交互差、附件无法直达 agent、无并发控制、无审计、无 CI/CD 编排。需要将"AI 改代码"工程化为可控、可审、可扩展的平台。

## 决策

构建 **AI-native development control plane**,核心决策:

1. **资产中心化而非 Agent 中心化**:Demand / Run / Workspace / Diff / Approval / Deployment 为持久化一等公民(PostgreSQL);CLI Agent 降级为 Worker 内可替换 executor(AgentExecutor 接口)。
2. **执行与会话解耦**:Web API 永不执行长任务;Redis+BullMQ 队列 + systemd 管理的 Worker 池承载一切执行,浏览器/SSH 仅为观察与控制端。
3. **隔离与互斥**:bare mirror + git worktree per run 实现物理隔离;`lock:{project_id}:{branch}`(Redis 运行时 + PG 持久化兜底)实现写互斥;analysis 免锁,跨项目/分支自由并发。
4. **Review 为不可绕过的门禁**:任何 commit/push/deploy 必须有 accepted approval;自动化上限是 waiting_review;production 高危双批。
5. **凭据三域隔离**:Agent 域(仅模型 key)/ Git 域(deploy key 仅 git job)/ Deploy 域(生产凭据仅 deploy job),agent 永不接触生产 secrets。
6. **技术栈**:Next.js + NestJS + Drizzle + PostgreSQL 16 + Redis/BullMQ + Node worker(node-pty)+ GitHub Actions + Docker Compose preview;全 TypeScript 以共享状态机与类型(packages/shared 单一事实源)。

## 备选方案与否决理由

- **tmux + 脚本增强现状**:解决断线但不解决并发/审计/审核/移动端,天花板太低 → 否决。
- **直接用现成 CI 平台(Jenkins/GitLab)改造**:Demand/Agent Run/Diff Review 语义无法自然映射,定制成本高于自建薄层 → 否决。
- **Python(FastAPI+Celery)后端**:能力等价,但前后端/Worker 类型与状态机定义割裂 → 否决。
- **每 Run 全量 clone / 直接在项目目录跑**:前者慢且费盘,后者无隔离 → 否决,取 worktree。
- **MVP 即上 Kubernetes**:单机场景过度工程 → 否决,compose 起步。

## 后果

- ✅ 断线免疫、移动端可用、全链路审计、可并发、agent 可替换
- ⚠️ 引入 PG/Redis/队列的运维面(以 runbook 与 systemd 简化)
- ⚠️ headless CLI 行为成为外部依赖,版本升级可能破坏 Executor(以 profile 配置化 + spike/冒烟测试缓解)
- ⚠️ 人审是吞吐瓶颈——这是有意为之的安全设计,非缺陷

## 关联

- 全套设计:docs/architecture/00–12
- 待确认:docs/architecture/12-open-questions.md
