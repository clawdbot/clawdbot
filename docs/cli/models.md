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
openclaw models set-image <model-or-alias>
openclaw models scan
```

`status` and `auth` subcommands accept `--agent <id>` to target a configured agent; `list`, `scan`, `aliases`, and `fallbacks`/`image-fallbacks` always use the configured default agent, and `set`/`set-image` reject `--agent` outright. When omitted, `--agent`-aware commands use `OPENCLAW_AGENT_DIR` if set, otherwise the configured default agent.

### Status

`openclaw models status` shows the resolved default/fallbacks plus an auth overview. When provider usage snapshots are available, the OAuth/API-key status section includes provider usage windows and quota snapshots. Current usage-window providers: Anthropic, GitHub Copilot, Gemini CLI, OpenAI, MiniMax, Xiaomi, and z.ai. Usage auth comes from provider-specific hooks when available; otherwise OpenClaw falls back to matching OAuth/API-key credentials from auth profiles, env, or config.

In `--json` output, `auth.providers` is the env/config/store-aware provider overview, while `auth.oauth` is auth-store profile health only.

Options:

| Flag                      | Effect                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--json`                  | JSON output; auth-profile, provider, and startup diagnostics go to stderr so stdout stays pipeable into `jq`. |
| `--plain`                 | Plain text output.                                                                                            |
| `--check`                 | Exit non-zero if auth is expiring/expired: `1` = expired/missing, `2` = expiring.                             |
| `--probe`                 | Live probe of configured auth profiles. Real requests; may consume tokens and trigger rate limits.            |
| `--probe-provider <name>` | Probe one provider only.                                                                                      |
| `--probe-profile <id>`    | Probe specific auth profile ids (repeat or comma-separated).                                                  |
| `--probe-timeout <ms>`    | Per-probe timeout.                                                                                            |
| `--probe-concurrency <n>` | Concurrent probes.                                                                                            |
| `--probe-max-tokens <n>`  | Probe max tokens (best effort).                                                                               |
| `--agent <id>`            | Configured agent id; overrides `OPENCLAW_AGENT_DIR`.                                                          |

Probe rows can come from auth profiles, env credentials, or `models.json`. Probe status buckets: `ok`, `auth`, `rate_limit`, `billing`, `timeout`, `format`, `unknown`, `no_model`.

Probe detail/reason codes to expect when a probe never reaches a model call:

- `excluded_by_auth_order`: a stored profile exists, but explicit `auth.order.<provider>` omitted it, so probe reports the exclusion instead of trying it.
- `missing_credential`, `invalid_expires`, `expired`, `unresolved_ref`: profile is present but not eligible or resolvable.
- `ineligible_profile`: profile is incompatible with provider config for another reason.
- `no_model`: provider auth exists, but OpenClaw could not resolve a probeable model candidate for that provider.

