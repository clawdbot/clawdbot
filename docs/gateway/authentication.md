---
summary: "Model authentication: OAuth, API keys, Claude CLI reuse, and Anthropic setup-token"
read_when:
  - Debugging model auth or OAuth expiry
  - Documenting authentication or credential storage
title: "Authentication"
---

<Note>
This page covers **model provider** authentication (API keys, OAuth, Claude CLI reuse, Anthropic setup-token). For **gateway connection** authentication (token, password, trusted-proxy), see [Configuration](/gateway/configuration) and [Trusted Proxy Auth](/gateway/trusted-proxy-auth).
</Note>

OpenClaw supports OAuth and API keys for model providers. For an always-on gateway host, an API key is the most predictable option; subscription/OAuth flows work too when they match your provider account model.

- Full OAuth flow and storage layout: [/concepts/oauth](/concepts/oauth)
- SecretRef-based auth (`env`/`file`/`exec` providers): [Secrets Management](/gateway/secrets)
- Credential eligibility/reason codes used by `models status --probe`: [Auth Credential Semantics](/auth-credential-semantics)

## Recommended setup: API key (any provider)

1. Create an API key in your provider console.
2. Put it on the **gateway host** (the machine running `openclaw gateway`):

```bash
export <PROVIDER>_API_KEY="..."
openclaw models status
```

3. If the gateway runs under systemd/launchd, put the key in `~/.openclaw/.env` so the daemon can read it:

```bash
cat >> ~/.openclaw/.env <<'EOF'
<PROVIDER>_API_KEY=...
EOF
```

4. Restart the gateway process (or the daemon), then re-check:

```bash
openclaw models status
openclaw doctor
```

`openclaw onboard` can also store API keys for daemon use if you don't want to manage env vars yourself. See [Environment variables](/help/environment) for the full env-loading precedence (`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd).

## Anthropic: Claude CLI reuse

Anthropic setup-token auth remains a supported path. Claude CLI reuse (`claude -p`-style usage) is also sanctioned for this integration; when a Claude CLI login is available on the host, that's the preferred path for local/desktop use. For long-lived gateway hosts, an Anthropic API key is still the most predictable choice, with explicit server-side billing control.

Host setup for Claude CLI reuse:

```bash
# Run on the gateway host
claude auth login
claude auth status --text
openclaw models auth login --provider anthropic --method cli --set-default
```

This is two steps: log Claude Code into Anthropic on the host, then tell OpenClaw to route Anthropic model selection through the local `claude-cli` backend and store the matching OpenClaw auth profile.

The gateway service must resolve `claude` on `PATH`. If a deployment needs a
nonstandard executable path, register a wrapper through a
[CLI backend plugin](/plugins/cli-backend-plugins).

## Manual token entry

Works for any provider; writes the per-agent SQLite auth store and updates config:

```bash
openclaw models auth paste-token --provider openrouter
```

OpenClaw reads auth profiles from each agent's `openclaw-agent.sqlite`. Endpoint details (`baseUrl`, `api`, model ids, headers, timeouts) belong under `models.providers.<id>` in `openclaw.json` or `models.json`, not in auth profiles.

If an older install still has `auth-profiles.json`, `auth-state.json`, or a flat shape like `{ "openrouter": { "apiKey": "..." } }`, run `openclaw doctor --fix` to import it into SQLite; doctor keeps timestamped backups beside the original JSON files.

External auth routes such as Bedrock `auth: "aws-sdk"` aren't credentials. For a named Bedrock route, set `auth.profiles.<id>.mode: "aws-sdk"` in `openclaw.json` — don't write `type: "aws-sdk"` into the auth profile store. `openclaw doctor --fix` migrates legacy AWS SDK markers from the credential store into config metadata.

### SecretRef-backed credentials

- `api_key` credentials can use `keyRef: { source, provider, id }`
- `token` credentials can use `tokenRef: { source, provider, id }`
- OAuth-mode profiles reject SecretRef credentials: if `auth.profiles.<id>.mode` is `"oauth"`, a SecretRef-backed `keyRef`/`tokenRef` for that profile is rejected.

## Checking model auth status

```bash
openclaw models status
openclaw doctor
```

Automation-friendly check, exit `1` when expired/missing, `2` when expiring:

```bash
openclaw models status --check
```

Live auth probes (add `--probe-provider`, `--probe-profile`, `--probe-timeout`, `--probe-concurrency`, or `--probe-max-tokens` to narrow scope):

```bash
openclaw models status --probe
```

Notes:

