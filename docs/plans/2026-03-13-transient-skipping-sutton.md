# IM 中间过程展示增强方案

## 目标

在飞书会话中补齐 Agent 的中间过程可见性，让用户能看到：

1. 思考中的占位状态
2. 文本的流式输出与打字机效果
3. 关键工具动作的即时提示
4. 运行期间始终可用的 `Interrupt` 按钮

本次实现优先级只覆盖飞书，不改 Discord/Slack。

## 结论

本次不要新增一张独立的 progress card，也不要在第一版引入 `tool-end` / `phase-change` 这类新的核心事件。

改为：

1. 复用当前 interrupt card 作为唯一运行中卡片
2. 运行开始后记录这张卡片的 `messageId`
3. 在同一张卡片上持续 `updateCard`
4. 中间过程正文采用“打字机式流式更新”
5. 卡片底部始终保留 `Interrupt` 按钮
6. 最终结果仍然额外发送一条文本消息，保持现有沉淀方式

这样能满足“有过程、能中断、像打字机一样滚动”的目标，同时避开当前 CLI 事件流没有稳定 `tool-end` 的问题。

## 为什么改成单卡方案

### 当前事实

1. 飞书已经有可用的 interrupt card 与 `updateCard()` 能力
2. `streamAgentToFeishu()` 当前只收集文本，结束后一次性发送
3. Claude/Codex 现有标准化事件里，`tool` 更接近“开始/执行中”而不是“执行完成”
4. `session-flow` 当前已经约定每次会话先发一张 interrupt card

### 原方案的问题

1. 单独新增 progress card 会和现有 interrupt card 重叠
2. 把 `tool` 重新解释成 `tool-end` 会污染现有消费者语义
3. 飞书卡片 payload 需要沿用当前 `schema: '2.0' + body.elements` 结构，不能另起一套

### 收敛后的方案优势

1. 与现有 session flow 兼容
2. 不依赖新的跨后端事件协议
3. 实现路径短，风险集中在飞书本地渲染层
4. 后续如果抓到了更完整的 CLI 原始事件，再增量扩展工具完成态也更自然

## 交互效果

### 运行开始

发送一张卡片，包含：

1. 用户原始输入摘要
2. `Thinking...`
3. 简短占位文案
4. `Interrupt` 按钮

### 运行中

同一张卡片持续更新：

1. 文本按块追加，形成打字机效果
2. 正文尾部显示光标，例如 `▍`
3. 如果收到关键工具事件，在正文中插入状态行

示例正文：

```text
Thinking...

用户想要更多的科技新闻。让我再抓取一些。▍
```

或：

```text
Thinking...

用户想要更多的科技新闻。让我再抓取一些。

⚙️ 准备搜索：今日科技新闻
```

### 完成时

1. 同一张卡片更新为完成态，去掉尾光标
2. 保留中间过程内容与 `Interrupt` 按钮区域的布局一致性
3. 继续发送最终文本消息，作为可复制、可搜索的最终结果输出

## 范围边界

### 本次实现包含

1. 飞书单卡流式更新
2. 打字机效果
3. `Thinking...` 占位态
4. 关键工具前置提示插入正文
5. 保留 interrupt 按钮
6. 完成态卡片收口

### 本次实现不包含

1. 新增 `tool-end`
2. 新增 `phase-change`
3. Discord/Slack 同步改造
4. 基于真实工具完成结果的成功/失败逐条标记

## 设计细节

### 1. 复用 interrupt card

文件：`packages/feishu/src/cards.ts`

新增一个运行中卡片构建函数，例如：

```typescript
buildFeishuStreamingRunCardPayload(context, state)
```

它需要：

1. 继续使用现有 schema v2 结构
2. 显示 prompt 摘要
3. 显示运行中正文
4. 底部保留 `Interrupt` 按钮

可复用现有 `button()` / `plainText()` 辅助函数，避免新造卡片协议。

### 2. interrupt card 返回 messageId

文件：`packages/feishu/src/presentation.ts`

当前 `presentFeishuInterruptCard()` 只返回：

```typescript
{ kind: 'emitted' | 'skipped' }
```

需要改成同时携带 `messageId`，便于 runtime 持续更新同一张卡片。

建议返回：

```typescript
type FeishuPresentationResult =
  | { kind: 'emitted'; messageId?: string }
  | { kind: 'skipped'; messageId?: string };
```

