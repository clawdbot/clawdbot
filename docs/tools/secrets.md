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
agent receives only entry metadata and its store SecretRef.

The tool is available in primary agent sessions, not just the canonical main
conversation. Subagent and ACP worker sessions do not receive it.

It is enabled by default and governed by the normal tool policy — there is no
dedicated config key. To remove it, deny it like any other tool (for example
`tools.deny: ["secrets"]` in `openclaw.json`); allowlists and tool profiles
apply to it the same way.

When the tool is callable, the agent's prompt tells it to list metadata first,
then request only a missing credential needed for the task, with a name and
reason. For egress use, it proposes the exact destination hosts too. This
instruction also covers deferred tools and Code Mode; it is omitted when tool
policy removes `secrets`. Without a safe entry surface, the agent should direct
you to safe external setup, never ask for the value in chat.

## Actions

- `request` — ask the human for a credential and store it under a name such as
  `STRIPE_API_KEY`. Requests are protected-secret only: an `env` value is
  readable through `list`, so requesting one would break the promise the masked
  prompt makes. The agent may propose `allowedHosts` and a short `reason` shown
  on the prompt, and the tool blocks until you answer, skip, or it times out
  (15 minutes by default, with `timeoutSeconds` clamped to 30–3600 seconds).
  This is a maximum human wait, subject to earlier cancellation or the overall
  run timeout; the question does not extend an explicit run budget.
  The request is bound to the requesting agent run; if
  that authority closes before you answer, the pending prompt is cancelled and
  the write is refused.
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
The prompt always shows who is asking (agent and session), the entry name, the
agent's stated reason, and an editable list of allowed hosts, so you have the
final say on where the credential may be used. If the name already exists, the
prompt says so and shows when and by whom the entry was last updated;
submitting replaces the stored value. The Gateway preserves submitted values
exactly, including leading or trailing whitespace. Web and Apple request fields
are single-line; use the CLI's `--value-file` input for multiline credentials.

If the agent omits a host proposal, a replacement request starts with the entry's
current hosts; a new entry starts with an empty list. An explicitly empty proposal
stays empty. Submitting saves the displayed list or your edits, even if another
write changes the entry while the prompt is pending. Clearing the list disables
egress substitution while keeping the credential usable through config SecretRefs.

Once the store write commits, the question is answered and cannot be submitted
again. A later runtime refresh failure does not undo that write: resolve the
reported provider error and run `openclaw secrets reload`, rather than resubmitting.

The same tool result reports `status: "stored"`, the SecretRef, and `currentPolicy`
from one follow-up metadata read. This is the entry's current host list, which you
can edit, not Gateway configuration or an immutable approval receipt: another
write may have changed it. `available` includes the
complete allowed-host list; an empty list means no egress. If the serialized list
exceeds 512 characters, `omitted` reports only `allowedHostCount`. `missing`,
`kind_changed`, and `unavailable` mean the entry disappeared, became an `env`
entry, or has no complete validated host policy. None undo the saved result or invite
resubmission. The agent must report current hosts instead of its proposal and
make no host claims when the complete list is unavailable. A difference does not
explain who changed the hosts or why, and is not a reason to prescribe Gateway
configuration changes.

<Warning>
Allowed hosts govern Gateway egress substitution, not config SecretRefs. Leave
only the exact hosts that should receive the credential. An empty list prevents
egress substitution but still allows supported config fields to resolve the
stored credential. Egress also requires the proxy to be enabled; never work
around a missing proxy or destination permission by putting plaintext in commands,
arguments, URLs, logs, or chat.
</Warning>

Skipping the prompt, or letting it expire, tells the agent that no credential
arrived (`no_answer`). It should state the blocker or continue with best judgment,
never ask you to paste the credential into chat.

iOS, macOS, and Android render the same card with a masked secret field.
Control UI and native app cards arrive through the existing Gateway connection
and do not require `gateway.publicOrigin` or a public link.

Chat channels never accept the value. On Telegram, Discord, and similar
surfaces the request is delivered as a link to the Control UI prompt — typing
a credential into a chat message is exactly what this flow exists to avoid, so
a plain-text reply is not captured as an answer. Links require an enabled Control
UI and a configured `gateway.publicOrigin`. Without a usable link, delivery
reports a visible blocker and cancels the pending request. Open a trusted Control
UI or native app and retry, or ask the operator to configure the public origin.

Creating a credential request requires `operator.admin` plus the agent's trusted,
live runtime authority. A run ID or an administrator connection alone is not
enough. Answering needs only the normal question scope and access to that session,
because answering provides a value rather than reading one.

## Using a stored credential

In Gateway-backed sessions, a missing credential for an unrelated provider does
not block a turn on a healthy provider. The agent can use that healthy model to
request the missing entry. Selecting the unavailable provider still fails until
its SecretRef resolves; OpenClaw does not silently substitute an environment or
auth-profile credential.

A stored entry is a regular shared-store entry (see
[Secrets management](/gateway/secrets)):

- Use the returned full `ref` wherever a SecretRef is accepted (provider API
  keys, channel tokens). With the default store alias, it is
  `{ "source": "store", "provider": "default", "id": "STRIPE_API_KEY" }`;
  `secrets.defaults.store` selects a different provider alias. Writes trigger
  refresh of affected config and auth-profile references. A successful refresh
  also replaces prepared model state, so later catalog reads use the new
  credential for providers already in the agent's model scope.
- `env` entries are readable values; the operator sets them, not the credential
  request flow.
- `secret` entries reach Gateway-host subprocess traffic through automatically
  injected opaque environment sentinels only when the egress proxy is enabled
  (`secrets.egressProxy.enabled`). The variable uses the stored entry name; read
  it from the command process's inherited environment. Do not supply a secret
  template, override that variable, or print it. Substitution requires the
  destination to match the entry's allowed hosts. With the proxy disabled,
  protected entries are not injected; use a supported config SecretRef instead.
  Native harness shell, sandbox, and node execution do not receive these protected
  values. The provider troubleshooting switch `OPENCLAW_SECRET_SENTINELS=off` does
  not disable protected-store sealing.

Gateway-host exec captures one store snapshot on its first execution in a run.
A credential stored before that point can be included. Afterward, additions,
replacements, deletions, and host edits do not refresh that run's snapshot; start
a new run to observe them. A successful credential request does not promise that
an already-running exec tool can use the new value.

When the owning run closes, its proxy authorization and existing connections are
revoked, including background subprocess tunnels. Bytes already handed to the
upstream transport cannot be recalled.
