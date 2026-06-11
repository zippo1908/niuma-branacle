# 06 — Demand Stack 设计

## 1. 定位

Demand Stack 不是 Todo List,而是 **agent-native backlog**:每条 Demand 携带足够让 Agent 直接开工的结构化上下文(验收标准、附件、context files、运行模式、风险等级),并且自身就是状态机,驱动从想法到部署的全链路。

## 2. Demand 字段(完整,对应 03 §2.5)

title · description · project · target_branch · priority(1–5) · labels · attachments · acceptance_criteria · context_files · target_agent · run_mode · risk_level · status · owner · reviewer · linked runs · linked PR · linked deployment · scheduled_date · stack_order · retry_count

## 3. 七个流程

### 3.1 创建(→ inbox)
最低门槛:title + project。允许"一句话+一张截图"快速进 inbox(手机场景核心诉求),结构化字段后补。

### 3.2 澄清(inbox → clarified)
clarified 的准入校验(API 强制):
- acceptance_criteria 非空(至少 1 条可验证条目)
- target_branch、run_mode、risk_level 已确认
- risk ≥ high ⇒ reviewer 已指定且 ≠ owner

可选辅助:`POST /demands/:id/clarify-assist` 触发一次 analysis Run,Agent 读仓库后回写建议的验收标准/context_files/拆分建议到 demand_comments,**仅建议,人确认才生效**。

### 3.3 拆分
过大 Demand(预估改动 >10 文件或验收标准 >5 条)→ 拆为子 Demand(`parent_demand_id` 关联);父 Demand 转为 tracking 状态(不直接产生 Run),全部子 done 后父 done。

### 3.4 排队(clarified → queued)
进入某日 Stack:设置 scheduled_date + stack_order。手动拖拽或采纳每日自动规划(§4)。

### 3.5 执行(queued → running)
到序后创建 Agent Run(见 04)。串行约束由 Project Lock 天然保证;Stack 调度器只控制"今天先做谁"。

### 3.6 审核(running → waiting_review → …)
- Accept → accepted → 自动入队 commit/push/PR job → building
- Reject → rejected(终态,workspace 留 7 天)
- Request Changes → 回 clarified,审核意见(review_feedback 评论)自动注入下一 Run prompt

### 3.7 完成(building → preview → deployed → done)
CI 绿 + preview 验收 + 部署后,owner 点 done(或 PR merge webhook 自动建议 done)。done 时回写:最终 commit、PR、deployment 链接,形成闭环档案。

## 4. 每日 Demand Stack 生成逻辑

每天 06:00(cron job)生成当日 Stack 草案,**人工确认后生效**(MVP 不自动开跑):

```
候选集 = status ∈ {clarified, queued, failed(retry_count<上限)}
       + scheduled_date ≤ 今天 或为空

评分 score =
    (6 - priority) * 100            # 优先级主导
  + age_days * 5                    # 防饿死
  + (risk=low ? 20 : 0)             # 低风险优先消化
  + (has_blocking_label ? 500 : 0)  # blocker 置顶
  - (failed_yesterday ? 50 : 0)     # 连败降权,避免循环烧钱

排序 → 取容量上限(默认 5 条/天,system_settings 可调)
   → 写 scheduled_date=今天 + stack_order
   → 同 project+branch 的写任务相邻排列(减少锁等待)
剩余候选 → 留在 backlog 视图
```

### 失败重试逻辑
- 基础设施类失败(workspace/网络/worker crash):自动重试 1 次(同日)
- Agent 输出类失败(测试不过、构建失败):**不自动重试**,Demand → failed,次日 Stack 重新入榜(retry_count+1,≥3 次自动降级 priority 并打 `needs-human` 标签)

## 5. 示例 Demand JSON

```json
{
  "id": "d3b9f9e2-4c1a-4f6e-9b7a-1c2d3e4f5a6b",
  "project_id": "p-agentplane-portal",
  "number": 42,
  "title": "修复 iPhone Safari 上登录按钮点击无响应",
  "description": "如截图所示,iOS 17 Safari 中点击登录按钮无任何反馈。怀疑是 touch event 被遮罩层拦截。",
  "acceptance_criteria": "- [ ] iPhone Safari(iOS 17+)可正常登录\n- [ ] 不回归桌面 Chrome/Firefox\n- [ ] 新增/更新对应的 Playwright 用例并通过",
  "context_files": ["apps/portal/src/app/login/page.tsx", "apps/portal/src/components/AuthForm.tsx"],
  "target_branch": "main",
  "work_branch": "demand/42-fix-ios-login",
  "priority": 1,
  "labels": ["bug", "mobile", "blocker"],
  "attachments": [
    {"id": "a-1", "original_filename": "IMG_2031.png", "mime_type": "image/png", "size_bytes": 1248576}
  ],
  "target_agent_profile": "claude-code",
  "run_mode": "edit",
  "risk_level": "medium",
  "status": "waiting_review",
  "owner_id": "u-alice",
  "reviewer_id": "u-alice",
  "linked_runs": ["r-001(failed)", "r-002(waiting_review)"],
  "linked_pr_url": null,
  "linked_deployment_id": null,
  "scheduled_date": "2026-06-12",
  "stack_order": 1,
  "retry_count": 1
}
```
