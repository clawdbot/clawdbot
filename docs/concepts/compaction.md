---
summary: "Context window + compaction: how Clawdbot keeps sessions under model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
---
# Context Window & Compaction

Every model has a **context window** (max tokens it can see). Long-running chats accumulate messages and tool results; once the window is tight, Clawdbot **compacts** older history to stay within limits.

## What compaction is
Compaction **summarizes older conversation** into a compact summary entry and keeps recent messages intact. The summary is stored in the session history, so future requests use:
- The compaction summary
- Recent messages after the compaction point

Compaction **persists** in the session’s JSONL history.

## Configuration
See [Compaction config & modes](/concepts/compaction) for the `agents.defaults.compaction` settings.

## Auto-compaction (default on)
When a session nears or exceeds the model’s context window, Clawdbot triggers auto-compaction and may retry the original request using the compacted context.

You’ll see:
- `🧹 Auto-compaction complete` in verbose mode
- `/status` showing `🧹 Compactions: <count>`

Before compaction, Clawdbot can run a **silent memory flush** turn to store
durable notes to disk. See [Memory](/concepts/memory) for details and config.

## Manual compaction
Use `/compact` (optionally with instructions) to force a compaction pass:
```
/compact Focus on decisions and open questions
```

## Context window source
Context window is model-specific. Clawdbot uses the model definition from the configured provider catalog to determine limits.

## Compaction vs pruning
- **Compaction**: summarises and **persists** in JSONL.
- **Session pruning**: trims old **tool results** only, **in-memory**, per request.

See [/concepts/session-pruning](/concepts/session-pruning) for pruning details.

## Tips
- Use `/compact` when sessions feel stale or context is bloated.
- Large tool outputs are already truncated; pruning can further reduce tool-result buildup.
- If you need a fresh slate, `/new` or `/reset` starts a new session id.
