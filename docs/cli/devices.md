---
summary: "CLI reference for `openclaw devices` (device pairing + token rotation/revocation)"
read_when:
  - You are approving device pairing requests
  - You need to rotate or revoke device tokens
title: "Devices"
---

# `openclaw devices`

Manage device pairing requests and device-scoped tokens.

## Common options

- `--url <url>`: Gateway WebSocket URL (defaults to `gateway.remote.url` when configured)
- `--token <token>`: Gateway token (if required)
- `--password <password>`: Gateway password (password auth)
- `--timeout <ms>`: RPC timeout
- `--json`: JSON output (recommended for scripting)

<Warning>
When you set `--url`, the CLI does not fall back to config or environment credentials. Pass `--token` or `--password` explicitly, or the command errors.
</Warning>

## Commands

### `openclaw devices list`

List pending pairing requests and paired devices.

```bash
openclaw devices list
openclaw devices list --json
```

For a pending request on an already-paired device, the output shows requested access next to the device's current approved access, so scope/role upgrades are visible instead of looking like a lost pairing.

Paired device display names use this precedence: operator label (`operatorLabel` from `devices rename`), then client `displayName`, then `clientId`, then `deviceId`.

### `openclaw devices approve [requestId] [--latest]`

Approve a pending pairing request by exact `requestId`. Omitting `requestId`, or passing `--latest`, only previews the newest pending request and exits (code 1); rerun with the exact request ID to approve.

```bash
openclaw devices approve
openclaw devices approve <requestId>
openclaw devices approve --latest
```

<Note>
If a device retries pairing with changed auth details (role, scopes, or public key), OpenClaw supersedes the previous pending entry with a new `requestId`. Run `openclaw devices list` right before approval to get the current id.
</Note>

Approval behavior:

- If the device is already paired and requests broader scopes or role, OpenClaw keeps the existing approval and creates a new pending upgrade request. Compare `Requested` vs `Approved` in `openclaw devices list`, or preview with `--latest`, before approving.
- Approving a `node` role or other non-operator role requires `operator.admin`. `operator.pairing` is enough for operator-device approvals, but only when the requested operator scopes stay within the caller's own scopes. See [Operator scopes](/gateway/operator-scopes).
- If `gateway.nodes.pairing.autoApproveCidrs` is configured, first-time `role: node` requests from matching client IPs can be auto-approved before they appear in this list. Disabled by default; never applies to operator/browser clients or upgrade requests.

### `openclaw devices reject <requestId>`

Reject a pending device pairing request.

```bash
openclaw devices reject <requestId>
```

### `openclaw devices remove <deviceId>`

Remove one paired device entry.

```bash
openclaw devices remove <deviceId>
openclaw devices remove <deviceId> --json
```

A caller authenticated with a paired device token can remove only its **own** device entry. Removing another device requires `operator.admin`.

### `openclaw devices rename --device <id> --name <label>`

Assign an operator label to a paired device. Labels are owner-side state: they survive pairing repairs and role re-approvals, and they do not change the stable `deviceId`.

```bash
openclaw devices rename --device <deviceId> --name "Kitchen Mac"
openclaw devices rename --device <deviceId> --name "Kitchen Mac" --json
```

- `--name` is required, trimmed, non-empty, and capped at 64 characters.
- Display surfaces (CLI list, Control UI inventory) prefer the operator label over the client-reported display name.
- A non-admin paired-device caller can rename only its **own** device. Renaming another device requires `operator.admin`.

### `openclaw devices clear --yes [--pending]`

Clear paired devices in bulk. Gated by `--yes`.

```bash
openclaw devices clear --yes
openclaw devices clear --yes --pending
openclaw devices clear --yes --pending --json
```

`--pending` also rejects all pending pairing requests.

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotate a device token for a role, optionally updating its scopes.

