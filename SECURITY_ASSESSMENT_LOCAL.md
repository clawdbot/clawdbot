# Moltbot Security Assessment: "Strictly Local" Usage

This report assesses the security of Moltbot for a "strictly local" deployment using local LLMs (Ollama) and ensuring no sensitive data leaves the machine.

## 1. Outbound Data Leakage Audit

### Update Checks
Moltbot checks for updates on startup by querying the npm registry (`registry.npmjs.org`). This leaks the fact that Moltbot is being run and the version being used.
*   **Risk**: Low (Metadata leak).
*   **Mitigation**: Set `update.checkOnStart: false` in `moltbot.json`.

### Telemetry & Diagnostics
Moltbot includes an OpenTelemetry (OTEL) schema, but no active telemetry is enabled by default to send data to a remote central server.
*   **Status**: Safe by default.
*   **Caution**: Avoid enabling `diagnostics.otel.enabled` in production if strict local privacy is required.

### External Tools
The following tools are designed for outbound access and will leak data if used:
- `web_fetch`: Fetches content from URLs.
- `web_search`: Performs web searches via Brave/Perplexity.
- `browser`: Controls a local/remote browser.
*   **Risk**: High (Content exfiltration if the agent is tricked via prompt injection).
*   **Mitigation**: Explicitly deny these tools in `tools.deny` or disable them in their respective config sections.

## 2. Model Isolation & Fallback Audit

### Provider Fallbacks
Moltbot has a fallback mechanism that can transition from a failed primary model to fallbacks. The default provider is `anthropic`.
*   **Risk**: Medium. If Ollama is unavailable, the system might attempt to talk to Anthropic if a fallback is implicitly configured or if the user hasn't cleared the fallbacks list.
*   **Mitigation**:
    - Set `agents.defaults.model.primary` to your Ollama model (e.g., `ollama/llama3`).
    - Explicitly set `agents.defaults.model.fallbacks: []`.
    - Ensure no Anthropic/OpenAI API keys or profiles are configured.

### Model Discovery
Cloud-based model discovery (e.g., for Venice, Bedrock) only occurs if those providers are active.
*   **Status**: Safe as long as cloud providers are not configured.

## 3. Gateway & Web Security

### Binding
The Moltbot Gateway binds strictly to loopback (`127.0.0.1`) by default.
*   **Status**: Safe. Access is restricted to the local machine.

### Authentication
Authentication is enforced by default. The Gateway will refuse to start if no token or password is configured (unless using Tailscale).
*   **Status**: Safe.

### CSRF & CORS
Moltbot does not set CORS headers, effectively blocking cross-origin requests from browsers. Most sensitive actions require a Bearer token or a custom WebSocket handshake, which mitigates CSRF risks from local browsers.
*   **Risk**: Low.
*   **Recommendation**: Ensure a strong `gateway.auth.token` is used.

## 4. Sandbox & Tool Security

### Untrusted Inputs (WhatsApp/Telegram)
When using external channels, the bot receives untrusted input.
*   **Risk**: High. A malicious message could use prompt injection to trick the bot into running dangerous local commands via the `exec` tool.
*   **Mitigation**:
    - Enable Docker sandboxing for all non-main sessions: `agents.defaults.sandbox.mode: "non-main"`.
    - Tighten `tools.elevated.allowFrom` to only include your own user IDs.
    - Set `groupPolicy: "allowlist"` for all channels to prevent unauthorized users from interacting with the bot in groups.

---

## New: "Strictly Local" Startup Option

Moltbot now includes a `--local-only` flag for the `gateway` command. This flag automatically applies all the hardening steps described in this report at startup, without requiring you to manually edit your configuration file.

To use it, start the gateway with:
```bash
moltbot gateway --local-only
```

This will:
- Disable update checks on start.
- Disable diagnostics.
- Clear all model fallbacks.
- Deny web tools, browser, and skills-install.
- Enable Docker sandboxing for non-main sessions.

## Recommended Configuration for "Strictly Local" Setup

If you prefer to make these settings permanent in your configuration, add/update these keys in your `~/.clawdbot/moltbot.json`:

```json5
{
  "update": {
    "checkOnStart": false
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "ollama/llama3", // Replace with your Ollama model
        "fallbacks": []
      },
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "deny": ["group:web", "browser", "skills-install"],
    "elevated": {
      "enabled": true,
      "allowFrom": {
        "whatsapp": ["your-phone-number"],
        "telegram": ["your-username"]
      }
    }
  },
  "diagnostics": {
    "enabled": false
  }
}
```

## Summary Verdict
Moltbot is **well-suited** for local-only usage, provided the configuration is hardened as described above. The core architecture is local-first, and there are no mandatory "phone home" features that cannot be disabled.
