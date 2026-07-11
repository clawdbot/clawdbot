---
summary: "Ephemeral side questions with /btw"
read_when:
  - You want to ask a quick side question about the current session
  - You are implementing or debugging BTW behavior across clients
title: "BTW side questions"
---

`/btw` (alias `/side`) asks a quick side question about the **current
session** without adding it to conversation history. It is modeled after
Claude Code's `/btw`, adapted to OpenClaw's Gateway and multi-channel
architecture.

```text
/btw what changed?
/side what does this error mean?
```

## What it does

1. Snapshots the current session as background context (including any
   in-flight main-run prompt).
2. Runs a separate, one-shot side query telling the model to answer only the
   side question and not resume or steer the main task.
3. Delivers the answer as a live side result, not a normal assistant message.
4. Never writes the question or answer to session history or `chat.history`.

The main run, if one is active, is left untouched.

For Codex harness sessions, BTW forks the active Codex app-server thread into
an ephemeral child thread instead of running a separate provider call. This
keeps Codex OAuth and native tool/thread behavior intact, and the forked
thread keeps the parent thread's current approval policy, sandbox, and native
tool surface. The forked thread gets a boundary prompt telling the model that
everything before it is inherited reference context, not active instructions,
and that only messages after the boundary are live. `/btw` requires an
existing Codex thread; send a normal message first.

For CLI runtime aliases, BTW invokes the owning CLI backend in one-shot
side-question mode: it seeds sanitized conversation context into a fresh CLI
invocation with tool bundling and reusable session state disabled, and adds
any no-resume/no-tools flags the backend supports. Direct (non-CLI) runtimes
use a direct one-shot provider call instead.

## What it does not do

`/btw` does not create a durable session, continue the unfinished main task,
persist question/answer data to transcript history, or survive a reload.

## Delivery model

Normal assistant chat uses the Gateway `chat` event. BTW uses a separate
`chat.side_result` event so clients cannot mistake it for regular
conversation history. Because it is not replayed from `chat.history`, it
disappears after reload.

## Surface behavior

| Surface           | Behavior                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI               | Rendered inline in the chat log, visibly distinct from a normal reply, dismissible with `Enter` or `Esc`.                                               |
| External channels | Delivered as a clearly labeled one-off reply (Telegram, WhatsApp, Discord have no local ephemeral overlay).                                             |
| Control UI / web  | Rendered as a dismissible BTW card above the composer, with a pending placeholder while the side question runs. Dismiss with the close button or `Esc`. |

## Selection popup (Control UI)

Highlighting text inside a chat message in the Control UI opens a small
selection popup with two actions:

- **More details** immediately sends an implicit `/btw` question asking the
  model to explain the highlighted text in the context of the current
  session. The answer arrives as a live side result above the composer.
- **Ask in side chat** pre-fills the composer with a `/btw` draft quoting the
  highlighted text so you can type your own question about it.

Both actions follow normal `/btw` semantics: the question and answer stay out
of session history and the main run is left untouched.

## When to use it

Use `/btw` for a quick clarification, a factual side answer while a long run
is still in progress, or a temporary answer that should not enter future
session context.

```text
/btw what file are we editing?
/btw summarize the current task in one sentence
/btw what is 17 * 19?
```

For anything you want to become part of the session's future working
context, ask normally in the main session instead.

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
