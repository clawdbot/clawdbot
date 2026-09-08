---
summary: "CLI reference for `openclaw models` (status/list/set/scan, aliases, fallbacks, shared auth, personal accounts)"
read_when:
  - You want to change default models or view provider auth status
  - You want to scan available models/providers and debug auth profiles
  - You want to sign in to or select a personal model account on a shared Gateway
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
openclaw models --json
openclaw models status
openclaw models list
openclaw models refresh
openclaw models set <model-or-alias>
openclaw models set-image <model-or-alias>
openclaw models scan
```

`status`, `list`, and `auth` subcommands accept `--agent <id>` to target a configured agent. Without it, model inspection uses `agents.defaults.systemAgent.agentId` when configured, otherwise the sole configured agent. Auth mutations require `--agent <id>` when multiple agents are configured.

For `models status`, `OPENCLAW_AGENT_DIR` overrides the inspected auth directory when `--agent` is omitted. A matching configured `agentDir` retains that agent's ownership during credential refresh. An explicit `--agent <id>` takes precedence over the environment override.

`fallbacks`/`image-fallbacks` manage global defaults. `set`, `set-image`, `scan`, `refresh`, and `aliases` also operate globally and reject `--agent`.

`models set` and `models set-image` require the provider to be declared by an installed plugin or configured under `models.providers`. An unknown provider exits nonzero without changing config. If the provider is known but the model is absent from the local catalog, the command saves the selection and prints a warning because newly released and self-hosted models may not be cataloged yet. `openclaw doctor --json` reports configured unknown providers; add `--severity-min info` to also see active models that the local catalog cannot confirm.

Default-model, alias, and fallback changes resolve provider-owned model aliases using the current plugin configuration. When stored entries resolve to the selected model, their settings move to its canonical key; existing canonical settings take precedence. Adding an alias replaces the model's previous alias. If config changes during that preparation, the command rejects the write; rerun it against the updated config.

### Status

Bare `openclaw models` is equivalent to `openclaw models status`.
`openclaw models --json` returns the same object as `openclaw models status --json`.

`openclaw models status` shows the resolved default/fallbacks plus an auth overview. Active profile cooldowns appear under **Unavailable auth profiles** with the stored reason and recovery action; JSON output exposes the same data in `auth.unusableProfiles`. For plugin-owned agent runtimes such as Codex, status also checks whether the owning plugin is enabled and passed startup payload verification. A route with valid credentials but an unavailable runtime reports `status: unavailable` instead of `usable`; JSON output includes separate `authStatus`, `runtimeStatus`, and bounded runtime diagnostics. When provider usage snapshots are available, the OAuth/API-key status section includes provider usage windows and quota snapshots. Current usage-window providers: Anthropic, GitHub Copilot, OpenAI, MiniMax, SuperGrok via xAI OAuth, Xiaomi, and z.ai. Usage auth comes from provider-specific hooks when available; otherwise OpenClaw falls back to matching OAuth/API-key credentials from auth profiles, env, or config.

In `--json` output, `auth.providers` is the env/config/store-aware provider overview, while `auth.oauth` is auth-store profile health only.

Options:

| Flag                      | Effect                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--json`                  | JSON output; auth-profile, provider, and startup diagnostics go to stderr so stdout stays pipeable into `jq`.                            |
| `--plain`                 | Plain text output.                                                                                                                       |
| `--check`                 | Exit non-zero if auth is expiring/expired or a selected agent runtime is unavailable: `1` = unavailable/expired/missing, `2` = expiring. |
| `--probe`                 | Live probe of configured auth profiles. Real requests; may consume tokens and trigger rate limits.                                       |
| `--probe-provider <name>` | Probe one provider only.                                                                                                                 |
| `--probe-profile <id>`    | Probe specific auth profile ids (repeat or comma-separated).                                                                             |
| `--probe-timeout <ms>`    | Per-probe timeout.                                                                                                                       |
| `--probe-concurrency <n>` | Concurrent probes.                                                                                                                       |
| `--probe-max-tokens <n>`  | Probe max tokens (best effort).                                                                                                          |
| `--agent <id>`            | Configured agent id; overrides `OPENCLAW_AGENT_DIR`.                                                                                     |

