# 07 — API 设计

## 0. 约定

- REST,前缀 `/api/v1`;JSON;鉴权:HttpOnly Secure Cookie session(SameSite=Lax)
- 长任务一律 `202 Accepted + {run_id|job_id}`,绝不同步执行(原则 #12)
- 错误体:`{"error": {"code": "LOCK_HELD", "message": "...", "details": {}}}`
- 列表统一 `?page&limit&sort`;写操作要求 `Idempotency-Key` 头(防手机弱网重复提交)
- 所有写操作落 audit_logs

## 1. Auth

```
POST /auth/login        {email, password} → 200 set-cookie / 401
POST /auth/logout       → 204
GET  /auth/me           → {id, email, display_name, is_superadmin, memberships:[{project_id, role}]}
```

## 2. Projects

```
GET   /projects                      → 我可见的项目列表(含最近活动摘要)
POST  /projects                      {slug, name, repo_url, default_branch} → 201;后台 job 克隆 bare 仓库
GET   /projects/:id                  → 详情 + 活跃 runs + 锁状态 + 最近 deployments
PATCH /projects/:id                  {name?, settings?, allow_dangerous_mode?, risk_level?}
GET   /projects/:id/locks            → 当前持锁列表
POST  /projects/:id/locks/:lockId/release   → admin 强制释放(audit)
```

## 3. Demands

```
GET   /demands?project_id&status&scheduled_date&label&q
POST  /demands                       → 201(最低 title+project_id,status=inbox)
GET   /demands/:id                   → 详情(含 comments、attachments、runs 摘要、ci、deployments)
PATCH /demands/:id                   → 字段更新 + 受控状态迁移(clarify/queue/cancel/done)
POST  /demands/:id/run               {agent_profile_id?, run_mode?, dangerous_mode?} → 202 {run_id}
POST  /demands/:id/cancel            → 取消排队/运行中 Run 并置 cancelled
POST  /demands/:id/attachments       multipart → 201 [{id, safe_filename, size}]
POST  /demands/:id/comments          {body} → 201
GET   /demands/stack?date=2026-06-12 → 当日 Stack(有序)
POST  /demands/stack/plan?date=...   → 触发当日自动规划(返回草案,PATCH 确认)
```

### 示例:创建并运行

```http
POST /api/v1/demands
{"project_id":"p-agentplane-portal","title":"修复 iOS 登录按钮","run_mode":"edit",
 "target_branch":"main","priority":1,
 "acceptance_criteria":"- [ ] iOS Safari 可登录\n- [ ] 桌面端不回归"}
→ 201 {"id":"d-42","number":42,"status":"inbox", ...}

POST /api/v1/demands/d-42/run
{"agent_profile_id":"ap-claude","run_mode":"edit"}
→ 202 {"run_id":"r-002","status":"queued","queue_position":1,
       "blocked_by":null}
→ 409 {"error":{"code":"DEMAND_NOT_READY","message":"demand 需先 clarified"}}
```

## 4. Runs

```
GET  /runs?project_id&demand_id&status
GET  /runs/:id                → 详情:steps timeline、workspace、lock、diff 摘要、artifacts
POST /runs/:id/stop           → 202(控制信道下发)
POST /runs/:id/retry          → 202 {new_run_id}(同 demand,attempt+1)
POST /runs/:id/input          {text} → 202(回答 waiting_user_input)
GET  /runs/:id/logs?after_seq=&stream=&q=   → 历史日志分页/搜索
GET  /runs/:id/logs/download  → 原始 .log(attachment)
GET  /runs/:id/events         → SSE 实时流(支持 Last-Event-ID 续传)
GET  /runs/:id/diff           → {summary, files:[{path,+,-}], patch?}(>1MB 给 artifact 下载链接)
GET  /runs/:id/artifacts      → 列表 + 受签名 URL 下载
POST /runs/:id/approve        {comment?} → 200;创建 approvals(accepted) + 入队 commit job
POST /runs/:id/reject         {comment}  → 200
POST /runs/:id/request-changes {comment} → 200;demand 回 clarified
```

### SSE 事件示例

```
GET /api/v1/runs/r-002/events
Accept: text/event-stream

id: 1041
event: agent.output
data: {"seq":1041,"stream":"stdout","content":"Running tests...","ts":"2026-06-12T03:21:05Z"}

id: 1042
event: diff.generated
data: {"files_changed":3,"insertions":58,"deletions":12}
```

## 5. CI/CD

```
POST /runs/:id/commit      {message?} → 202;前置:approvals 存在且 accepted(403 否则)
POST /runs/:id/push        → 202
POST /runs/:id/create-pr   {title?, body?} → 202;完成后 demand.linked_pr_url 回填
POST /runs/:id/build       → 202(ShellExecutor build 步骤,新 Run mode=build)
POST /runs/:id/deploy      {environment:"preview"|"staging"|"production"} → 202 {deployment_id}
                            前置:对应 approval kind 已 accepted;critical+production 需双批
GET  /ci-jobs?demand_id    → CI 状态列表
GET  /deployments?project_id&environment
POST /deployments/:id/rollback → 202(部署上一个 succeeded 版本,rollback_of 关联)
POST /webhooks/github      → Actions/PR 状态回写(验签 X-Hub-Signature-256)
```

> 便捷编排:`POST /runs/:id/approve?auto=ship` 一键串行 commit→push→PR(内部仍是逐 job,可中断)。

## 6. Settings

```
GET   /agent-profiles
POST  /agent-profiles        {slug, executor, binary_path, default_args, ...}(superadmin)
PATCH /agent-profiles/:id
GET   /audit-logs?actor&action&resource_type&from&to   (admin)
GET   /settings  /  PATCH /settings/:key               (superadmin)
```

## 7. 权限矩阵(摘要,详见 09)

| 端点类 | viewer | developer | reviewer | admin |
|---|---|---|---|---|
| GET 项目/需求/日志/diff | ✅ | ✅ | ✅ | ✅ |
| 创建/编辑 Demand、上传附件、run/stop/retry | | ✅ | ✅ | ✅ |
| approve/reject、commit/push/PR | | | ✅ | ✅ |
| deploy staging | | | ✅ | ✅ |
| deploy production、force release lock、项目设置 | | | | ✅ |

## 8. 实时事件 Schema(SSE / run_logs.stream='event')

统一信封:

```json
{
  "id": "evt-uuid",
  "run_id": "r-002",
  "seq": 1042,
  "type": "diff.generated",
  "ts": "2026-06-12T03:21:06.412Z",
  "payload": { }
}
```

| type | payload 关键字段 |
|---|---|
| run.created / run.queued | demand_id, attempt, queue_position |
| workspace.created | path, base_commit, work_branch |
| lock.acquired / lock.released | lock_key, holder_run_id, expires_at |
| agent.started | profile_slug, pid, dangerous_mode |
| agent.output | stream(stdout/stderr), content(已脱敏) |
| command.started / command.finished | step_seq, command(脱敏), exit_code, duration_ms |
| diff.generated | files_changed, insertions, deletions, is_empty |
| approval.requested | approval_id, kind |
| run.succeeded / run.failed / run.cancelled / run.timed_out | exit_code, error_message, duration_ms |

脱敏:发布前经正则集(`(api[_-]?key|token|secret|password)\s*[=:]\s*\S+`、AWS/GitHub token 模式、私钥块)替换为 `***REDACTED***`;原始未脱敏内容仅存 `/logs/{run_id}.log`(权限 0600,仅 admin 经审计接口下载)。
