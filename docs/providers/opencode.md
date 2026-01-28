---
summary: "Use OpenCode Zen (curated models) with Moltbot"
read_when:
  - You want OpenCode Zen for model access
  - You want a curated list of coding-friendly models
---
# OpenCode Zen

OpenCode Zen is a **curated list of models** recommended by the OpenCode team for coding agents.
It is an optional, hosted model access path that uses an API key and the `opencode` provider.
Zen is currently in beta.

## CLI setup

```bash
moltbot onboard --auth-choice opencode-zen
# or non-interactive
moltbot onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Config snippet

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-5" } } }
}
```

## Notes

- `OPENCODE_ZEN_API_KEY` is also supported.
- You sign in to Zen, add billing details, and copy your API key.
- OpenCode Zen bills per request; check the OpenCode dashboard for details.
