---
summary: "Use the optional 1Password plugin as an audited agent secrets broker"
read_when:
  - You want agents to request curated 1Password secrets
  - You need per-secret approval policy and audit history
  - You are configuring a 1Password service account for OpenClaw
title: "1Password secrets broker"
---

# 1Password secrets broker

The bundled `onepassword` plugin gives agents one policy-controlled tool for
reading a curated set of 1Password fields. It is disabled by default and does
nothing until `plugins.entries.onepassword.config` is present.

This is an agent tool, not a SecretRef provider. It does not inject environment
variables or resolve OpenClaw config secrets.

## Security model

- Service-account authentication only. The token stays in a local credentials
  file and is never accepted in `openclaw.json`.
- Curated registry only. Agents can list configured slugs, but the plugin never
  enumerates a 1Password vault.
- Per-slug `auto`, `approve`, or `deny` policy.
- Approval grants expire. A cached value never bypasses current policy.
- Every access attempt is recorded in OpenClaw's shared SQLite state. Audit
  rows include the supplied reason; keep reasons non-sensitive. The broker
  never copies a fetched value or the service token into an audit row.
- After the current tool execution, OpenClaw-owned transcript persistence
  replaces a successful `get` value with redacted metadata.
- The value is model-visible for that execution. If the model copies it into a
  later tool call or reply, that separate record is outside this plugin's
  persistence hook. Keep policies narrow and do not ask the model to echo a
  value.
- The plugin invokes `op` once per cache miss. It does not retry rate limits or
  other failures.

Give the service account read access only to the vaults and items registered in
the plugin config.

## Before you begin

You need:

- the 1Password CLI (`op`) installed on the Gateway host
- a 1Password service account with access to the selected items
- a dedicated service-account token file

Enable the bundled plugin:

```bash
openclaw plugins enable onepassword
```

Create the token directory and file under the OpenClaw state directory:

```bash
mkdir -p ~/.openclaw/credentials/onepassword
chmod 700 ~/.openclaw/credentials/onepassword
printf '%s' "$OP_SERVICE_ACCOUNT_TOKEN" > \
  ~/.openclaw/credentials/onepassword/service-account-token
chmod 600 ~/.openclaw/credentials/onepassword/service-account-token
unset OP_SERVICE_ACCOUNT_TOKEN
```

When `OPENCLAW_STATE_DIR` is set, replace `~/.openclaw` with that directory.
The plugin warns once when the token file is readable or writable by group or
other users.

## Configure registered secrets

Add plugin config to `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "onepassword": {
        "enabled": true,
        "config": {
          "vault": "Automation",
          "defaultPolicy": "approve",
          "cacheTtlSeconds": 300,
          "grantTtlHours": 720,
          "opTimeoutMs": 15000,
          "items": {
            "repository-token": {
              "item": "Repository automation token",
              "field": "credential",
              "policy": "approve",
              "description": "Token for repository automation",
            },
            "model-key": {
              "item": "Model provider key",
              "vault": "Agent credentials",
              "policy": "auto",
            },
          },
        },
      },
    },
  },
}
```

Slugs use lowercase letters, numbers, and hyphens, start with a letter or
number, and contain at most 64 characters. A registry can contain up to 32
slugs; descriptions can contain up to 200 characters. `field` accepts one field
label or ID, must not contain a comma, and defaults to `credential`.
An item-level `vault` overrides the default vault. `opBin` can set an absolute
path to the `op` executable; otherwise the plugin resolves `op` from `PATH`.
Item titles must not start with a hyphen.

## Use the agent tool

The tool name is `onepassword`.

List registered slugs:

```json
{ "action": "list" }
```

The result contains only the slug, description, policy, and whether a standing
grant is active. It never contains a secret value and does not query 1Password.

Request one secret:

```json
{
  "action": "get",
  "slug": "repository-token",
  "reason": "Authenticate the requested repository operation"
}
```

`reason` is required, must be non-empty, and is limited to 300 characters. A
successful `get` returns the value plus the configured slug, item title, and
field label.

