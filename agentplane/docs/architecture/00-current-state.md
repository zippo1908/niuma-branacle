# 00 — Current State Audit(当前状态审计)

> 状态:**无法执行仓库审计** — 本轮设计在没有访问任何现有代码仓库的环境中完成。
> 日期:2026-06-12

## 1. 审计结论(如实声明)

本次会话中没有提供任何代码仓库(无上传文件、无远程仓库访问权限)。因此:

- ❌ 无法判断当前技术栈
- ❌ 无法说明当前目录结构
- ❌ 无法确认是否已有 frontend / backend / worker / db / docker 模块
- ❌ 无法评估可复用部分与项目成熟度

**本文档不做任何猜测性结论。** 以下所有架构文档(01–12)按 **greenfield(全新项目)** 假设编写;一旦提供真实仓库,需用本文件第 3 节的清单重新执行审计,并据此修订 01–12 中的"复用 vs 新建"决策。

## 2. 已知事实(来自需求方描述,未经代码验证)

| 事实 | 来源 | 验证状态 |
|---|---|---|
| 开发服务器为 Rocky Linux | 用户描述 | 未验证 |
| 通过 iPhone SSH 操作 | 用户描述 | 未验证 |
| 服务器上已可运行 Codex CLI / Claude Code | 用户描述 | 未验证 |
| 目标部署根目录倾向 `/srv/agentplane/` | 用户描述 | 设计采纳 |
| 当前无 tmux 持久化、无任务管理 | 用户描述(痛点 1) | 未验证 |

## 3. 下次审计所需输入(Checklist)

执行真实审计时,在仓库根目录运行并提供以下输出:

```bash
# 结构
git ls-files | head -200
tree -L 3 -I 'node_modules|.git|__pycache__|dist|build'

# 技术栈信号
cat package.json pyproject.toml requirements.txt go.mod Cargo.toml 2>/dev/null
ls docker-compose*.yml Dockerfile* .github/workflows/ 2>/dev/null

# 运行时信号
systemctl list-units --type=service | grep -iE 'agentplane|portal|worker|api'
ls /srv/agentplane/ 2>/dev/null

# 数据库信号
ls **/migrations/ **/alembic/ **/prisma/ 2>/dev/null
```

审计输出模板(待填):

1. 当前技术栈判断 → 待审计
2. 当前目录结构说明 → 待审计
3. 已有 frontend/backend/worker/db/docker 模块 → 待审计
4. 可复用部分 → 待审计
5. 建议新增部分 → 待审计
6. 项目成熟度判断 → 待审计
7. 风险点 → 待审计

## 4. Greenfield 基线假设

后续文档基于以下假设;任何一条与现实不符,需在 ADR 中记录偏差:

- A1: 单台 Rocky Linux 9.x 服务器,≥4 vCPU / 16GB RAM / 200GB SSD
- A2: 服务器可出网访问 GitHub、npm/PyPI、Anthropic/OpenAI API
- A3: 被开发的目标项目托管在 GitHub,使用 git
- A4: MVP 阶段单用户,但数据模型从第一天支持多用户
- A5: Codex CLI 与 Claude Code 均以非交互(headless / `-p` / `--print`)模式可驱动
- A6: 服务器上可安装 Docker(用于 sandbox 与 preview),但 MVP 不强制

## 5. 风险登记(在无审计前提下)

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 真实仓库可能已有与本设计冲突的结构 | 返工 | 实施前先完成第 3 节审计 |
| R2 | Codex/Claude CLI 的 headless 能力与假设不符 | Agent Runner 重设计 | Phase 0 先做 CLI spike 验证 |
| R3 | 服务器资源不足以支撑 worker pool + preview | 性能 | Phase 0 基线压测 |
