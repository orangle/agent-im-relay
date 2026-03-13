# 飞书新增命令实现计划

## Context

用户需要为飞书添加三个新命令来增强会话管理能力：

1. **`/help`** - 提供命令帮助和快捷操作入口
2. **`/status`** - 查看当前会话的详细状态信息
3. **`/resume <session>`** - 关闭当前会话并恢复指定的会话

这些命令将帮助用户更好地管理和控制飞书中的 agent 会话，特别是在需要查看会话状态或切换会话时。

## 实现方案

### 1. 命令检测函数（runtime.ts）

在 `packages/feishu/src/runtime.ts` 的 `isFeishuDoneCommand()` 函数后（约第 292 行）添加三个命令检测函数：

```typescript
export function isFeishuHelpCommand(content: string): boolean {
  return content.trim().toLowerCase() === '/help';
}

export function isFeishuStatusCommand(content: string): boolean {
  return content.trim().toLowerCase() === '/status';
}

export function parseFeishuResumeCommand(content: string): { isResume: boolean; sessionId?: string } {
  const trimmed = content.trim();
  const match = /^\/resume\s+([a-f0-9-]+)$/i.exec(trimmed);
  if (match) {
    return { isResume: true, sessionId: match[1] };
  }
  return { isResume: false };
}
```

### 2. 状态查询和 Resume 执行函数（runtime.ts）

在 `runtime.ts` 末尾添加两个辅助函数：

```typescript
export function getFeishuSessionStatus(conversationId: string): {
  sessionId?: string;
  cwd?: string;
  model?: string;
  backend?: string;
  effort?: string;
  hasBinding: boolean;
  bindingStatus?: string;
} {
  const sessionId = conversationSessions.get(conversationId);
  const cwd = conversationCwd.get(conversationId);
  const model = conversationModels.get(conversationId);
  const backend = conversationBackend.get(conversationId);
  const effort = conversationEffort.get(conversationId);
  const binding = threadSessionBindings.get(conversationId);

  return {
    sessionId,
    cwd,
    model,
    backend,
    effort,
    hasBinding: !!binding,
    bindingStatus: binding?.nativeSessionStatus,
  };
}

export async function executeFeishuResumeCommand(
  conversationId: string,
  targetSessionId: string,
): Promise<{ success: boolean; message: string }> {
  // 关闭当前会话
  closeThreadSession({ conversationId });

  // 设置要恢复的 session id
  conversationSessions.set(conversationId, targetSessionId);

  return {
    success: true,
    message: `已关闭当前会话，将在下次运行时恢复 session: ${targetSessionId}`,
  };
}
```

### 3. 帮助卡片构建（cards.ts）

在 `packages/feishu/src/cards.ts` 末尾（约第 350 行后）添加帮助卡片构建函数：

```typescript
export function buildFeishuHelpCardPayload(
  conversationId: string,
  context: FeishuCardContext,
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      title: plainText('命令帮助'),
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '**可用命令：**',
        },
        {
          tag: 'markdown',
          content: '• `/help` - 显示此帮助信息',
        },
        {
          tag: 'markdown',
          content: '• `/status` - 查看当前会话状态（session id、目录、模型等）',
        },
        {
          tag: 'markdown',
          content: '• `/resume <session_id>` - 关闭当前会话并恢复指定会话',
        },
        {
          tag: 'markdown',
          content: '• `/done` - 清除当前会话的 continuation',
        },
        {
          tag: 'hr',
        },
        {
          tag: 'markdown',
          content: '**快捷操作：**',
        },
        button('查看状态', context, 'status', {}, 'default'),
        button('控制面板', context, 'control-panel', {}, 'default'),
      ],
    },
  };
}
```

### 4. 命令处理逻辑（events.ts）

在 `packages/feishu/src/events.ts` 的 `handleMessageEvent()` 函数中，在 `/done` 命令处理后（约第 696 行后）添加新命令的处理逻辑：

```typescript
// 处理 /help 命令
if (isFeishuHelpCommand(preprocessed.prompt)) {
  await transport.sendCard(
    target,
    buildFeishuHelpCardPayload(
      conversationId,
      buildFeishuCardContext(conversationId, target),
    ),
  );
  succeeded = true;
  return;
}

// 处理 /status 命令
if (isFeishuStatusCommand(preprocessed.prompt)) {
  const status = getFeishuSessionStatus(conversationId);
  const lines = [
    '**会话状态信息**',
    '',
    `• Conversation ID: \`${conversationId}\``,
  ];

  if (status.sessionId) {
    lines.push(`• Session ID: \`${status.sessionId}\``);
  }
  if (status.backend) {
    lines.push(`• Backend: ${status.backend}`);
  }
  if (status.model) {
    lines.push(`• Model: ${status.model}`);
  }
  if (status.effort) {
    lines.push(`• Effort: ${status.effort}`);
  }
  if (status.cwd) {
    lines.push(`• 当前目录: \`${status.cwd}\``);
  }
  if (status.hasBinding) {
    lines.push(`• Binding 状态: ${status.bindingStatus}`);
  }

  await transport.sendText(target, lines.join('\n'));
  succeeded = true;
  return;
}

