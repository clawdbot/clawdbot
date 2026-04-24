---
summary: "CLI reference for `openclaw models` (status/list/set/scan, aliases, fallbacks, auth)"
read_when:
  - You want to change default models or view provider auth status
  - You want to scan available models/providers and debug auth profiles
title: "Models"
---

# `openclaw models`

Model discovery, scanning, and configuration (default model, fallbacks, auth profiles).

Related:

- Providers + models: [Models](/providers/models)
- Model selection concepts + `/models` slash command: [Models concept](/concepts/models)
- Provider auth setup: [Getting started](/start/getting-started)

## Common commands

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` shows the resolved default/fallbacks plus an auth overview.
When provider usage snapshots are available, the OAuth/API-key status section includes
provider usage windows and quota snapshots.
Current usage-window providers: Anthropic, GitHub Copilot, Gemini CLI, OpenAI
Codex, MiniMax, Xiaomi, and z.ai. Usage auth comes from provider-specific hooks
when available; otherwise OpenClaw falls back to matching OAuth/API-key
credentials from auth profiles, env, or config.
In `--json` output, `auth.providers` is the env/config/store-aware provider
overview, while `auth.oauth` is auth-store profile health only.
Add `--probe` to run live auth probes against each configured provider profile.
Probes are real requests (may consume tokens and trigger rate limits).
Use `--agent <id>` to inspect a configured agent’s model/auth state. When omitted,
the command uses `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` if set, otherwise the
configured default agent.
Probe rows can come from auth profiles, env credentials, or `models.json`.

Notes:

- `models set <model-or-alias>` accepts `provider/model` or an alias.
- `models list` is read-only: it reads config, auth profiles, existing catalog
  state, and provider-owned catalog rows, but it does not rewrite
  `models.json`.
- `models list --all` includes bundled provider-owned static catalog rows even
  when you have not authenticated with that provider yet. Those rows still show
  as unavailable until matching auth is configured.
- `models list --provider <id>` filters by provider id, such as `moonshot` or
  `openai-codex`. It does not accept display labels from interactive provider
  pickers, such as `Moonshot AI`.
- Model refs are parsed by splitting on the **first** `/`. If the model ID includes `/` (OpenRouter-style), include the provider prefix (example: `openrouter/moonshotai/kimi-k2`).
- If you omit the provider, OpenClaw resolves the input as an alias first, then
  as a unique configured-provider match for that exact model id, and only then
  falls back to the configured default provider with a deprecation warning.
  If that provider no longer exposes the configured default model, OpenClaw
  falls back to the first configured provider/model instead of surfacing a
  stale removed-provider default.
- `models status` may show `marker(<value>)` in auth output for non-secret placeholders (for example `OPENAI_API_KEY`, `secretref-managed`, `minimax-oauth`, `oauth:chutes`, `ollama-local`) instead of masking them as secrets.

### `models status`

Options:

- `--json`
- `--plain`
- `--check` (exit 1=expired/missing, 2=expiring)
- `--probe` (live probe of configured auth profiles)
- `--probe-provider <name>` (probe one provider)
- `--probe-profile <id>` (repeat or comma-separated profile ids)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (configured agent id; overrides `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

Probe status buckets:

- `ok`
- `auth`
- `rate_limit`
- `billing`
- `timeout`
- `format`
- `unknown`
- `no_model`

Probe detail/reason-code cases to expect:

- `excluded_by_auth_order`: a stored profile exists, but explicit
  `auth.order.<provider>` omitted it, so probe reports the exclusion instead of
  trying it.
- `missing_credential`, `invalid_expires`, `expired`, `unresolved_ref`:
  profile is present but not eligible/resolvable.
- `no_model`: provider auth exists, but OpenClaw could not resolve a probeable
  model candidate for that provider.

## Aliases + fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Auth profiles

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token --provider <id>
openclaw models auth paste-token
```

`models auth add` is the interactive auth helper. It can launch a provider auth
flow (OAuth/API key) or guide you into manual token paste, depending on the
provider you choose.

`models auth login` runs a provider plugin’s auth flow (OAuth/API key). Use
`openclaw plugins list` to see which providers are installed.

Examples:

```bash
openclaw models auth login --provider openai-codex --set-default
```

Notes:

- `setup-token` and `paste-token` remain generic token commands for providers
  that expose token auth methods.
- `setup-token` requires an interactive TTY and runs the provider's token-auth
  method (defaulting to that provider's `setup-token` method when it exposes
  one).
- `paste-token` accepts a token string generated elsewhere or from automation.
- `paste-token` requires `--provider`, prompts for the token value, and writes
  it to the default profile id `<provider>:manual` unless you pass
  `--profile-id`.
- `paste-token --expires-in <duration>` stores an absolute token expiry from a
  relative duration such as `365d` or `12h`.
- Anthropic note: Anthropic staff told us OpenClaw-style Claude CLI usage is allowed again, so OpenClaw treats Claude CLI reuse and `claude -p` usage as sanctioned for this integration unless Anthropic publishes a new policy.
- Anthropic `setup-token` / `paste-token` remain available as a supported OpenClaw token path, but OpenClaw now prefers Claude CLI reuse and `claude -p` when available.

## Related

- [CLI reference](/cli)
- [Model selection](/concepts/model-providers)
- [Model failover](/concepts/model-failover)
