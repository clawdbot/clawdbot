---
summary: "Model authentication: OAuth, API keys, Claude CLI reuse, and Anthropic setup-token"
read_when:
  - Debugging model auth or OAuth expiry
  - Documenting authentication or credential storage
title: "Authentication"
---

<Note>
This page is the **model provider** authentication reference (API keys, OAuth, Claude CLI reuse, and Anthropic setup-token). For **gateway connection** authentication (token, password, trusted-proxy), see [Configuration](/gateway/configuration) and [Trusted Proxy Auth](/gateway/trusted-proxy-auth).
</Note>

OpenClaw supports OAuth and API keys for model providers. For always-on gateway
hosts, API keys are usually the most predictable option. Subscription/OAuth
flows are also supported when they match your provider account model.

See [/concepts/oauth](/concepts/oauth) for the full OAuth flow and storage
layout.
For SecretRef-based auth (`env`/`file`/`exec` providers), see [Secrets Management](/gateway/secrets).
For credential eligibility/reason-code rules used by `models status --probe`, see
[Auth Credential Semantics](/auth-credential-semantics).

## Recommended setup (API key, any provider)

If you're running a long-lived gateway, start with an API key for your chosen
provider.
For Anthropic specifically, API key auth is still the most predictable server
setup, but OpenClaw also supports reusing a local Claude CLI login.

1. Create an API key in your provider console.
2. Put it on the **gateway host** (the machine running `openclaw gateway`).

```bash
export <PROVIDER>_API_KEY="..."
openclaw models status
```

3. If the Gateway runs under systemd/launchd, prefer putting the key in
   `~/.openclaw/.env` so the daemon can read it:

```bash
cat >> ~/.openclaw/.env <<'EOF'
<PROVIDER>_API_KEY=...
EOF
```

Then restart the daemon (or restart your Gateway process) and re-check:

```bash
openclaw models status
openclaw doctor
```

If you'd rather not manage env vars yourself, onboarding can store
API keys for daemon use: `openclaw onboard`.

