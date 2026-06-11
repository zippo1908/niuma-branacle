# Open-Source Readiness(开源化就绪清单)

> 本文档记录从"个人开发服务器设计"到"GitHub 开源项目"的全部改造决策与待办。

## 1. 已完成的脱敏(本轮)

- ✅ 项目名全局替换为占位名 **AgentPlane / agentplane**(原私有代号已清除;最终命名见 §3)
- ✅ 个人身份信息清除:示例用户改为 `alice`,决策者改为 maintainer,无真实邮箱/域名/IP
- ✅ 示例域名统一 `example.com`;无任何真实服务器信息、密钥、路径指纹
- ✅ 残留扫描通过(grep 全文无原私有标识)

## 2. 设计层面为开源所做/所需的调整

| 项 | 状态 | 说明 |
|---|---|---|
| 路径配置化 | 设计已定 | `/srv/agentplane` 仅为默认值,统一由 `AGENTPLANE_DATA_DIR` 环境变量控制;实现时禁止硬编码(runbook/05 文档中的路径均按默认值书写) |
| 数据库/Redis 连接 | 设计已定 | `DATABASE_URL` / `REDIS_URL`,提供 `.env.example`,真实 `.env` 进 `.gitignore` |
| 发行版中立 | 待办 | runbook 以 Rocky Linux 9 为参考实现,需补 Debian/Ubuntu 段落 + 通用 docker-compose 一键体验路径(降低试用门槛是开源项目的生死线) |
| 单 org 假设 | 不变 | 自托管场景合理;SaaS 多租户明确为 non-goal(写入 README) |
| Telemetry | 决策 | **默认零遥测、零外呼**(除用户自己配置的模型 API 与 GitHub)。如未来加匿名统计,必须 opt-in + 文档披露 |
| Agent CLI 版本漂移 | 设计已定 | agent_profiles 配置化 + 社区 spike 报告机制(CONTRIBUTING)替代"作者本机实测" |

## 3. 命名与品牌(发布前必办)

1. 候选名做四项检查:GitHub org/repo、npm scope、域名、商标粗查(USPTO/EUIPO 检索)
2. 避免使用 "Claude"/"Codex"/"GPT" 等第三方商标作为项目名成分;README 中提及它们时仅作兼容性陈述
3. 定名后一条命令全局替换:`git grep -l -i agentplane | xargs sed -i 's/agentplane/<newname>/g; s/AgentPlane/<NewName>/g'`

## 4. 许可证选择(发布前必办,建议写成 ADR-0002)

| 选项 | 适合 | 代价 |
|---|---|---|
| **Apache-2.0(推荐)** | 最大化采用与贡献;含专利授权条款 | 云厂商可闭源托管(对本项目威胁低:自托管工具的护城河在社区与迭代速度) |
| MIT | 同上,更简 | 无专利条款 |
| AGPL-3.0 | 防止被改造成闭源 SaaS | 显著抑制企业采用与贡献;对"自托管开发工具"通常得不偿失 |
| BSL/FSL 类源可用协议 | 计划商业化托管版 | 不是 OSI 开源;社区观感复杂 |

默认建议:**Apache-2.0**。若你明确计划做托管商业版,再评估 AGPL/FSL,并在第一个 release 前定死(事后改协议极其痛苦)。

## 5. 仓库基建(首次 public 前清单)

- [ ] LICENSE(§4 决策后)
- [x] README.md(英文,定位+差异化+状态声明)
- [x] CONTRIBUTING.md / SECURITY.md
- [ ] CODE_OF_CONDUCT.md(Contributor Covenant 2.1 直接采用)
- [ ] Issue/PR 模板(bug / design-review / spike-report 三类)
- [ ] `.github/workflows/ci.yml`:lint + typecheck + test + **secret 扫描(gitleaks)** + markdown link check
- [ ] `.env.example`、`.gitignore`(env、secrets、`/srv` 痕迹)
- [ ] 分支保护:main 必须 PR + CI 绿
- [ ] **首次 push 前**:确认是全新 git 历史(`git init` 重新开始),绝不携带私有历史记录——历史里的一次泄漏 force-push 也救不回来
- [ ] GitHub repo 设置:Security Advisories 开启、Discussions 开启(设计评审主场)

## 6. 文档语言策略

- 现状:架构文档为中文,README 英文
- 策略:英文为开源主语言。优先翻译顺序:README(✅)→ 02 架构 → 11 路线图 → 04/05/09(贡献者最需要)→ 其余;中文版保留在 `docs/zh/`
- 不追求同步双语,以英文为 source of truth(社区贡献者基数决定)

## 7. 定位与差异化(README 已落地,此处存论据)

赛道现状(2026-06 调研):已存在大量开源 agent 会话 UI 与并行 worktree 运行器(桌面应用、移动远程控制、kanban 式编排等)。AgentPlane 不与它们在"会话体验"层竞争,差异化锚点:

1. **Demand Stack**:结构化、agent-ready 的需求资产 + 每日规划,而非临时会话
2. **强制审批门禁**:自动化上限是 waiting_review,无免审写路径——面向"敢长期开着"的信任模型
3. **并发写锁 + 多用户 RBAC + append-only 审计**:面向团队而非单人
4. **demand-driven CI/CD 全链路**:直到 preview/staging/production 与回滚,而非止步于 diff

风险:赛道迭代极快,发布节奏比设计完美更重要——按 roadmap Phase 1 尽早出可跑的 demo(含 60 秒 GIF),这是开源项目获得第一批 star 的唯一硬通货。

## 8. 维护者预期管理

- README 顶部明确 "design phase" 状态徽章,避免"装着能用结果跑不起来"的差评
- 发布节奏建议:Phase 1 完成即 `v0.1.0-alpha` + Show HN / r/selfhosted / 中文社区双线发布
- 设定边界:single-maintainer 项目,response SLA 写"best effort";用 Discussions 分流 issue 噪音
