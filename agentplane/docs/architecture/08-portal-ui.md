# 08 — Portal UI 设计

## 1. 设计基调

- **Mobile-first**:iPhone Safari 是第一公民(PWA,可加到主屏);桌面是增强
- 实时性:SSE 驱动的状态徽章与日志流;离开页面再回来无缝续传
- 危险操作(deploy/force release)全部二次确认 + 显示风险等级色条(low 绿 / medium 黄 / high 橙 / critical 红)

## 2. 信息架构与导航

```
底部 Tab(移动)/ 侧边栏(桌面):
  ① Stack(今日需求栈,默认首页) ② Projects ③ Runs ④ 通知 ⑤ 设置
全局:顶部项目切换器 + 全局搜索(demand/run/日志)
通知中心:waiting_review / run failed / CI 结果 / 等锁提示(Web Push 可选)
```

## 3. 页面清单

> 数据来源均为 07 文档对应 API;此处标注关键点。

### 3.1 Dashboard `/`
- 组件:今日 Stack 卡片列、活跃 Run 实时状态条、待我审核列表、最近部署
- 操作:进入各详情、一键审核入口
- 权限:登录即可(按成员关系过滤)
- 空态:"今天还没有 Demand → 创建 / 生成今日 Stack";错误态:API 不可达 → 离线横幅 + 重试

### 3.2 Projects `/projects`
- 列表卡片:名称、repo、默认分支、活跃 run 数、锁状态点
- 操作:创建项目(admin)、进入详情
- 空态:引导接入第一个仓库(repo_url + deploy key 指引)

### 3.3 Project Detail `/projects/:id`
- Tabs:Overview(活动流) / Demands / Runs / Locks / Deployments / Settings
- Locks tab:持锁人、reason、心跳时间,admin 可 force release(二次确认)
- 权限:Settings 仅 admin;错误态:bare 仓库克隆失败 → 显示后台 job 错误与重试按钮

### 3.4 Demand Stack `/stack?date=`
- 组件:日期切换、有序卡片列(可拖拽排序写回 stack_order)、"生成今日计划"按钮(展示评分依据)、backlog 折叠区
- 状态展示:每卡片状态徽章 + 阻塞提示(被哪把锁挡住)
- 空态:无计划 → CTA 生成;错误态:规划 job 失败原因展示

### 3.5 Demand Detail `/demands/:id`
- 组件:状态时间线(状态机可视化)、描述/验收标准(Markdown)、附件栏、context files、评论流、关联 Runs 表、PR/CI/Deployment 卡片
- 操作:Clarify 表单、Run(选 agent/mode/dangerous——后者仅在项目允许且 risk≤medium 时可见)、Cancel、拆分子需求
- 权限:developer 起可操作;错误态:状态迁移 409 → toast 解释合法迁移

### 3.6 Create Demand `/demands/new`(移动端为全屏 sheet)
- 极简两段式:第一屏 title + project + 附件(相机/相册直传);第二屏可选展开(验收标准、分支、优先级、agent、mode、risk)
- 草稿自动保存(弱网)

### 3.7 Upload Attachments(组件,嵌入 3.5/3.6)
- 多选、进度条、失败重传;客户端压缩大图(可选);展示 sanitize 后文件名
- 错误态:超 50MB / MIME 不允许 → 即时提示

### 3.8 Agent Runs `/runs`
- 过滤器:项目/状态/agent;实时状态徽章;行内 stop/retry
- 空态:还没有 Run → 引导从 Demand 发起

### 3.9 Run Detail `/runs/:id`
- 组件:**Step Timeline**(run_steps)、元信息(agent、mode、workspace、lock)、prompt 折叠查看、Live Logs 嵌入、Diff 摘要卡、Artifacts 列表、token/耗时统计
- 操作:Stop、Retry、回答 waiting_user_input(输入卡片)、跳转审核
- 错误态:failed → 醒目展示 error_message + 失败 step 定位

### 3.10 Live Logs(组件 + 全屏 `/runs/:id/logs`)
- xterm.js 或虚拟滚动日志视图;自动跟随/暂停;stderr 高亮;搜索;下载原始日志
- SSE 断线:黄条"重连中",Last-Event-ID 续传不丢行
- 移动端:字号适配、横屏建议

### 3.11 Diff Review `/runs/:id/review`
- 组件:文件树(±统计)、逐文件 diff(Monaco diff 只读,移动端切 unified 单栏)、测试/构建结果卡、审核操作区(Accept / Request Changes / Reject + 必填意见)
- Accept 后展示"下一步"编排卡:commit → push → PR(可一键 ship)
- 权限:reviewer 起;owner==reviewer 且 risk≥high 时禁用 Accept 并提示换人
- 空 diff:明确展示"Agent 未产生变更" + agent 总结输出

### 3.12 CI Jobs `/projects/:id/ci`
- Actions 运行列表(状态、耗时、外链)、与 demand 关联;失败 job 的日志外链
- 错误态:webhook 未配置 → 配置指引

### 3.13 Deployments `/projects/:id/deployments`
- 各环境当前版本卡(commit、时间、操作人)、历史表、**Rollback 按钮**(admin,二次确认输入项目名)
- preview 环境:链接 + 到期时间

### 3.14 Settings `/settings`
- 个人资料、通知偏好;项目设置(test/build/deploy 命令模板、preview 配置、dangerous 开关)——admin
- 系统设置(并发、retention、白名单)——superadmin

### 3.15 Agent Profiles `/settings/agents`
- 列表 + 编辑(binary、args、env allowlist、允许模式、超时上限);健康检查按钮(`--version` 探活)
- 权限:superadmin

### 3.16 Audit Logs `/audit`
- 过滤(actor/action/resource/时间);只读表;导出 CSV
- 权限:admin;敏感 payload 已脱敏标注

## 4. 全局状态与错误规范

- 状态徽章色板统一映射 demand_status / run_status 枚举(单一来源 `packages/shared`)
- 错误三层:字段级(表单)、操作级(toast + error.code 文案表)、页面级(空态/重试)
- 所有轮询禁止;状态更新一律 SSE 推 + 焦点回归时一次校准拉取