- Probe rows can come from auth profiles, env credentials, or `models.json`.
- If `auth.order.<provider>` omits a stored profile, probe reports `excluded_by_auth_order` for that profile instead of trying it.
- If auth exists but OpenClaw can't resolve a probeable model for that provider, probe reports `status: no_model`.
- Rate-limit cooldowns can be model-scoped: a profile cooling down for one model can still serve a sibling model on the same provider.

Optional ops scripts (systemd/Termux): [Auth monitoring scripts](/help/scripts#auth-monitoring-scripts).

## API key rotation (gateway)

Some providers retry a request with an alternate configured key when a call hits a provider rate limit.

Key priority order per provider:

1. `OPENCLAW_LIVE_<PROVIDER>_KEY` (single override, pins one key)
2. `<PROVIDER>_API_KEYS` (comma/space/semicolon-separated list)
3. `<PROVIDER>_API_KEY`
4. `<PROVIDER>_API_KEY_*` (any env var with this prefix)

Google providers (`google`, `google-vertex`) additionally fall back to `GOOGLE_API_KEY`. The combined list is deduplicated before use.

OpenClaw rotates to the next key only when the error message matches: `rate_limit`, `rate limit`, `429`, `quota exceeded`/`quota_exceeded`, `resource exhausted`/`resource_exhausted`, or `too many requests`. Other errors are not retried with alternate keys. If all keys fail, the final error from the last attempt is returned.

<Note>
Provider-specific phrases like `ThrottlingException`, `concurrency limit reached`, or `workers_ai ... quota limit exceeded` drive **failover/retry classification** (switching models or providers on repeated failure), a separate mechanism from API-key rotation above.
</Note>

Removing saved auth does not revoke the key at the provider — rotate or revoke it in the provider dashboard when you need provider-side invalidation.

## Removing provider auth while the gateway is running

When you remove provider auth through the gateway control plane, OpenClaw deletes the saved auth profiles for that provider and aborts active chat/agent runs whose selected model provider matches the removed one. Aborted runs emit the normal cancellation/lifecycle events with `stopReason: "auth-revoked"`, so connected clients can show the run stopped because credentials were removed.

## Controlling which credential is used

### OpenAI and legacy `openai-codex` ids

OpenAI API-key profiles and ChatGPT/Codex OAuth profiles both use the canonical provider id `openai`. Use `openai:*` profile ids and `auth.order.openai` for new config.

If you see `openai-codex` in older config, auth profile ids, or `auth.order.openai-codex`, treat it as legacy migration input — don't create new `openai-codex` profiles. Run:

```bash
openclaw doctor --fix
openclaw models auth list --provider openai
```

Doctor rewrites legacy `openai-codex:*` profile ids and `auth.order.openai-codex` entries to the canonical `openai` route. For OpenAI-specific model/runtime routing, see [OpenAI](/providers/openai).

### During login (CLI)

```bash
openclaw models auth login --provider openai --profile-id openai:ritsuko
openclaw models auth login --provider openai --profile-id openai:lain
```

`--profile-id` keeps multiple OAuth logins for the same provider separate inside one agent.

`--force` deletes the saved auth profiles for that provider in the selected agent directory, then reruns the same auth flow. Use it when a saved profile is stuck, expired, or tied to the wrong account. It doesn't revoke credentials at the provider.

```bash
openclaw models auth login --provider anthropic --force
```

### Per-session (chat command)

- `/model <alias-or-id>@<profileId>` pins a specific provider credential for the current session (example profile ids: `anthropic:default`, `anthropic:work`).
- `/model` (or `/model list`) shows a compact picker; `/model status` shows the full view (candidates + next auth profile, plus provider endpoint details when configured).

If you change auth order or profile pinning for a chat that's already running, send `/new` or `/reset` to start a fresh session — existing sessions keep their current model/profile selection until reset.

### Per-agent (CLI override)

Auth order overrides are stored in that agent's SQLite auth state:

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Use `--agent <id>` to target a specific agent; omit it to use the configured default agent. `openclaw models status --probe` shows omitted stored profiles as `excluded_by_auth_order` rather than silently skipping them.

## Troubleshooting

### "No credentials found"

Configure an Anthropic API key on the **gateway host**, or set up the Anthropic setup-token path, then re-check:

```bash
openclaw models status
```

### Token expiring/expired

Run `openclaw models status` to see which profile is expiring. If an Anthropic token profile is missing or expired, refresh it via setup-token or migrate to an Anthropic API key.

## Related

- [Secrets management](/gateway/secrets)
- [Remote access](/gateway/remote)
- [Auth storage](/concepts/oauth)
