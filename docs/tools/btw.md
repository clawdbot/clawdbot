---
summary: "Ephemeral side questions with /btw"
read_when:
  - You want to ask a quick side question about the current session
  - You are implementing or debugging BTW behavior across clients
title: "BTW side questions"
---

`/btw` lets you ask a quick side question about the **current session** without
turning that question into normal conversation history. `/side` is an alias.

It is modeled after Claude Code's `/btw` behavior, but adapted to OpenClaw's
Gateway and multi-channel architecture.

## What it does

When you send:

```text
/btw what changed?
```

OpenClaw:

1. snapshots the current session context,
2. runs a separate **tool-less** model call,
3. answers only the side question,
4. leaves the main run alone,
5. does **not** write the BTW question or answer to session history,
6. emits the answer as a **live side result** rather than a normal assistant message.

The important mental model is:

- same session context
- separate one-shot side query
- no tool calls
- no future context pollution
- no transcript persistence

## What it does not do

`/btw` does **not**:

- create a new durable session,
- continue the unfinished main task,
- run tools or agent tool loops,
- write BTW question/answer data to transcript history,
- appear in `chat.history`,
- survive a reload.

It is intentionally **ephemeral**.

## How context works

BTW uses the current session as **background context only**.

If the main run is currently active, OpenClaw snapshots the current message
state and includes the in-flight main prompt as background context, while
explicitly telling the model:

- answer only the side question,
- do not resume or complete the unfinished main task,
- do not emit tool calls or pseudo-tool calls.

That keeps BTW isolated from the main run while still making it aware of what
the session is about.

## Delivery model

BTW is **not** delivered as a normal assistant transcript message.

At the Gateway protocol level:

- normal assistant chat uses the `chat` event
- BTW uses the `chat.side_result` event

This separation is intentional. If BTW reused the normal `chat` event path,
clients would treat it like regular conversation history.

Because BTW uses a separate live event and is not replayed from
`chat.history`, it disappears after reload.

## Surface behavior

### TUI

In TUI, BTW is rendered inline in the current session view, but it remains
ephemeral:

- visibly distinct from a normal assistant reply
- dismissible with `Enter` or `Esc`
- not replayed on reload

### External channels

On channels like Telegram, WhatsApp, and Discord, BTW is delivered as a
clearly labeled one-off reply because those surfaces do not have a local
ephemeral overlay concept.

The answer is still treated as a side result, not normal session history.

### Control UI / web

The Gateway emits BTW correctly as `chat.side_result`, and BTW is not included
in `chat.history`, so the persistence contract is already correct for web.

The current Control UI still needs a dedicated `chat.side_result` consumer to
render BTW live in the browser. Until that client-side support lands, BTW is a
Gateway-level feature with full TUI and external-channel behavior, but not yet
a complete browser UX.

## When to use BTW

Use `/btw` when you want:

- a quick clarification about the current work,
- a factual side answer while a long run is still in progress,
- a temporary answer that should not become part of future session context.

Examples:

```text
/btw what file are we editing?
/side what changed while the main run continued?
/btw what does this error mean?
/btw summarize the current task in one sentence
/btw what is 17 * 19?
```

## When not to use BTW

Do not use `/btw` when you want the answer to become part of the session's
future working context.

In that case, ask normally in the main session instead of using BTW.

## Related

<CardGroup cols={2}>
  <Card title="Slash commands" href="/tools/slash-commands" icon="terminal">
    Native command catalog and chat directives.
  </Card>
  <Card title="Thinking levels" href="/tools/thinking" icon="brain">
    Reasoning effort levels for the side-question model call.
  </Card>
  <Card title="Session" href="/concepts/session" icon="comments">
    Session keys, history, and persistence semantics.
  </Card>
  <Card title="Steer command" href="/tools/steer" icon="arrow-right">
    Inject a steering message into the active run without ending it.
  </Card>
</CardGroup>