The tool schema also declares an internal `authorizationNonce` parameter. The
policy layer injects it after evaluating the request to hand the authorization
to the executing tool call. Never set it manually: the policy hook overwrites
any supplied value, and an unknown value fails the request.

## Policy tiers and approvals

- `auto`: fetch immediately and audit the request.
- `deny`: block and audit the request.
- `approve`: use an unexpired standing grant, or ask a human to allow once,
  always, or deny.

Allow once authorizes only the current tool call. Allow always writes a standing
grant for that agent and slug to SQLite; other agents must receive their own
approval. OpenClaw offers allow always only when the caller has a concrete agent
identity. The grant expires after `grantTtlHours`, which defaults to 720 hours.
An unresolved or timed-out approval denies the request; the maximum approval
wait is 600 seconds. The plugin retains up to 1,024 standing grants; at that
bound, the oldest grant is evicted and its agent must approve the next access.

Each evaluated authorization is single-use and is handed to the executing tool
call through shared SQLite state, so the handoff also works when more than one
plugin instance is active in the gateway process. Unused authorizations expire
after the 600-second approval window.

The in-memory cache defaults to 300 seconds and is bounded by the configured
slug registry. Set `cacheTtlSeconds` to `0` to disable it. Policy is evaluated
before every cache lookup, and cache hits are audited. Runtime config reloads
take effect at each policy and execution boundary; disabling the plugin or
removing, denying, or retargeting a slug invalidates pending authorization and
cached values.

## Inspect status and audit history

Show readiness and registry counts:

```bash
openclaw onepassword status
```

This reports whether the token file exists, whether `op` resolved and its path,
the registered item count, and per-policy counts. It never reads or prints the
token or secret values.

Show the 50 most recent audit rows:

```bash
openclaw onepassword audit
openclaw onepassword audit --limit 100
```

Rows are newest first and show timestamp, agent, slug, outcome, an `errorCode`
when the attempt failed, and a truncated reason. The reason is stored as
supplied; the broker never adds the fetched value to the audit log.

## 1Password CLI behavior

Each cache miss runs `op item get` with the configured item, vault, and exact
field selector, JSON output, a bounded timeout, and `--cache=false`. The child
receives only that field rather than the full item. Only
`OP_SERVICE_ACCOUNT_TOKEN` and `HOME` are present in the child environment.

The plugin makes one attempt. `RATE_LIMITED` errors should be handled by waiting
before a later agent request; the plugin does not create an automatic retry
loop.

## Error codes

Failed attempts carry one closed error code in the tool result and the audit
row.

1Password access errors:

| Code              | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `TOKEN_MISSING`   | Token file is missing or empty                                   |
| `OP_NOT_FOUND`    | `op` binary could not be resolved                                |
| `ITEM_NOT_FOUND`  | Configured item is not in the vault                              |
| `FIELD_NOT_FOUND` | Configured field is not on the item; available labels are listed |
| `RATE_LIMITED`    | 1Password service-account rate limit reached                     |
| `AUTH_FAILED`     | Service-account authentication failed                            |
| `TIMEOUT`         | `op` exceeded `opTimeoutMs`                                      |
| `OP_ERROR`        | Any other `op` failure or invalid output                         |

Policy and validation errors:

| Code                                               | Meaning                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `INVALID_ACTION`, `INVALID_REASON`, `INVALID_SLUG` | Request failed input validation                                              |
| `UNKNOWN_SLUG`                                     | Slug is not in the configured registry                                       |
| `TOOL_CALL_ID_MISSING`                             | Call arrived without a tool call id                                          |
| `POLICY_NOT_EVALUATED`                             | No matching authorization for this call; the request was not policy-approved |
| `POLICY_CHANGED`                                   | Config changed between approval and execution                                |
| `GRANT_EXPIRED`                                    | Standing grant lapsed before execution                                       |
| `APPROVAL_CANCELLED`                               | The run was aborted while the approval was pending                           |