// 处理 /resume 命令
const resumeCmd = parseFeishuResumeCommand(preprocessed.prompt);
if (resumeCmd.isResume) {
  if (!resumeCmd.sessionId) {
    await transport.sendText(target, '用法: /resume <session_id>');
    succeeded = true;
    return;
  }

  if (message.chat_type === 'p2p') {
    await transport.sendText(target, '请在 session chat 中使用 /resume 命令。');
    succeeded = true;
    return;
  }

  if (isAuthorizationEnabled(config) && !isAuthorizedActor(config, senderOpenId)) {
    await transport.sendText(target, FEISHU_UNAUTHORIZED_TEXT);
    succeeded = true;
    return;
  }

  const result = await executeFeishuResumeCommand(conversationId, resumeCmd.sessionId);
  await transport.sendText(target, result.message);

  if (result.success) {
    await persistFeishuState();
  }

  succeeded = true;
  return;
}
```

### 5. 卡片按钮交互支持（events.ts）

在 `handleCardActionEvent()` 函数中（约第 892 行），在现有的 action 处理链中添加 `status` 动作：

```typescript
: actionType === 'status'
  ? { conversationId, type: 'status' }
  : actionType === 'done'
```

然后在 `handleFeishuControlAction()` 调用后添加 status 处理：

```typescript
if (actionType === 'status') {
  const status = getFeishuSessionStatus(conversationId);
  const lines = [
    '**会话状态信息**',
    '',
    `• Conversation ID: \`${conversationId}\``,
  ];

  if (status.sessionId) {
    lines.push(`• Session ID: \`${status.sessionId}\``);
  }
  if (status.backend) {
    lines.push(`• Backend: ${status.backend}`);
  }
  if (status.model) {
    lines.push(`• Model: ${status.model}`);
  }
  if (status.effort) {
    lines.push(`• Effort: ${status.effort}`);
  }
  if (status.cwd) {
    lines.push(`• 当前目录: \`${status.cwd}\``);
  }
  if (status.hasBinding) {
    lines.push(`• Binding 状态: ${status.bindingStatus}`);
  }

  await transport.sendText(target, lines.join('\n'));
  succeeded = true;
  return;
}
```

### 6. 导出新函数（runtime.ts 和 events.ts）

确保在相应文件的导出部分添加新函数的导出。

## 关键文件

- `packages/feishu/src/runtime.ts` - 命令检测和执行函数
- `packages/feishu/src/cards.ts` - 帮助卡片构建
- `packages/feishu/src/events.ts` - 命令处理逻辑
- `packages/core/src/state.ts` - 状态存储（已存在，无需修改）
- `packages/core/src/thread-session/manager.ts` - Session 管理（已存在，无需修改）

## 验证方法

### 1. 测试 /help 命令
- 在飞书 session chat 中发送 `/help`
- 验证返回帮助卡片，包含命令列表和快捷按钮
- 点击"查看状态"按钮，验证显示状态信息
- 点击"控制面板"按钮，验证打开控制面板

### 2. 测试 /status 命令
- 在有活跃会话的 session chat 中发送 `/status`
- 验证显示完整的会话信息：conversation id、session id、backend、model、effort、cwd、binding 状态
- 在没有会话的 chat 中测试，验证只显示基本信息

### 3. 测试 /resume 命令
- 获取一个有效的 session id（通过 `/status` 查看）
- 在另一个 session chat 中发送 `/resume <session_id>`
- 验证显示成功消息
- 发送新的提示词，验证会话确实恢复到指定的 session
- 测试错误情况：
  - 不带参数：`/resume` - 应显示用法提示
  - 在 p2p chat 中使用 - 应提示在 session chat 中使用
  - 未授权用户使用 - 应显示未授权提示

### 4. 集成测试
- 完整流程：创建会话 → `/status` 查看 → `/done` 关闭 → `/resume` 恢复
- 验证状态持久化正常工作
- 验证权限控制正常工作

## 注意事项

1. **权限控制**：`/help` 和 `/status` 无需权限验证，`/resume` 需要与 `/done` 相同的权限验证
2. **错误处理**：所有命令都需要处理边界情况和错误输入
3. **状态持久化**：`/resume` 命令执行后需要调用 `persistFeishuState()` 保存状态
4. **用户体验**：提供清晰的错误提示和使用说明
5. **向后兼容**：新命令不影响现有功能
