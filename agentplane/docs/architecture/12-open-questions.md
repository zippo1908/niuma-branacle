# 12 — Open Questions(待确认的开放问题)

> 每条问题给出"若不回答的默认决策",保证项目不被阻塞;确认后写 ADR。

| # | 问题 | 影响范围 | 默认决策 |
|---|---|---|---|
| Q1 | **现有仓库在哪里?** 是否已有代码需要复用/迁移? | 00 审计、全部"复用 vs 新建"判断 | 按 greenfield 全新建 |
| Q2 | 服务器规格(CPU/RAM/磁盘)与是否有公网 IP/域名? | 并发上限、preview 方案、TLS、webhook 模式 | 4C16G;无公网则 Tailscale + CI 轮询模式 |
| Q3 | Codex CLI 与 Claude Code 当前版本的确切 headless 参数与 stream 格式?(Phase 0 Spike A 回答) | 04 Executor 实现 | 以 spike 实测为准,profile 中配置化 |
| Q4 | Portal 是否暴露公网?还是仅 Tailscale/VPN 内网? | 09 安全强度(2FA、限流)、10 webhook | 内网优先;公网则 Phase 5 前加 2FA |
| Q5 | 被开发的目标项目有几个?是否都在 GitHub?有无私有依赖? | 10 CI 凭据、self-hosted runner 需求 | 1–3 个,GitHub,无私有 registry |
| Q6 | preview 的形态要求:子域名(`d42.preview.x.com`,需泛解析+证书)还是端口号即可? | 10 §6、Caddy 配置 | MVP 端口号直出 |
| Q7 | 模型 API 成本预算/月?是否需要 per-demand token 预算与熔断? | agent_runs.token_usage 的用途深度 | 仅统计展示,不熔断 |
| Q8 | 多用户时间表:Phase 5 是真实需求还是远期?(影响是否提前做 2FA/邀请) | 路线图排序 | 按本路线图,Phase 5 在 CI/CD 之后 |
| Q9 | 数据库与 uploads 的备份目标(RPO/RTO)?备份到哪(对象存储/另一台机)? | runbook 备份方案 | 每日 pg_dump + uploads rsync 到第二磁盘,RPO 24h |
| Q10 | 开源项目最终命名(本套文档使用占位名 **AgentPlane/agentplane**,需做 GitHub/npm/域名/商标可用性检查后全局替换,一条 sed 即可) | 全局命名、品牌 | 暂用 agentplane |
| Q11 | 是否需要 waiting_user_input 的完整交互(agent 中途提问)?MVP 可否用"预授权+失败重提"替代? | 04 §6、控制信道复杂度 | MVP 用预授权策略,完整交互 Phase 3 |
| Q12 | 生产环境部署目标是同一台服务器还是独立主机? | 09 §12、10 §8 凭据与隔离 | 假设独立主机,经 SSH 部署 |
