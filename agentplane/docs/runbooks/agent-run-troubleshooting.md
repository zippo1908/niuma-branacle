# Runbook — Agent Run Troubleshooting(运行排障手册)

> 入口原则:先看 Portal 的 Run Detail(step timeline + error_message),再看原始日志,最后才 SSH。
> 通用命令:
> ```bash
> journalctl -u agentplane-worker -f                  # worker 实时日志
> less /srv/agentplane/logs/{run_id}.log          # 该 run 原始全量日志
> psql agentplane -c "select status,error_message from agent_runs where id='...'"
> redis-cli keys 'lock:*'                        # 当前活锁
> ```

## 症状 → 处置

### 1. Run 卡在 queued 不动
1. 看 Run Detail 是否显示 `blocked by`:是 → 正常排锁,等待或评估是否 force release(见 §6)
2. `systemctl status agentplane-worker`:挂了 → `systemctl restart agentplane-worker`(BullMQ 会重投)
3. `redis-cli LLEN bull:runs:wait`:队列堆积 → 检查并发上限设置;worker 日志找消费报错
4. Redis 本身:`redis-cli ping`

### 2. Run 卡在 preparing_workspace
- 多为 git 问题:`journalctl -u agentplane-worker | grep {run_id}` 找 fetch/worktree 报错
- bare 仓库损坏:`git -C /srv/agentplane/projects/{slug}.git fsck`
- worktree 残留:`git -C .../{slug}.git worktree list` → `worktree prune`
- deploy key 失效(GitHub 删除/过期):重配 key 后 retry

### 3. Agent 启动即失败 / exit 非 0 秒退
- `sudo -u agentplane-agent {binary} --version` 探活;CLI 自动升级后参数变化是常见原因 → 对照 agent_profiles.default_args 与 Spike A 报告修正 profile
- API key 失效/配额:日志中找 401/429 → 更新 agentplane-agent 的凭据文件
- pty 报错:检查 node-pty 与 Node 版本匹配(重装 native 依赖)

### 4. Run 进行中但日志停止滚动
- 区分两种:**Run 真停**(静默超时 10min 会自动 timed_out,等待即可)vs **SSE 断了**(前端黄条;刷新页面用 Last-Event-ID 续传)
- 若 DB 有新 run_logs 而前端没有:Caddy SSE 缓冲配置(`flush_interval -1`)被改动 → 恢复
- 若文件日志在涨而 DB 不涨:worker 落库批处理报错 → journalctl 查 insert 错误(多为日志超长行,截断策略)

### 5. timed_out 频发
- 任务太大:拆 Demand;或调高 demand 的 timeout(≤profile.max_timeout_seconds)
- agent 卡在等待确认:检查是否应启用预授权参数(profile)或 dangerous mode 评估
- 资源不足:`systemd-cgtop` 看 scope 是否顶到 MemoryMax → 调 ResourceLimitPolicy

### 6. 锁问题(疑似死锁 / 双锁)
```bash
redis-cli get "lock:{project_id}:{branch}"     # 运行时持有者 run_id:token
psql agentplane -c "select * from project_locks where status='held'"
```
- Redis 有、持有 run 已终态:心跳泄漏 → Portal force release(写审计),**不要**直接 redis-cli DEL(绕过审计)
- PG held 而 Redis 无:崩溃残留 → 对账 job 会标 expired;急用可在 Portal 标记
- 真双锁(理论不可能,PG 部分唯一索引兜底):立即停 worker,导出两表状态,按 ADR 流程分析

### 7. Worker crash / 服务器重启后恢复
1. `systemctl status agentplane-worker` 确认拉起(Restart=always)
2. BullMQ stalled job 自动重投;新 worker 对中断 run 的策略:旧 workspace 标 dirty,**全新 workspace 重跑**
3. 核对锁:见 §6 对账
4. 孤儿 worktree:次日 gc 自动清;手动 `infra/scripts/gc.sh`

### 8. diff 为空但 agent 声称改了
- 进 workspace `git status`:真没改(agent 幻觉)→ Request Changes 注明;有改但在忽略路径 → 检查 .gitignore
- agent 自己 commit 了:确认 collect 逻辑用 `git diff {base_commit}..HEAD` 路径(见 05 §3)

### 9. commit/push/PR 失败
- rebase 冲突:Demand 已回 clarified 并附冲突文件清单 → 发起新 Run 解冲突(prompt 自动带入)
- push 被拒(权限):deploy key 是否勾选 write;GitHub IP 限制
- PR 创建 422:同名 PR 已存在(回炉场景)→ 系统应复用既有 PR,若未复用为 bug

### 10. CI 状态不回写
- `psql`:webhooks 接收日志(audit)有无该 delivery;GitHub 仓库 Settings→Webhooks 看 delivery 失败原因(验签 401:secret 不一致)
- 内网部署:确认轮询模式已开(system_settings.ci_poll_enabled)

### 11. preview 起不来
- `docker compose -p preview-d{n} logs`;端口冲突 → 检查端口分配器状态;磁盘 >85% 拒绝新 preview(设计行为)→ 清理

### 12. 疑似 secrets 泄漏到日志/diff
1. 立即:Portal 下架相关 artifact 访问;轮换涉事凭据(模型 key / deploy key / 生产凭据)
2. 原始日志文件仅 admin 可达,确认访问审计
3. 修补脱敏正则(system_settings),回扫近 7 天 run_logs
4. 事后:写 incident 记录入 docs/runbooks/incidents/

## 升级路径

L1(Portal 自助:retry/stop/force release)→ L2(SSH + 本手册)→ L3(停 worker、保全现场:导出 run 记录+日志+workspace tar,提 issue 走 ADR/incident)。
