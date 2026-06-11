# 10 — CI/CD(Demand-driven 流水线)

## 0. 总链路

```
Demand → Agent Run → Workspace Diff → Review(人) → Commit → Push Branch
       → PR → CI(GitHub Actions) → Preview → [批准] Staging → [批准] Production
       → Audit Record / 回写 Demand
```

每一步都是独立 job(可单步触发、可中断),状态全部回写 Demand,使 Demand Detail 成为单一事实页面。

## 1. 分支创建

- 时机:Demand 的首个写 Run 准备 workspace 时(`git worktree add -B demand/{number}-{slug} origin/{target_branch}`)
- 命名:`demand/{number}-{title_slug}`(≤60 字符);回炉 Run 复用同分支
- 此时分支仅存在于本地 bare 仓库,push 前不污染 remote

## 2. Commit(Approve 后的系统动作,worker 执行)

```bash
cd {workspace}
git add -A
git -c user.name="AgentPlane Agent" -c user.email="agent@agentplane.local" commit \
  -m "feat(demand-42): 修复 iOS 登录按钮无响应

Demand: #42 | Run: r-002 | Approved-by: alice
Co-Authored-By: Alice <alice@example.com>"
```

- 前置校验:approvals 中存在该 run 的 accepted 记录(API 层 403 兜底)
- commit message 模板化,包含 demand/run/审批人 → git 历史即审计链
- 失败处理:冲突(target_branch 已前进且 worktree 落后)→ 先 `git fetch && git rebase origin/{target}`;rebase 冲突 → job failed,Demand 回 clarified 并附冲突说明,由新 Run 解决冲突(diff 重新走审)

## 3. Push

```bash
GIT_SSH_COMMAND="ssh -i /srv/agentplane/secrets/git/{project}.key -o IdentitiesOnly=yes" \
  git push origin demand/42-fix-ios-login
```

deploy key 仅此 job 进程可见(见 09 §5)。non-fast-forward → 同 §2 冲突流程。

## 4. 创建 PR(GitHub REST API)

```
POST /repos/{owner}/{repo}/pulls
{title: demand title, head: work_branch, base: target_branch,
 body: 模板(Demand 链接回 Portal、验收标准 checklist、Run 链接、diff stat)}
→ 回填 demands.linked_pr_url;为 PR 打 label `agentplane-agent`
```

凭据:GitHub App(推荐,细粒度 + 短期 token)或 PAT(MVP 可接受,repo 权限)。

## 5. 读取 GitHub Actions 状态

- **主通道 webhook**:GitHub App 订阅 `workflow_run` / `check_suite` / `pull_request` → `POST /webhooks/github`(验签)→ upsert ci_jobs → SSE 推前端 → CI success/failure 驱动 Demand building→preview/failed
- **兜底轮询**:webhook 5 分钟未达时按 external_id 轮询一次(公网不可达的内网部署场景则全靠轮询,30s 间隔)

## 6. Preview 生成

- MVP:服务器本机 `docker compose -p preview-d42 -f compose.preview.yml up -d --build`,模板化端口/子域(`d42.preview.example.com` 由 nginx 通配 + 容器 label 路由,或简化为端口号直出)
- 触发:CI 绿后自动(项目可配)或手动按钮;preview 部署也是 deployments 行(environment=preview,无需 approval)
- 生命周期:Demand done/rejected 或 7 天未访问 → `compose down -v` 回收;每项目并发 preview 上限 3
- 前提:目标项目提供 `compose.preview.yml`(项目接入清单的一项)

## 7. Staging 部署

- 前置:approval(kind=staging_deploy, accepted)
- MVP 实现:worker 执行项目预注册 `deploy_command`(模板),典型为 `docker compose -f compose.staging.yml up -d --build` 或 rsync+systemd restart
- 记录 deployments(environment=staging, commit_sha, approval_id, logs artifact)

## 8. Production 部署

- 前置:staging 已 succeeded + approval(kind=production_deploy;critical 双批)+ 部署窗口检查
- 实现同 staging(目标主机不同;远程主机经专用 SSH key,仅 deploy job 可见)
- 串行:同项目同环境一次一个 deploying(DB 部分唯一索引兜底)

## 9. Rollback

- `POST /deployments/:id/rollback`:找到该环境上一个 succeeded 的 deployment,按其 commit_sha 重新执行部署(镜像 tag=commit_sha 时秒级切换;源码部署则 checkout 该 sha 重发)
- 新建 deployments 行,`rollback_of` 指向被回滚版本;原行状态 → rolled_back
- 数据库 migration 不自动回滚(高危),rollback 时若区间含 migration → 强提示人工处理

## 10. 结果回写 Demand

| 事件 | 回写 |
|---|---|
| commit/push 完成 | demand_comments(system)+ work_branch 确认 |
| PR 创建 | linked_pr_url |
| CI 结束 | ci_jobs + status(building→preview/failed)+ 失败日志链接评论 |
| preview 起来 | deployments + preview URL 评论 + 通知 |
| staging/prod | linked_deployment_id + status=deployed |
| PR merged(webhook) | 建议 done,owner 一键确认 |

## 11. MVP vs 后续

| 能力 | MVP(Phase 2–4) | 后续 |
|---|---|---|
| Git 托管 | GitHub + PAT | GitHub App、GitLab 适配层 |
| CI | GitHub Actions(云 runner) | self-hosted runner(私有依赖/加速) |
| Preview | 本机 compose + 端口/子域 | 独立 preview 主机、K8s namespace per demand |
| 部署 | compose / 脚本模板 | 镜像仓库 + tag=sha、蓝绿/金丝雀 |
| 回滚 | 重部上一 sha | 镜像秒切 + 自动健康检查回滚 |