`--probe-timeout` requires a positive number; `--probe-concurrency` and `--probe-max-tokens` require positive integers. Omit these options to use their defaults (`8000`, `2`, and `8`, respectively); explicitly empty values are rejected.

Probe rows can come from auth profiles, env credentials, or `models.json`. Probe status buckets: `ok`, `auth`, `rate_limit`, `billing`, `timeout`, `format`, `unknown`, `no_model`.

Direct `models status --probe` runs create temporary internal sessions in the selected agent's canonical database, so the command requires exclusive ownership of the configured state directory. Stop a running Gateway with `openclaw gateway stop` before probing; the command removes its internal sessions and releases the state lock when it finishes or is interrupted.

Probe detail/reason codes to expect when a probe never reaches a model call:

- `excluded_by_auth_order`: a stored profile exists, but explicit `auth.order.<provider>` omitted it, so probe reports the exclusion instead of trying it.
- `missing_credential`, `invalid_expires`, `expired`, `unresolved_ref`: profile is present but not eligible or resolvable.
- `ineligible_profile`: profile is incompatible with provider config for another reason.
- `no_model`: provider auth exists, but OpenClaw could not resolve a probeable model candidate for that provider.

For OpenAI ChatGPT/Codex OAuth troubleshooting, `openclaw models status`, `openclaw models auth list --provider openai`, and `openclaw config get agents.defaults.model --json` are the quickest way to confirm whether an agent has a usable `openai` OAuth profile for `openai/*` through the native Codex runtime. See [OpenAI provider setup](/providers/openai#check-and-recover-codex-oauth-routing).

### List

`openclaw models list` is read-only: it reads config, auth profiles, existing catalog state, and provider-owned catalog rows, but never rewrites `models.json`.

`openclaw models refresh [--json]` forces an immediate hosted catalog check. Like `scan`, it rejects `--agent` because the hosted catalog is global, not agent-scoped.
Updated rows apply to a running Gateway after its next restart. The command
prints a clear disabled result when `models.catalogRefresh.enabled` is `false`.
The catalog's public change history lives in
[`openclaw/catalog`](https://github.com/openclaw/catalog), where each content
update is committed by the scheduled publisher.

Options: `--all` (full catalog), `--local` (filter to local models), `--provider <id>`, `--agent <id>`, `--json`, `--plain`. `--agent` selects that agent's auth store, workspace, and provider catalog context; explicit multi-agent fleets do not need a default owner when it is present.

Notes:

- The `Auth` column uses read-only checks. For OpenAI routes, it matches each API and base URL to eligible profiles, credentials, and command-scoped SecretRefs. If route policy is unavailable, an OpenAI row stays unknown instead of using provider-level auth. Other providers and legacy checks use provider-level behavior. For a configured native CLI route, a full or provider-filtered list can run the local auth-status check from the provider. That native result is authoritative; a separate provider credential does not prove the CLI login. The default list stays lazy and shows native CLI authentication as unknown. Synthetic-auth metadata does not prove native account authentication. The command does not load the full provider runtime. It does not read keychain secrets or call provider APIs. It does not prove exact execution readiness.
- `models list --all --provider <id>` can include provider-owned static catalog rows from plugin manifests or bundled provider catalog metadata even when you have not authenticated with that provider yet. Those rows still show as unavailable until matching auth is configured.
- `models list` keeps the control plane responsive while provider catalog discovery is slow. The default and configured views fall back to configured or synthetic model rows after a short wait and let discovery finish in the background. Use `--all` when you need the exact full discovered catalog and are willing to wait for provider discovery.
- Broad `models list --all` merges manifest catalog rows over registry rows without loading provider runtime supplement hooks. Provider-filtered manifest fast paths use only providers marked `static`; providers marked `refreshable` stay registry/cache-backed and append manifest rows as supplements, while providers marked `runtime` stay on registry/runtime discovery.
- `models list` keeps native model metadata and runtime caps distinct. In table output, `Ctx` shows `contextTokens/contextWindow` when an effective runtime cap differs from the native context window; JSON rows include `contextTokens` when a provider exposes that cap.
- For provider-owned routes, `models list` projects one logical provider/model row onto the selected route. `Input` and `Ctx` come only from an exact physical-route catalog row, with explicit configured logical overrides applied last; unresolved route selection shows unknown capability fields instead of borrowing sibling-route metadata.
- Configured model IDs retain their case. For example, `Reader` and `reader` keep separate rows with their own names, context limits, and input types. Provider-declared aliases still apply.
- Models marked `missing` retain their configured aliases in the `Tags` column and JSON `tags`.
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

Numeric scan options reject empty and whitespace-only values. Omit a flag to retain its default behavior.

`--set-default` and `--set-image` require live probes; metadata-only scan results are informational and are not applied to config.

## Aliases

```bash
openclaw models aliases list [--json] [--plain]
openclaw models aliases add <alias> <model-or-alias>
openclaw models aliases remove <alias>
```

Aliases are stored per model entry as `agents.defaults.models.<key>.alias`. `add` resolves `<model-or-alias>` to a canonical provider/model key first, so aliasing an alias repoints it rather than chaining.
Adding an alias does not change `agents.defaults.modelPolicy.allow` or restrict model overrides.

## Fallbacks

```bash
openclaw models fallbacks list [--json] [--plain]
openclaw models fallbacks add <model-or-alias>
openclaw models fallbacks remove <model-or-alias>
openclaw models fallbacks clear
```

Manages `agents.defaults.model.fallbacks`. `openclaw models image-fallbacks list|add|remove|clear` manages the parallel `agents.defaults.imageModel.fallbacks` list with the same subcommand shape.

## Personal model accounts

Use `models accounts` for accounts owned by your signed-in person on the selected Gateway. The CLI and **Settings → Profile → Connected accounts** use the same Gateway account store, including when the server is shared.

| Scope          | Command                                            | Where the credential belongs                                        |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| Personal       | `models accounts login [provider]`                 | Your verified profile on the selected Gateway, which may be remote. |
| System / agent | `models auth login --provider <id> [--agent <id>]` | The OpenClaw installation on the machine running the command.       |

To configure system/agent credentials for a remote server, run `models auth` on that server with its OpenClaw state/config. Configuring a remote Gateway URL on your laptop does not make `models auth` write to the server.

```bash
openclaw models accounts list
openclaw models accounts login
openclaw models accounts login anthropic --method api-key
openclaw models accounts login openai --method device-code
openclaw models accounts login xai --method api-key
openclaw models accounts use <account-id>
openclaw models accounts clear-default <provider>
```

Every account command shows **Gateway**, **Person**, and **Scope: Personal** before accessing accounts or asking for provider credentials. This context goes to stderr so `--json` output stays pipeable. The person is the Gateway's saved, verified profile, not your operating-system username or an unsaved display-name edit.

Gateway access and provider sign-in are separate. Account ownership follows the profile assigned by the Gateway on this connection. Single-user Control UI connections can use the durable **Owner** profile, but short-lived CLI connections are not assigned that profile automatically. The personal-account CLI therefore needs an identity-bearing endpoint, even when the local Control UI already shows **Owner**.

For separate people on a shared server, use its identity-bearing WebSocket endpoint, such as [Tailscale Serve](/gateway/tailscale#tailscale-identity-headers-serve-only) or a [trusted proxy](/gateway/trusted-proxy-auth). Approve device pairing separately if requested: pairing grants device access, not a distinct person's identity. Supplying shared Gateway token/password credentials takes precedence over Tailscale identity authentication. A browser sign-in does not transfer its identity to the CLI. For an identity-aware edge, follow [remote edge authentication](/gateway/remote#gateway-behind-an-identity-aware-proxy).

If no person is identified, the command stops before provider sign-in and explains how to use an identity-bearing endpoint. It does not infer ownership or change Gateway authentication. These commands do not accept `--agent` or an owner id, and they do not modify local shared auth stores or model config. The top-level `openclaw connect` command enrolls a node; it is not a personal-account login.

`list` needs `operator.read` and returns one page of at most 50 saved accounts: id, provider, friendly label, auth type, and whether each is the new-session default. It never returns credentials. Use `--json` for structured output and `list --cursor <nextCursor>` for the next page.

`login`, `use`, and `clear-default` need `operator.write`. `login` requires an interactive terminal and offers the same provider and sign-in methods as **Add account** in the Control UI. Omit the provider to choose from the Gateway's catalog; use `--method <id>` to select a method directly. The catalog includes only methods enabled for personal accounts by their provider plugin, not every system/agent setup method.

Anthropic uses an API key for personal setup, not a Claude subscription token. OpenAI offers API key, browser sign-in, and device-code methods; Grok (`xai`) offers API key and device sign-in. Follow the steps shown by the selected Gateway. Credentials and authorization codes go into protected inputs, never command arguments or chat. During browser sign-in, the CLI keeps checking for completion even while a redirect prompt is open.

Keep the command running until it reports a terminal result. Ctrl-C cancels that exact sign-in attempt and waits for the Gateway's acknowledgment; a closed connection must start a fresh attempt. Saving an account does not by itself prove that a model request will succeed.

`use` selects an already-saved account for new sessions without signing in again. `clear-default` removes only the personal default for that provider: it keeps saved credentials and existing session selections. Neither operation revokes provider access. See [Per-person model accounts](/concepts/multi-user#per-person-model-accounts) for collaborator, fork, and failover behavior.

All account subcommands accept `--url <url>`, `--port <port>`, `--token-file <path>`, `--password-file <path>`, `--timeout <ms>` (default `30000`), and `--json`. The token/password files authenticate the **Gateway**, not the provider, and do not establish a personal identity for this CLI. An explicit `--url` can use an identity-bearing endpoint without supplying a shared token. It does not send ambient or configured shared credentials to the override; configured edge credentials remain bound to their own endpoint. Flags may precede or follow the leaf command:

```bash
openclaw models accounts --timeout 45000 list --json
openclaw models accounts list --timeout 45000 --json
```

## Auth profiles

These commands manage **System / agent** credentials, not personal Gateway accounts. Before provider sign-in, `models auth login` shows the selected agent and that it is operating on the machine running OpenClaw.

Before a `models auth` command changes the local auth store, OpenClaw compares the selected CLI state/config paths with the local Gateway or its installed service. A proven mismatch stops before the write. A remote Gateway or an authenticated path that cannot be verified produces a warning instead.

```bash
openclaw models auth add
openclaw models auth list [--provider <id>] [--json]
openclaw models auth login --provider <id> [--agent <agentId>]
openclaw models auth login --provider openai --profile-id openai:work
openclaw models auth login-github-copilot
openclaw models auth logout <profileId> [--yes]
openclaw models auth paste-api-key --provider <id>
openclaw models auth setup-token --provider <id>
openclaw models auth paste-token --provider <id>
openclaw models auth order get --provider <id>
openclaw models auth order set --provider <id> <profileIds...>
openclaw models auth order clear --provider <id>
```

`models auth add` is the interactive auth helper. It can launch a provider auth flow (OAuth/API key) or guide you into manual token paste, depending on the provider you choose.

`models auth list` lists saved auth profiles for the selected agent without printing token, API-key, or OAuth secret material. Active cooldown and disable entries include their reason and recovery action. Legacy Gemini CLI OAuth cooldowns direct you to the supported Google AI Studio API-key setup instead of offering an unavailable Gemini CLI login flow. Use `--provider <id>` to filter to one provider, such as `openai`, and `--json` for scripting.

`models auth login` runs a provider plugin's auth flow (OAuth/API key). Use `openclaw plugins list` to see which providers are installed. `login` accepts `--profile-id <id>` for providers that support named profiles during login (use this to keep multiple logins for the same provider separate), `--method <id>` to pick a specific auth method, `--device-code` as a shortcut for `--method device-code`, `--set-default` to apply the provider's recommended default model, and `--force` to remove existing profiles for that provider first (use when a cached OAuth profile is stuck or you want to switch accounts).

For the shared-main agent, `--force` clears the provider's shared credentials and main-agent local overrides, including their order and health state. For another agent it clears only that agent's local profiles, leaving shared credentials unchanged. A busy auth store stops the command before login starts; close other OpenClaw commands using the same state directory and retry. SQLite lock diagnostics can name either the shared state database or an agent database, so checking only the legacy auth file for open handles does not rule out contention.

`models auth logout <profileId>` removes one saved auth profile from the selected agent auth store. Use the profile id shown by `models auth list`. It also drops that profile from `auth.profiles` and from every `auth.order` list in your config, so no stale reference is left behind, and it deletes an `auth.order.<provider>` entry that would otherwise be emptied (an authored empty order means "select no profiles" and would disable the provider). It prompts for confirmation on a TTY; pass `--yes` for scripts and agents. Logout refuses when the profile is not in the store, or when a `models.providers.<id>.apiKey` entry names it — change that config value first.

`models auth login-github-copilot` is a shortcut for `models auth login --provider github-copilot --method device` (GitHub device flow); it accepts `--yes` to overwrite an existing profile without prompting.

Use either `openclaw models auth --agent <id> <subcommand>` or `openclaw models auth <subcommand> --agent <id>` to target a specific configured agent store. Both forms are supported by `add`, `list`, `login`, `logout`, `paste-api-key`, `setup-token`, `paste-token`, `login-github-copilot`, and `order get`/`set`/`clear`.

For OpenAI models, `--provider openai` defaults to ChatGPT/Codex account login. Use `--method api-key` only when you want to add an OpenAI API-key profile, usually as a backup for Codex subscription limits. Run `openclaw doctor --fix` to migrate older legacy OpenAI Codex prefix auth/profile state to `openai`.

Examples:

```bash
openclaw models auth login --provider openai --set-default
openclaw models auth login --provider openai --method api-key
openclaw models auth paste-api-key --provider openai
openclaw models auth list --provider openai
openclaw models auth logout openai:manual --yes
```

Notes:

- `paste-api-key` accepts API keys generated elsewhere, prompts for the key value, and writes it to the default profile id `<provider>:manual` unless you pass `--profile-id`. In automation, pipe the key on stdin, for example `printf "%s\n" "$OPENAI_API_KEY" | openclaw models auth paste-api-key --provider openai`.
- `setup-token` and `paste-token` remain generic token commands for providers that expose token auth methods.
- `setup-token` requires an interactive TTY and runs the provider's token-auth method (defaulting to that provider's `setup-token` method when it exposes one).
- `paste-token` requires `--provider`, prompts for the token value by default, and writes it to the default profile id `<provider>:manual` unless you pass `--profile-id`. In automation, pipe the token on stdin instead of passing it as an argument so provider credentials do not appear in shell history or process lists.
- `paste-token --expires-in <duration>` stores an absolute token expiry from a relative duration such as `365d` or `12h`.
- For `openai`, OpenAI API keys and ChatGPT/OAuth token material are different auth shapes. Use `paste-api-key` for `sk-...` OpenAI API keys and `paste-token` only for token auth material.
- Anthropic: `setup-token`/`paste-token` are supported OpenClaw auth paths for `anthropic`, but OpenClaw prefers reusing the Claude CLI (`claude -p`) on the host when it is available.
- `auth order get/set/clear` manages a per-agent auth profile order override for one provider in the SQLite auth store, separate from the `auth.order.<provider>` config key. `set` takes one or more profile ids in priority order. The stored order takes precedence over config for profile selection and CLI runtime routing; `clear` falls back to config/round-robin ordering.

## Related

- [CLI reference](/cli)
- [Model selection](/concepts/model-providers)
- [Model failover](/concepts/model-failover)
