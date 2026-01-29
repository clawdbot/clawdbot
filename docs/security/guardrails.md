---
title: Guardrails
summary: AI safety guardrails with @sentinelseed/moltbot.
permalink: /security/guardrails/
---

# Guardrails

The [@sentinelseed/moltbot](https://www.npmjs.com/package/@sentinelseed/moltbot) package provides AI safety guardrails for Moltbot, including real-time validation, data leak prevention, and threat detection.

```bash
npm install @sentinelseed/moltbot
```

## Quick Start

Add to your Moltbot config:

```json
{
  "plugins": {
    "sentinel": {
      "level": "watch"
    }
  }
}
```

## Protection Levels

| Level | Blocking | Alerting | Best For |
|-------|----------|----------|----------|
| `off` | None | None | Disable Sentinel |
| `watch` | None | All threats | Daily use, full visibility |
| `guard` | Critical | High+ threats | Sensitive data environments |
| `shield` | Maximum | All threats | High-security workflows |

The default `watch` mode provides full monitoring with zero blocking. Higher levels add protection you can always bypass when needed.

## Hook Integration

Sentinel provides a hook factory that integrates with Moltbot's hook system:

```ts
import { createSentinelHooks } from '@sentinelseed/moltbot';

const hooks = createSentinelHooks({
  level: 'guard',
  alerts: {
    enabled: true,
    webhook: 'https://your-webhook.com/sentinel'
  }
});

export const moltbot_hooks = {
  message_received: hooks.messageReceived,
  before_agent_start: hooks.beforeAgentStart,
  message_sending: hooks.messageSending,
  before_tool_call: hooks.beforeToolCall,
  agent_end: hooks.agentEnd,
};
```

## Validators

For advanced use cases, validators can be used directly:

```ts
import { validateOutput, validateTool, analyzeInput, getLevelConfig } from '@sentinelseed/moltbot';

const levelConfig = getLevelConfig('guard');

const outputResult = await validateOutput(content, levelConfig);
if (outputResult.shouldBlock) {
  console.log('Blocked:', outputResult.issues);
}

const toolResult = await validateTool('bash', { command: 'ls' }, levelConfig);
const inputResult = await analyzeInput(userMessage);
```

## Escape Hatches

When you need to bypass protection:

```bash
/sentinel pause 5m          # Pause for 5 minutes
/sentinel allow-once        # Allow next action
/sentinel trust bash        # Trust a tool for the session
/sentinel resume            # Resume protection
```

## Configuration

```json
{
  "plugins": {
    "sentinel": {
      "level": "guard",
      "alerts": {
        "enabled": true,
        "webhook": "https://your-webhook.com/sentinel",
        "minSeverity": "high"
      },
      "ignorePatterns": ["MY_SAFE_TOKEN"],
      "logLevel": "warn"
    }
  }
}
```

All validation runs locally without external API calls.

## Links

See the [npm package](https://www.npmjs.com/package/@sentinelseed/moltbot) for installation details, the [source repository](https://github.com/sentinel-seed/sentinel) for implementation, and the [Sentinel documentation](https://sentinelseed.dev/docs/integrations/moltbot) for additional examples.
