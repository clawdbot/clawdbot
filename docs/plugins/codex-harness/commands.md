---
summary: "The /codex command surface, Fast mode controls, and local thread inspection"
read_when:
  - You need the /codex command surface
  - You are comparing shared Fast mode with Codex fast mode
  - You are inspecting a bad Codex run
title: "Codex commands and diagnostics"
sidebarTitle: "Commands and diagnostics"
---

The `/codex` slash-command surface and the diagnostics paths around it. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Commands and diagnostics

The `codex` plugin registers `/codex` as a slash command on any channel that
supports OpenClaw text commands.

Native execution, control, and host-wide inspection require an owner or an
`operator.admin` Gateway client. This includes binding or resuming threads,
sending or stopping turns, changing model, fast-mode, or permission state,
compacting or reviewing, detaching a binding, and inspecting account details,
host status, native threads, paired-node sessions, MCP servers, or skills.
Other authorized senders retain help, model listings, and read-only inspection
of their current conversation's binding, model, permissions, Fast mode, and
native goal. Host-wide reads are restricted because they can expose other
conversations, private workspaces, account identities, and connected services.

Common forms:

- `/codex status` checks app-server connectivity, models, account, rate
  limits, MCP servers, and skills.
- `/codex models` lists live Codex app-server models.
- `/codex threads [filter]` lists recent Codex app-server threads.
- `/codex goal` reads or updates the attached thread's native Codex goal. Codex automatic goal continuation stays disabled; OpenClaw does not own autonomous follow-on turns yet.
- `/codex resume <thread-id>` attaches the current OpenClaw session to an
  existing Codex thread.
- `/codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]`
  attaches the current chat.
- `/codex detach` (or `/codex unbind`) detaches the current binding.
- `/codex binding` describes the current binding.
- `/codex stop` stops the active turn; `/codex steer <text>` steers it.
- `/codex model <model>`, `/codex fast [on|off|status]`, and
  `/codex permissions [default|yolo|status]` change per-conversation state.
  The permissions argument `default` (also `guardian`, `guarded`, or `approve`)
  selects `guarded`; it does not clear the session permission mode. `yolo`
  selects full access and requires `operator.admin`, even for an owner sender.
  Status displays `default` only when no session permission mode is set.
- `/codex compact` runs the same completion and session-accounting pipeline as
  `/compact`, then reports whether Codex compacted the session and the resulting
  token count. If compaction is skipped or fails, the reply includes the reason.
- `/codex review` starts Codex native review for the attached thread.
- `/codex diagnostics [note]` asks before sending Codex feedback for the
  attached thread.
- `/codex account` shows account and rate-limit status.
- `/codex mcp` lists Codex app-server MCP server status.
- `/codex skills` lists Codex app-server skills.
- `/codex plugins list` shows configured native plugins; `/codex plugins
available` discovers Codex marketplace plugins in the bound workspace.
- `/codex plugins install <plugin>@<marketplace>` installs and authorizes one
  discovered plugin. `/codex plugins enable <name>` and `/codex plugins
disable <name>` update its persisted policy. Mutations require an owner or
  `operator.admin` gateway client.
- `/codex computer-use [status|install]` manages Codex Computer Use.
- `/codex help` lists the full command tree.

When `/codex resume` attaches a thread without an existing verified harness
binding, its next turn checks the native thread's stored tool catalog and
applies the current harness configuration before continuing. This first
attachment requires the local stdio app-server and its per-agent Codex home.
The target native thread must be idle. OpenClaw coordinates attachment, resume,
and release of that thread; unrelated chats and catalog reads can continue on
the same app-server. If the target thread is active, wait for its turn to finish
and retry. Use [Codex supervision](/plugins/codex-supervision) or native Codex to
continue threads in a shared user home or on another app-server.

Native child threads controlled by a parent cannot be attached with `/codex
resume` or `/codex bind`. OpenClaw reports that restriction and keeps the current
binding. Continue the child through its native parent instead.

Codex cannot replace a thread's dynamic tool catalog during resume. If that
catalog differs from the current harness tools, its metadata cannot be read,
or Codex cannot confirm that it applied the configuration, OpenClaw reports
the problem and keeps the selected native thread intact. It does not silently
start another thread. Use `/new` to start with the current harness tools, or
continue the preserved thread in native Codex.

If an ordinary OpenClaw-managed native thread was deleted, the next turn starts
a fresh native thread while keeping the selected model and provider. This
recovery preserves pending manual attachments and native-model-owned threads.
It does not replay a turn whose native outcome is uncertain.

### Shared Fast mode and Codex fast mode

`/fast` controls the shared OpenClaw policy. A directive-only `/fast off`
persists `off` in the OpenClaw session and sends `null` on affected Codex
harness turns to clear the OpenClaw-owned service-tier override. `/fast default`
clears only that session layer, so lower-precedence shared defaults may still
resolve to `on`, `off`, or `auto`.

`/codex fast` instead changes the bound native Codex conversation preference.
`/codex fast off` stores `flex` for later conversation-bound native turns; it
is not a synonym for `/fast off`, and it does not change the shared OpenClaw
session policy. When a shared Fast-mode run control reaches a Codex harness
turn, it supersedes `plugins.entries.codex.config.appServer.serviceTier` and
any binding preference that applies to that turn: Fast on sends `priority`,
Fast off sends `null`, and auto decides for each model call. The configured or
bound native tier is used only when no shared run control is supplied.

`/codex fast status` and `/codex binding` report native preference state, not
the upstream tier that processed a completed provider request.

For most support reports, start with `/diagnostics [note]` in the
conversation where the bug happened. It creates one Gateway diagnostics
report and, for Codex harness sessions, asks for approval to send the
relevant Codex feedback bundle. See
[Diagnostics export](/gateway/diagnostics) for the privacy model and group
chat behavior. Use `/codex diagnostics [note]` only when you specifically
want the Codex feedback upload for the currently attached thread without
the full Gateway diagnostics bundle.

### Inspect Codex threads locally

The fastest way to inspect a bad Codex run is often to open the native
Codex thread directly:

```bash
codex resume <thread-id>
```

Get the thread id from the completed `/diagnostics` reply, `/codex binding`,
or `/codex threads [filter]`.

For upload mechanics and runtime-level diagnostics boundaries, see
[Codex harness runtime](/plugins/codex-harness-runtime#codex-feedback-upload).
