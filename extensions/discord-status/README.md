# Discord Status Plugin

Updates Discord bot presence/status with session information after each message.

## Current Status: Partial Implementation

This plugin demonstrates the `message_sent` hook usage. It currently **logs** what status it would set, rather than actually updating Discord presence.

### What Works
- ✅ Hook triggers after each message is sent
- ✅ Session tracking via sessionKey
- ✅ Channel filtering (only fires for Discord)
- ✅ Custom status format strings

### What's Pending
- ⏳ Usage statistics (tokens, model, etc.) - requires wiring usage data through the reply pipeline
- ⏳ Actual Discord presence updates - requires exposing `setPresence` via PluginRuntime

## Configuration

```json5
{
  plugins: {
    entries: {
      "discord-status": {
        enabled: true,
        config: {
          format: "📊 {tokens} tokens",
          activityType: "Custom"  // Playing, Watching, Listening, Competing, Custom
        }
      }
    }
  }
}
```

### Format Placeholders

- `{tokens}` - Total tokens used in session
- `{input}` - Input tokens (when usage tracking is implemented)
- `{output}` - Output tokens (when usage tracking is implemented)
- `{model}` - Model name
- `{provider}` - Provider name
- `{session}` - Session key

## Contributing

To complete this plugin, the following changes are needed:

### 1. Usage Statistics (in `src/auto-reply/reply/dispatch-from-config.ts`)

The `getReplyFromConfig` return type needs to include usage metadata:

```typescript
type ReplyWithMeta = {
  payload: ReplyPayload | ReplyPayload[];
  meta?: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      model?: string;
      provider?: string;
    };
    durationMs?: number;
  };
};
```

### 2. Discord Presence API (in Discord channel runtime)

Expose `setPresence` method via `PluginRuntime.channel.discord`:

```typescript
// In src/discord/monitor/provider.ts
const gateway = client.getPlugin<GatewayPlugin>("gateway");
// Add: api.setPresence = (options) => gateway.setPresence(options);
```

## License

MIT - Clawdbot Contributors
