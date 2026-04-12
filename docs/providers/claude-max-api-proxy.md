---
summary: "Community proxy to expose Claude subscription credentials as an OpenAI-compatible endpoint"
read_when:
  - You want to use Claude Max subscription with OpenAI-compatible tools
  - You want a local API server that wraps Claude Code CLI
  - You want to evaluate subscription-based vs API-key-based Anthropic access
title: "Claude Max API Proxy"
---

# Claude Max API Proxy

**claude-max-api-proxy** is a community tool that exposes your Claude Max/Pro subscription as an OpenAI-compatible API endpoint. This allows you to use your subscription with any tool that supports the OpenAI API format.

<Warning>
This path is technical compatibility only. Anthropic has blocked some subscription
usage outside Claude Code in the past. You must decide for yourself whether to use
it and verify Anthropic's current terms before relying on it.
</Warning>

## Why use this?

| Approach                | Cost                                                | Best For                                   |
| ----------------------- | --------------------------------------------------- | ------------------------------------------ |
| Anthropic API           | Pay per token (~$15/M input, $75/M output for Opus) | Production apps, high volume               |
| Claude Max subscription | $200/month flat                                     | Personal use, development, unlimited usage |

If you have a Claude Max subscription and want to use it with OpenAI-compatible tools, this proxy may reduce cost for some workflows. API keys remain the clearer policy path for production use.

## How it works

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

The proxy:

1. Accepts OpenAI-format requests at `http://localhost:3456/v1/chat/completions`
2. Converts them to Claude Code CLI commands
3. Returns responses in OpenAI format (streaming supported)

## Getting started

<Steps>
  <Step title="Install the proxy">
    Requires Node.js 20+ and Claude Code CLI.

    ```bash
    npm install -g claude-max-api-proxy

    # Verify Claude CLI is authenticated
    claude --version
    ```

  </Step>
  <Step title="Start the server">
    ```bash
    claude-max-api
    # Server runs at http://localhost:3456
    ```
  </Step>
  <Step title="Test the proxy">
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

  </Step>
  <Step title="Configure OpenClaw">
    Point OpenClaw at the proxy as a custom OpenAI-compatible endpoint:

    ```json5
    {
      env: {
        OPENAI_API_KEY: "not-needed",
        OPENAI_BASE_URL: "http://localhost:3456/v1",
      },
      agents: {
        defaults: {
          model: { primary: "openai/claude-opus-4" },
        },
      },
    }
    ```

  </Step>
</Steps>

## Available models

| Model ID          | Maps To         |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Advanced

<AccordionGroup>
  <Accordion title="Proxy-style OpenAI-compatible notes">
    This path uses the same proxy-style OpenAI-compatible route as other custom
    `/v1` backends:

    - Native OpenAI-only request shaping does not apply
    - No `service_tier`, no Responses `store`, no prompt-cache hints, and no
      OpenAI reasoning-compat payload shaping
    - Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`)
      are not injected on the proxy URL

  </Accordion>

  <Accordion title="Auto-start on macOS with LaunchAgent">
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

  </Accordion>
</AccordionGroup>

## Links

- **npm:** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub:** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues:** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Notes

- This is a **community tool**, not officially supported by Anthropic or OpenClaw
- Requires an active Claude Max/Pro subscription with Claude Code CLI authenticated
- The proxy runs locally and does not send data to any third-party servers
- Streaming responses are fully supported

<Note>
For native Anthropic integration with Claude CLI or API keys, see [Anthropic provider](/providers/anthropic). For OpenAI/Codex subscriptions, see [OpenAI provider](/providers/openai).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Anthropic provider" href="/providers/anthropic" icon="bolt">
    Native OpenClaw integration with Claude CLI or API keys.
  </Card>
  <Card title="OpenAI provider" href="/providers/openai" icon="robot">
    For OpenAI/Codex subscriptions.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
</CardGroup>