For OpenAI ChatGPT/Codex OAuth troubleshooting, `openclaw models status`, `openclaw models auth list --provider openai`, and `openclaw config get agents.defaults.model --json` are the quickest way to confirm whether an agent has a usable `openai` OAuth profile for `openai/*` through the native Codex runtime. See [OpenAI provider setup](/providers/openai#check-and-recover-codex-oauth-routing).

### List

`openclaw models list` is read-only: it reads config, auth profiles, existing catalog state, and provider-owned catalog rows, but never rewrites `models.json`.

Options: `--all` (full catalog), `--local` (filter to local models), `--provider <id>`, `--json`, `--plain`.

Notes:

- The `Auth` column is read-only. For provider-owned model routes such as OpenAI, it matches each row's API/base-URL route to eligible profiles in effective `auth.order`, env/config credentials, and resolved command-scoped SecretRefs. A concrete OpenAI row stays unknown when its route policy is unavailable instead of borrowing provider-level auth; provider-only legacy checks and other providers retain provider-level behavior. Plugin synthetic-auth metadata is only a runtime-capability hint, not proof of native account authentication, so account-dependent routes remain unknown without positive registry evidence. The command does not load provider runtime, read keychain secrets, call provider APIs, or prove exact execution readiness.
- `models list --all --provider <id>` can include provider-owned static catalog rows from plugin manifests or bundled provider catalog metadata even when you have not authenticated with that provider yet. Those rows still show as unavailable until matching auth is configured.
- `models list` keeps the control plane responsive while provider catalog discovery is slow. The default and configured views fall back to configured or synthetic model rows after a short wait and let discovery finish in the background. Use `--all` when you need the exact full discovered catalog and are willing to wait for provider discovery.
- Broad `models list --all` merges manifest catalog rows over registry rows without loading provider runtime supplement hooks. Provider-filtered manifest fast paths use only providers marked `static`; providers marked `refreshable` stay registry/cache-backed and append manifest rows as supplements, while providers marked `runtime` stay on registry/runtime discovery.
- `models list` keeps native model metadata and runtime caps distinct. In table output, `Ctx` shows `contextTokens/contextWindow` when an effective runtime cap differs from the native context window; JSON rows include `contextTokens` when a provider exposes that cap.
- For provider-owned routes, `models list` projects one logical provider/model row onto the selected route. `Input` and `Ctx` come only from an exact physical-route catalog row, with explicit configured logical overrides applied last; unresolved route selection shows unknown capability fields instead of borrowing sibling-route metadata.
- `models list --provider <id>` filters by provider id, such as `moonshot` or `openai`. It does not accept display labels from interactive provider pickers, such as `Moonshot AI`.
- Model refs are parsed by splitting on the **first** `/`. If the model ID includes `/` (OpenRouter-style), include the provider prefix (example: `openrouter/moonshotai/kimi-k2`).
- If you omit the provider, OpenClaw resolves the input as an alias first, then as a unique configured-provider match for that exact model id, and only then falls back to the configured default provider with a deprecation warning. If that provider no longer exposes the configured default model, OpenClaw falls back to the first configured provider/model instead of surfacing a stale removed-provider default.
- `models status` may show `marker(<value>)` in auth output for non-secret placeholders (for example `OPENAI_API_KEY`, `secretref-managed`, `minimax-oauth`, `oauth:chutes`, `ollama-local`) instead of masking them as secrets.

### Set default / image model

```bash
openclaw models set <model-or-alias>
openclaw models set-image <model-or-alias>
```

`set` writes `agents.defaults.model.primary`; `set-image` writes `agents.defaults.imageModel.primary`. Both accept `provider/model` or a configured alias. `set` also repairs Codex/Copilot runtime plugin installs when the newly selected model needs one; `set-image` does not. Neither command accepts `--agent`; they always write agent defaults.

### Scan

`models scan` reads OpenRouter's public `:free` catalog and ranks candidates for fallback use. The catalog itself is public, so metadata-only scans do not need an OpenRouter key.

By default OpenClaw tries to probe tool and image support with live model calls. If no OpenRouter key is configured, the command falls back to metadata-only output and explains that `:free` models still require `OPENROUTER_API_KEY` for probes and inference.

Options:

- `--no-probe` (metadata only; no config/secrets lookup)
- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>` (catalog request and per-probe timeout)
- `--concurrency <n>`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

`--set-default` and `--set-image` require live probes; metadata-only scan results are informational and are not applied to config.

## Aliases

```bash
openclaw models aliases list [--json] [--plain]
openclaw models aliases add <alias> <model-or-alias>
openclaw models aliases remove <alias>
```

Aliases are stored per model entry as `agents.defaults.models.<key>.alias`. `add` resolves `<model-or-alias>` to a canonical provider/model key first, so aliasing an alias repoints it rather than chaining.

## Fallbacks

```bash
openclaw models fallbacks list [--json] [--plain]
openclaw models fallbacks add <model-or-alias>
openclaw models fallbacks remove <model-or-alias>
openclaw models fallbacks clear
```

Manages `agents.defaults.model.fallbacks`. `openclaw models image-fallbacks list|add|remove|clear` manages the parallel `agents.defaults.imageModel.fallbacks` list with the same subcommand shape.

## Auth profiles

```bash
openclaw models auth add
openclaw models auth list [--provider <id>] [--json]
openclaw models auth login --provider <id>
openclaw models auth login --provider openai --profile-id openai:work
openclaw models auth login-github-copilot
openclaw models auth paste-api-key --provider <id>
openclaw models auth setup-token --provider <id>
openclaw models auth paste-token --provider <id>
openclaw models auth order get --provider <id>
openclaw models auth order set --provider <id> <profileIds...>
openclaw models auth order clear --provider <id>
```

`models auth add` is the interactive auth helper. It can launch a provider auth flow (OAuth/API key) or guide you into manual token paste, depending on the provider you choose.

`models auth list` lists saved auth profiles for the selected agent without printing token, API-key, or OAuth secret material. Use `--provider <id>` to filter to one provider, such as `openai`, and `--json` for scripting.

`models auth login` runs a provider plugin's auth flow (OAuth/API key). Use `openclaw plugins list` to see which providers are installed. `login` accepts `--profile-id <id>` for providers that support named profiles during login (use this to keep multiple logins for the same provider separate), `--method <id>` to pick a specific auth method, `--device-code` as a shortcut for `--method device-code`, `--set-default` to apply the provider's recommended default model, and `--force` to remove existing profiles for that provider first (use when a cached OAuth profile is stuck or you want to switch accounts).

`models auth login-github-copilot` is a shortcut for `models auth login --provider github-copilot --method device` (GitHub device flow); it accepts `--yes` to overwrite an existing profile without prompting.

Use `openclaw models auth --agent <id> <subcommand>` to write auth results to a specific configured agent store. The parent `--agent` flag is honored by `add`, `list`, `login`, `paste-api-key`, `setup-token`, `paste-token`, `login-github-copilot`, and `order get`/`set`/`clear`.

For OpenAI models, `--provider openai` defaults to ChatGPT/Codex account login. Use `--method api-key` only when you want to add an OpenAI API-key profile, usually as a backup for Codex subscription limits. Run `openclaw doctor --fix` to migrate older legacy OpenAI Codex prefix auth/profile state to `openai`.

Examples:

```bash
openclaw models auth login --provider openai --set-default
openclaw models auth login --provider openai --method api-key
openclaw models auth paste-api-key --provider openai
openclaw models auth list --provider openai
```

Notes:

- `paste-api-key` accepts API keys generated elsewhere, prompts for the key value, and writes it to the default profile id `<provider>:manual` unless you pass `--profile-id`. In automation, pipe the key on stdin, for example `printf "%s\n" "$OPENAI_API_KEY" | openclaw models auth paste-api-key --provider openai`.
- `setup-token` and `paste-token` remain generic token commands for providers that expose token auth methods.
- `setup-token` requires an interactive TTY and runs the provider's token-auth method (defaulting to that provider's `setup-token` method when it exposes one).
- `paste-token` requires `--provider`, prompts for the token value by default, and writes it to the default profile id `<provider>:manual` unless you pass `--profile-id`. In automation, pipe the token on stdin instead of passing it as an argument so provider credentials do not appear in shell history or process lists.
- `paste-token --expires-in <duration>` stores an absolute token expiry from a relative duration such as `365d` or `12h`.
- For `openai`, OpenAI API keys and ChatGPT/OAuth token material are different auth shapes. Use `paste-api-key` for `sk-...` OpenAI API keys and `paste-token` only for token auth material.
- Anthropic: `setup-token`/`paste-token` are supported OpenClaw auth paths for `anthropic`, but OpenClaw prefers reusing the Claude CLI (`claude -p`) on the host when it is available.
- `auth order get/set/clear` manages a per-agent auth profile order override for one provider, stored in `auth-state.json` (separate from the `auth.order.<provider>` config key). `set` takes one or more profile ids in priority order; `clear` falls back to config/round-robin ordering.

## Related

- [CLI reference](/cli)
- [Model selection](/concepts/model-providers)
- [Model failover](/concepts/model-failover)
