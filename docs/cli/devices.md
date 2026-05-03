---
summary: "CLI reference for `openclaw devices` (device pairing + token rotation/revocation)"
read_when:
  - You are approving device pairing requests
  - You need to rotate or revoke device tokens
title: "Devices"
---

# `openclaw devices`

Manage device pairing requests and device-scoped tokens.

## Commands

### `openclaw devices list`

List pending pairing requests and paired devices.

```
openclaw devices list
openclaw devices list --json
```

Pending request output shows the requested access next to the device's current
approved access when the device is already paired. This makes scope/role
upgrades explicit instead of looking like the pairing was lost.

### `openclaw devices remove <deviceId>`

Remove one paired device entry.

When you are authenticated with a paired device token, non-admin callers can
remove only **their own** device entry. Removing some other device requires
`operator.admin`.

```
openclaw devices remove <deviceId>
openclaw devices remove <deviceId> --json
```

### `openclaw devices clear --yes [--pending]`

Clear paired devices in bulk.

```
openclaw devices clear --yes
openclaw devices clear --yes --pending
openclaw devices clear --yes --pending --json
```

### `openclaw devices approve [requestId] [--latest]`

Approve a pending device pairing request by exact `requestId`. If `requestId`
is omitted or `--latest` is passed, OpenClaw only prints the selected pending
request and exits; rerun approval with the exact request ID after verifying
the details.

<Note>
If a device retries pairing with changed auth details (role, scopes, or public key), OpenClaw supersedes the previous pending entry and issues a new `requestId`. Run `openclaw devices list` right before approval to use the current ID.
</Note>

If the device is already paired and asks for broader scopes or a broader role,
OpenClaw keeps the existing approval in place and creates a new pending upgrade
request. Review the `Requested` vs `Approved` columns in `openclaw devices list`
or use `openclaw devices approve --latest` to preview the exact upgrade before
approving it.

If the Gateway is explicitly configured with
`gateway.nodes.pairing.autoApproveCidrs`, first-time `role: node` requests from
matching client IPs can be approved before they appear in this list. That policy
is disabled by default and never applies to operator/browser clients or upgrade
requests.

```
openclaw devices approve
openclaw devices approve <requestId>
openclaw devices approve --latest
```

### `openclaw devices reject <requestId>`

Reject a pending device pairing request.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotate a device token for a specific role (optionally updating scopes).
The target role must already exist in that device's approved pairing contract;
rotation cannot mint a new unapproved role.
If you omit `--scope`, later reconnects with the stored rotated token reuse that
token's cached approved scopes. If you pass explicit `--scope` values, those
become the stored scope set for future cached-token reconnects.
Non-admin paired-device callers can rotate only their **own** device token.
The target token scope set must stay within the caller session's own operator
scopes; rotation cannot mint or preserve a broader operator token than the
caller already has.

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

Returns rotation metadata as JSON. If the caller is rotating its own token while
authenticated with that device token, the response also includes the replacement
token so the client can persist it before reconnecting. Shared/admin rotations
do not echo the bearer token.

### `openclaw devices revoke --device <id> --role <role>`

Revoke a device token for a specific role.

Non-admin paired-device callers can revoke only their **own** device token.
Revoking some other device's token requires `operator.admin`.
The target token scope set must also fit within the caller session's own
operator scopes; pairing-only callers cannot revoke admin/write operator tokens.

```
openclaw devices revoke --device <deviceId> --role node
```

Returns the revoke result as JSON.

## Common options

- `--url <url>`: Gateway WebSocket URL (defaults to `gateway.remote.url` when configured).
- `--token <token>`: Gateway token (if required).
- `--password <password>`: Gateway password (password auth).
- `--timeout <ms>`: RPC timeout.
- `--json`: JSON output (recommended for scripting).

<Warning>
When you set `--url`, the CLI does not fall back to config or environment credentials. Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.
</Warning>

## Notes

- Token rotation returns a new token (sensitive). Treat it like a secret.
- These commands require `operator.pairing` (or `operator.admin`) scope. Some
  approvals also require the caller to hold the operator scopes that the target
  device would mint or inherit; see [Operator scopes](/gateway/operator-scopes).
- `gateway.nodes.pairing.autoApproveCidrs` is an opt-in Gateway policy for
  fresh node device pairing only; it does not change CLI approval authority.
- Token rotation and revocation stay inside the approved pairing role set and
  approved scope baseline for that device. A stray cached token entry does not
  grant a token-management target.
- For paired-device token sessions, cross-device management is admin-only:
  `remove`, `rotate`, and `revoke` are self-only unless the caller has
  `operator.admin`.
- Token mutation is also caller-scope contained: a pairing-only session cannot
  rotate or revoke a token that currently carries `operator.admin` or
  `operator.write`.
- `devices clear` is intentionally gated by `--yes`.
- If pairing scope is unavailable on local loopback (and no explicit `--url` is passed), list/approve can use a local pairing fallback.
- `devices approve` requires an explicit request ID before minting tokens; omitting `requestId` or passing `--latest` only previews the newest pending request.

## Token drift recovery checklist

Use this when Control UI or other clients keep failing with `AUTH_TOKEN_MISMATCH` or `AUTH_DEVICE_TOKEN_MISMATCH`.

1. Confirm current gateway token source:

```bash
openclaw config get gateway.auth.token
```

2. List paired devices and identify the affected device id:

```bash
openclaw devices list
```

3. Rotate operator token for the affected device:

```bash
openclaw devices rotate --device <deviceId> --role operator
```

4. If rotation is not enough, remove stale pairing and approve again:

```bash
openclaw devices remove <deviceId>
openclaw devices list
openclaw devices approve <requestId>
```

5. Retry client connection with the current shared token/password.

Notes:

- Normal reconnect auth precedence is explicit shared token/password first, then explicit `deviceToken`, then stored device token, then bootstrap token.
- Trusted `AUTH_TOKEN_MISMATCH` recovery can temporarily send both the shared token and the stored device token together for the one bounded retry.

Related:

- [Dashboard auth troubleshooting](/web/dashboard#if-you-see-unauthorized-1008)
- [Gateway troubleshooting](/gateway/troubleshooting#dashboard-control-ui-connectivity)

## Related

- [CLI reference](/cli)
- [Nodes](/nodes)
