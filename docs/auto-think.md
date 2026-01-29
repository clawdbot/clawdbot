---
summary: "Auto-think: Automatic thinking level classification based on message content"
read_when:
  - You want to enable automatic thinking level selection
  - You want to configure auto-think heuristics or rules
---
# Auto-Think

Auto-think automatically classifies incoming messages and selects an appropriate thinking level without requiring explicit `/think` directives from users.

## Overview

When enabled, auto-think analyzes each incoming message using heuristics to determine complexity:

- **High complexity**: Debug requests, security reviews, architecture discussions, large code blocks
- **Medium complexity**: How-to questions, implementation requests, step-by-step guides, comparisons
- **Low complexity**: Simple lookups, definitions, format/translation requests
- **Minimal/Off**: Short messages, greetings, unclassified content

## Configuration

Enable auto-think in your agent config:

```yaml
agents:
  defaults:
    autoThink:
      enabled: true
```

### Full options

```yaml
agents:
  defaults:
    autoThink:
      enabled: true
      floor: "off"        # Never go below this level
      ceiling: "high"     # Never go above this level
      rules:              # Custom patterns (optional)
        - match: "newsletter"
          level: "medium"
        - match: "security|audit"
          level: "high"
```

### Config reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable auto-think classification |
| `floor` | ThinkLevel | `"off"` | Minimum thinking level |
| `ceiling` | ThinkLevel | `"high"` | Maximum thinking level |
| `rules` | Array | `[]` | Custom pattern rules |

### Custom rules

Rules are evaluated in order; the first match wins. Each rule has:

- `match`: A regex pattern (case-insensitive) or plain string
- `level`: The thinking level to use when matched

Example:

```yaml
rules:
  - match: "urgent|asap"
    level: "high"
  - match: "quick question"
    level: "off"
```

## Override behavior

Auto-think respects the existing directive precedence:

1. **Inline directive** (`/t high` in the message) — always wins
2. **Session sticky** (previous `/think:high` directive-only message)
3. **Auto-think classification** — when enabled and no directive present
4. **Default level** (`thinkingDefault` config)

Users can always override auto-think with explicit `/think` directives.

## Built-in heuristics

### High complexity signals

- Debug/debugging requests
- Error messages, stack traces, exceptions
- Security, vulnerability, audit keywords
- Architecture, design pattern discussions
- Refactoring, optimization requests
- Code blocks > 500 characters

### Medium complexity signals

- "How do/would/should/can" questions
- "Explain", "analyze", "compare" requests
- Step-by-step guides
- Implementation/build/create requests
- Planning, strategy discussions
- Code blocks > 100 characters
- Messages > 2000 characters

### Low complexity signals

- Simple "What is X?" questions
- Translation/conversion requests
- List/enumerate requests
- Definition lookups

### Fallbacks

- Very short messages (< 50 chars): `off`
- Unclassified messages: `minimal`

## Performance

Auto-think uses pure regex heuristics with no additional API calls. Classification adds negligible latency (< 1ms).

## Related

- [Thinking levels](/tools/thinking) — Manual thinking control via `/think` directives
- [Token use](/token-use) — Cost implications of thinking levels
