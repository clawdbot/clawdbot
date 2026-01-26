---
summary: "Use Claude Max/Pro subscription as an OpenAI-compatible API endpoint"
read_when:
  - You want to use Claude Max subscription with OpenAI-compatible tools
  - You want a local API server that wraps Claude Code CLI
  - You want to save money by using subscription instead of API keys
---
# Claude Max API Proxy

**claude-max-api-proxy** is a community tool that exposes your Claude Max/Pro subscription as an OpenAI-compatible API endpoint. This allows you to use your subscription with any tool that supports the OpenAI API format.

## Why Use This?

| Approach | Cost | Best For |
|----------|------|----------|
| Anthropic API | Pay per token (~$15/M input, $75/M output for Opus) | Production apps, high volume |
| Claude Max subscription | $200/month flat | Personal use, development, unlimited usage |

If you have a Claude Max subscription and want to use it with OpenAI-compatible tools, this proxy can save you significant money.

## How It Works

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

The proxy:
1. Accepts OpenAI-format requests at `http://localhost:3456/v1/chat/completions`
2. Converts them to Claude Code CLI commands
3. Returns responses in OpenAI format (streaming supported)

## Installation

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Usage

### Start the server

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### With Clawdbot

You can point Clawdbot at the proxy as a custom OpenAI-compatible endpoint:

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:3456/v1"
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-4" }
    }
  }
}
```

## Available Models

| Model ID | Maps To |
|----------|---------|
| `claude-opus-4` | Claude Opus 4 |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4` | Claude Haiku 4 |

## Auto-Start on macOS

Create a LaunchAgent to run the proxy automatically:

```bash
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-max-api</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist
```

## Links

- **npm:** https://www.npmjs.com/package/claude-max-api-proxy
- **GitHub:** https://github.com/atalovesyou/claude-max-api-proxy
- **Issues:** https://github.com/atalovesyou/claude-max-api-proxy/issues

## Notes

- This is a **community tool**, not officially supported by Anthropic or Clawdbot
- Requires an active Claude Max/Pro subscription with Claude Code CLI authenticated
- The proxy runs locally and does not send data to any third-party servers
- Streaming responses are fully supported

## See Also

- [Anthropic provider](/providers/anthropic) - Native Clawdbot integration with Claude Code CLI OAuth
- [OpenAI provider](/providers/openai) - For OpenAI/Codex subscriptions