See [Help](/help) for details on env inheritance (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: Claude CLI and token compatibility

Anthropic setup-token auth is still available in OpenClaw as a supported token
path. Anthropic staff has since told us that OpenClaw-style Claude CLI usage is
allowed again, so OpenClaw treats Claude CLI reuse and `claude -p` usage as
sanctioned for this integration unless Anthropic publishes a new policy. When
Claude CLI reuse is available on the host, that is now the preferred path.

For long-lived gateway hosts, an Anthropic API key is still the most predictable
setup. If you want to reuse an existing Claude login on the same host, use the
Anthropic Claude CLI path in onboarding/configure.

Recommended host setup for Claude CLI reuse:

```bash
# Run on the gateway host
claude auth login
claude auth status --text
openclaw models auth login --provider anthropic --method cli --set-default
```

This is a two-step setup:

1. Log Claude Code itself into Anthropic on the gateway host.
2. Tell OpenClaw to switch Anthropic model selection to the local `claude-cli`
   backend and store the matching OpenClaw auth profile.

If `claude` is not on `PATH`, either install Claude Code first or set
`agents.defaults.cliBackends.claude-cli.command` to the real binary path.

Manual token entry (any provider; writes `auth-profiles.json` + updates config):

```bash
openclaw models auth paste-token --provider openrouter
```

`auth-profiles.json` stores credentials only. The canonical shape is:

```json
{
  "version": 1,
  "profiles": {
    "openrouter:default": {
      "type": "api_key",
      "provider": "openrouter",
      "key": "OPENROUTER_API_KEY"
    }
  }
}
```

OpenClaw expects the canonical `version` + `profiles` shape at runtime. If an older install still has a flat file such as `{ "openrouter": { "apiKey": "..." } }`, run `openclaw doctor --fix` to rewrite it as an `openrouter:default` API-key profile; doctor keeps a `.legacy-flat.*.bak` copy beside the original. Endpoint details such as `baseUrl`, `api`, model ids, headers, and timeouts belong under `models.providers.<id>` in `openclaw.json` or `models.json`, not in `auth-profiles.json`.

External auth routes such as Bedrock `auth: "aws-sdk"` are also not credentials. If you want a named Bedrock route, put `auth.profiles.<id>.mode: "aws-sdk"` in `openclaw.json`; do not write `type: "aws-sdk"` into `auth-profiles.json`. `openclaw doctor --fix` moves legacy AWS SDK markers from the credential store into config metadata.

Auth profile refs are also supported for static credentials:

- `api_key` credentials can use `keyRef: { source, provider, id }`
- `token` credentials can use `tokenRef: { source, provider, id }`
- OAuth-mode profiles do not support SecretRef credentials; if `auth.profiles.<id>.mode` is set to `"oauth"`, SecretRef-backed `keyRef`/`tokenRef` input for that profile is rejected.

Automation-friendly check (exit `1` when expired/missing, `2` when expiring):

```bash
openclaw models status --check
```

Live auth probes:

```bash
openclaw models status --probe
```

Notes:

- Probe rows can come from auth profiles, env credentials, or `models.json`.
- If explicit `auth.order.<provider>` omits a stored profile, probe reports
  `excluded_by_auth_order` for that profile instead of trying it.
- If auth exists but OpenClaw cannot resolve a probeable model candidate for
  that provider, probe reports `status: no_model`.
- Rate-limit cooldowns can be model-scoped. A profile cooling down for one
  model can still be usable for a sibling model on the same provider.

Optional ops scripts (systemd/Termux) are documented here:
[Auth monitoring scripts](/help/scripts#auth-monitoring-scripts)

## Anthropic note

The Anthropic `claude-cli` backend is supported again.

- Anthropic staff told us this OpenClaw integration path is allowed again.
- OpenClaw therefore treats Claude CLI reuse and `claude -p` usage as sanctioned
  for Anthropic-backed runs unless Anthropic publishes a new policy.
- Anthropic API keys remain the most predictable choice for long-lived gateway
  hosts and explicit server-side billing control.

## Checking model auth status

```bash
openclaw models status
openclaw doctor
```

## API key rotation behavior (gateway)

Some providers support retrying a request with alternative keys when an API call
hits a provider rate limit.

- Priority order:
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` (single override)
  - `<PROVIDER>_API_KEYS`
  - `<PROVIDER>_API_KEY`
  - `<PROVIDER>_API_KEY_*`
- Google providers also include `GOOGLE_API_KEY` as an additional fallback.
- The same key list is deduplicated before use.
- OpenClaw retries with the next key only for rate-limit errors (for example
  `429`, `rate_limit`, `quota`, `resource exhausted`, `Too many concurrent
requests`, `ThrottlingException`, `concurrency limit reached`, or
  `workers_ai ... quota limit exceeded`).
- Non-rate-limit errors are not retried with alternate keys.
- If all keys fail, the final error from the last attempt is returned.

## Removing provider auth while the gateway is running

When provider auth is removed through the Gateway control plane, OpenClaw deletes
the saved auth profiles for that provider and aborts active chat or agent runs
whose selected model provider matches the removed provider. The aborted runs emit
the normal chat cancellation and lifecycle events with
`stopReason: "auth-revoked"`, so connected clients can show that the run was
stopped because credentials were removed.

Removing saved auth does not revoke keys at the provider. Rotate or revoke the
key in the provider dashboard when you need provider-side invalidation.

## Controlling which credential is used

### Per-session (chat command)

Use `/model <alias-or-id>@<profileId>` to pin a specific provider credential for the current session (example profile ids: `anthropic:default`, `anthropic:work`).

Use `/model` (or `/model list`) for a compact picker; use `/model status` for the full view (candidates + next auth profile, plus provider endpoint details when configured).

### Per-agent (CLI override)

Set an explicit auth profile order override for an agent (stored in that agent's `auth-state.json`):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Use `--agent <id>` to target a specific agent; omit it to use the configured default agent.
When you debug order issues, `openclaw models status --probe` shows omitted
stored profiles as `excluded_by_auth_order` instead of silently skipping them.
When you debug cooldown issues, remember that rate-limit cooldowns can be tied
to one model id rather than the whole provider profile.

## Troubleshooting

### "No credentials found"

If the Anthropic profile is missing, configure an Anthropic API key on the
**gateway host** or set up the Anthropic setup-token path, then re-check:

```bash
openclaw models status
```

### Token expiring/expired

Run `openclaw models status` to confirm which profile is expiring. If an
Anthropic token profile is missing or expired, refresh that setup via
setup-token or migrate to an Anthropic API key.

## Related

- [Secrets management](/gateway/secrets)
- [Remote access](/gateway/remote)
- [Auth storage](/concepts/oauth)