### 3. session flow 传递卡片 messageId

文件：`packages/feishu/src/session-flow.ts`

流程改为：

1. 先发运行卡片
2. 拿到卡片 `messageId`
3. 进入 `runFeishuConversation()`
4. 让 runtime 使用这张卡片做流式更新

### 4. runtime 负责流式刷新

文件：`packages/feishu/src/runtime.ts`

`streamAgentToFeishu()` 需要增加：

1. `cardMessageId`
2. `renderBuffer`
3. `displayBuffer`
4. 节流刷新间隔
5. 完成态 / 错误态卡片更新

### 5. 打字机效果策略

不做“每个字符一次 API 更新”，而是采用节流批量刷新。

建议策略：

1. 文本到来时写入 `renderBuffer`
2. 每 `400-800ms` 刷新一次卡片
3. 刷新时显示最新正文和尾光标 `▍`
4. `done/error` 时立即再刷一次，去掉光标

这样既有打字机观感，也能避免飞书 API 过于频繁更新。

### 6. 关键工具展示

仍然使用现有 `tool` 事件，不扩核心协议。

展示规则：

1. 仅对关键工具插入提示行
2. 非关键工具不额外展示
3. 工具提示作为正文的一部分流式追加

建议识别范围：

1. `Write`
2. `Edit`
3. `MultiEdit`
4. `Bash` 中的危险命令
5. `WebFetch`
6. `WebSearch`

建议提示文案：

1. `⚙️ 准备修改文件：README.md`
2. `⚠️ 准备执行命令：rm -rf temp/*`
3. `🌐 准备搜索：今日科技新闻`

## 实现清单

### 第一阶段：文档与卡片协议

1. 更新本方案文档，废弃独立 progress card 设计
2. 在 `packages/feishu/src/cards.ts` 新增运行中卡片 payload builder
3. 保证按钮仍沿用现有 `value` 对象结构

### 第二阶段：消息生命周期调整

1. 在 `packages/feishu/src/presentation.ts` 让 interrupt/streaming card 返回 `messageId`
2. 在 `packages/feishu/src/session-flow.ts` 把 `messageId` 传给 runtime

### 第三阶段：流式渲染

1. 在 `packages/feishu/src/runtime.ts` 为 `streamAgentToFeishu()` 增加卡片更新状态机
2. 支持 `Thinking...` 初始态
3. 支持 `text` 事件流式追加
4. 支持 `tool` 事件转为关键动作提示
5. 支持 `done/error` 立即收口

### 第四阶段：测试

1. 更新 `cards.test.ts`
2. 更新 `presentation.test.ts`
3. 更新 `session-flow.test.ts`
4. 在 `runtime.test.ts` 增加流式卡片更新测试

## 关键文件

| 文件 | 改动 |
| --- | --- |
| `docs/plans/2026-03-13-transient-skipping-sutton.md` | 收敛方案与实现清单 |
| `packages/feishu/src/cards.ts` | 新增单卡流式运行卡片构建函数 |
| `packages/feishu/src/presentation.ts` | 返回卡片 messageId |
| `packages/feishu/src/session-flow.ts` | 串联运行卡片与 runtime |
| `packages/feishu/src/runtime.ts` | 实现单卡流式更新与打字机效果 |
| `packages/feishu/src/__tests__/*.test.ts` | 更新与补充回归测试 |

## 风险与缓解

### 飞书更新频率限制

风险：
卡片更新过于频繁可能触发速率限制。

缓解：
使用节流刷新，不按字符逐次 PATCH。

### 卡片正文长度限制

风险：
长会话可能让卡片正文过长。

缓解：
正文只保留最近一段内容，必要时截断前部并保留最新上下文。

### 与现有最终输出重复

风险：
卡片里已经有完整正文，最终再发文本会显得重复。

缓解：
先保留双通道输出，优先保证兼容与稳定；后续再决定是否弱化最终文本。

## 验证场景

1. 普通问答：看到 `Thinking...`，随后卡片正文流式增长，最后收到最终文本
2. 关键搜索：卡片正文中插入 `🌐 准备搜索：...`
3. 文件修改：卡片正文中插入 `⚙️ 准备修改文件：...`
4. 危险命令：卡片正文中插入 `⚠️ 准备执行命令：...`
5. 错误场景：卡片收口并发送错误文本
6. 中断场景：运行期间按钮始终可见