```bash
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

- The target role must already exist in that device's approved pairing contract; rotation cannot mint a new unapproved role.
- Omitting `--scope` reuses the stored token's cached approved scopes on later reconnects. Passing explicit `--scope` values replaces the stored scope set for future cached-token reconnects.
- A non-admin paired-device caller can rotate only its **own** device token, and the target scope set must stay within the caller's own operator scopes; rotation cannot mint or preserve a broader token than the caller already has.

Returns rotation metadata as JSON. If the caller rotates its own token while authenticated with that device token, the response includes the replacement token so the client can persist it before reconnecting. Shared/admin rotations never echo the bearer token.

### `openclaw devices revoke --device <id> --role <role>`

Revoke a device token for a role.

```bash
openclaw devices revoke --device <deviceId> --role node
```

A non-admin paired-device caller can revoke only its **own** device token. Revoking another device's token requires `operator.admin`. The target scope set must also fit within the caller's own operator scopes; pairing-only callers cannot revoke admin/write operator tokens.

## Notes

- These commands require `operator.pairing` (or `operator.admin`) scope. Non-operator device roles always require `operator.admin`; see [Operator scopes](/gateway/operator-scopes).
- Token rotation and revocation stay inside the device's approved pairing role set and scope baseline. A stray cached token entry does not grant a token-management target.
- For paired-device token sessions, cross-device management (`remove`, `rename`, `rotate`, `revoke`) is self-only unless the caller has `operator.admin`.
- Token rotation returns a new token (sensitive) — treat it like a secret.
- If pairing scope is unavailable on local loopback and no explicit `--url` is passed, `list`/`approve` can fall back to local pairing state.

## Token drift recovery checklist

Use this when Control UI or other clients keep failing with `AUTH_TOKEN_MISMATCH`, `AUTH_DEVICE_TOKEN_MISMATCH`, or `AUTH_SCOPE_MISMATCH`.

1. Confirm current gateway token source:

   ```bash
   openclaw config get gateway.auth.token
   ```

2. List paired devices and identify the affected device id:

   ```bash
   openclaw devices list
   ```

3. Rotate the operator token for the affected device:

   ```bash
   openclaw devices rotate --device <deviceId> --role operator
   ```

4. If rotation is not enough, remove the stale pairing and approve again:

   ```bash
   openclaw devices remove <deviceId>
   openclaw devices list
   openclaw devices approve <requestId>
   ```

5. Retry the client connection with the current shared token/password.

Notes:

- Normal reconnect auth precedence: explicit shared token/password first, then explicit `deviceToken`, then stored device token, then bootstrap token.
- Trusted `AUTH_TOKEN_MISMATCH` recovery can temporarily send both the shared token and the stored device token together for one bounded retry.
- `AUTH_SCOPE_MISMATCH` means the device token was recognized but does not carry the requested scope set; fix the pairing/scope approval contract before changing shared gateway auth.

Related:

- [Dashboard auth troubleshooting](/web/dashboard#if-you-see-unauthorized-1008)
- [Gateway troubleshooting](/gateway/troubleshooting#dashboard-control-ui-connectivity)

## Paperclip / `openclaw_gateway` first-run approval

Paperclip agents connecting through the `openclaw_gateway` adapter go through the same first-run device pairing approval as any other new client. If Paperclip reports `openclaw_gateway_pairing_required`, approve the pending device and retry.

```bash
openclaw devices approve --latest
```

The preview prints the exact `openclaw devices approve <requestId>` command; verify the details, then rerun that command with the request ID to approve it. For a remote gateway or explicit credentials, pass the same options while previewing and approving:

```bash
openclaw devices approve --latest --url <gateway-ws-url> --token <gateway-token>
```

To avoid re-approving after every restart, configure a persistent `adapterConfig.devicePrivateKeyPem` in Paperclip instead of letting it generate a new ephemeral device identity each run:

```json
{
  "adapterConfig": {
    "devicePrivateKeyPem": "<ed25519-private-key-pkcs8-pem>"
  }
}
```

If approval keeps failing, run `openclaw devices list` first to confirm a pending request exists.

## Related

- [CLI reference](/cli)
- [Nodes](/nodes)
