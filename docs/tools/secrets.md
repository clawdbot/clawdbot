---
summary: "How the secrets tool lets the agent request credentials it never sees"
read_when:
  - You want the agent to obtain an API key without it entering the chat
  - You are answering or debugging a credential request prompt
  - You need the secrets tool schema, storage, or channel behavior
title: "Secrets"
---

`secrets` lets the agent ask you for a credential without ever seeing it. The
agent names an entry, you type the value into a trusted prompt, and the Gateway
writes it straight into the shared secret store. The value never appears in the
chat, the session transcript, the tool result, or the model's context — the
agent only learns that the entry now exists.

The tool is available only in the main session. Subagents and other
non-primary runs do not receive it.

It is enabled by default and governed by the normal tool policy — there is no
dedicated config key. To remove it, deny it like any other tool (for example
`tools.deny: ["secrets"]` in `openclaw.json`); allowlists and tool profiles
apply to it the same way. Creating a credential request also requires an
`operator.admin` Gateway client, which the agent's own client satisfies.

## Actions

- `request` — ask the human for a credential and store it under a name such as
  `STRIPE_API_KEY`. Requests are protected-secret only: an `env` value is
  readable through `list`, so requesting one would break the promise the masked
  prompt makes. The agent may propose `allowedHosts` and a short `reason` shown
  on the prompt, and the tool blocks until you answer, skip, or it times out
  (15 minutes by default). The request is bound to the requesting agent run; if
  that run ends before you answer, the write is refused.
- `list` — entry metadata: name, kind, allowed hosts, and last update. Secret
  values are structurally absent from the listing. Operator-set `env` entries
  show their value, since those are injected into exec environments anyway and
  are agent-readable by design.
- `delete` — soft-delete an entry by name. Deleted entries are purged after 30
  days.

There is deliberately no action that writes a value the agent supplies. If a
value must enter the store, it arrives through the human prompt, the
`/settings/secrets` page, or the [`openclaw secrets store` CLI](/cli/secrets).

## Answering a request

The web Control UI docks the prompt above the composer with a masked input.
The prompt always shows who is asking (agent and session), the entry name and
kind, the agent's stated reason, and — for secret entries — an editable list of
allowed hosts, so you have the final say on where the credential may be used.
If the name already exists, the prompt says so and shows when and by whom the
entry was last updated; submitting replaces the stored value.

iOS, macOS, and Android render the same card with a masked secret field.

Chat channels never accept the value. On Telegram, Discord, and similar
surfaces the request is delivered as a link to the Control UI prompt — typing
a credential into a chat message is exactly what this flow exists to avoid, so
a plain-text reply is not captured as an answer.

Creating a credential request requires an `operator.admin` client (the agent's
own Gateway client qualifies). Answering needs only the normal question scope,
because answering provides a value rather than reading one.

## Using a stored credential

A stored entry is a regular shared-store entry (see
[Secrets management](/gateway/secrets)):

- Reference it from config as `{ "source": "store", "id": "STRIPE_API_KEY" }`
  wherever a SecretRef is accepted (provider API keys, channel tokens). Writes
  refresh affected config references automatically.
- `env` entries are injected into gateway-host exec environments starting with
  the next agent run.
- `secret` entries are substituted into subprocess traffic only when the
  egress proxy is enabled (`secrets.egressProxy.enabled`) and the destination
  matches the entry's allowed hosts; the agent and its subprocesses otherwise
  see only an opaque placeholder.
