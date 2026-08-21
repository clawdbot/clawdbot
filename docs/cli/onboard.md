---
summary: "CLI reference for `openclaw onboard` (interactive onboarding)"
read_when:
  - You want to establish inference, then finish setup with OpenClaw
title: "Onboard"
---

# `openclaw onboard`

Guided setup that establishes inference first: it detects existing AI access,
requires a live completion, persists only the working route, and then starts
OpenClaw to configure the rest. `openclaw setup` reaches this flow on fresh
systems or whenever an onboarding option is present; configured systems use
bare `openclaw setup` for system-agent chat. `openclaw setup --baseline` only
writes the baseline config/workspace.

<CardGroup cols={2}>
  <Card title="CLI onboarding hub" href="/start/wizard" icon="rocket">
    Walkthrough of the interactive CLI flow.
  </Card>
  <Card title="Onboarding overview" href="/start/onboarding-overview" icon="map">
    How OpenClaw onboarding fits together.
  </Card>
  <Card title="CLI setup reference" href="/start/wizard-cli-reference" icon="book">
    Outputs, internals, and per-step behavior.
  </Card>
  <Card title="CLI automation" href="/start/wizard-cli-automation" icon="terminal">
    Non-interactive flags and scripted setups.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding" icon="apple">
    Onboarding flow for the macOS menu bar app.
  </Card>
</CardGroup>

## Examples

```bash
openclaw onboard
openclaw onboard --tui
openclaw onboard --classic
openclaw onboard --modern
openclaw onboard --flow quickstart
openclaw onboard --agent-name robby
openclaw onboard --flow manual
openclaw onboard --flow import
openclaw onboard --import-from hermes --import-source ~/.hermes
openclaw onboard --skip-bootstrap
openclaw onboard recommendations --json
openclaw onboard recommendations acknowledge
openclaw onboard recommendations acknowledge --retry "<failed-id>"
openclaw onboard recommendations refresh
openclaw onboard --mode remote --remote-url wss://gateway-host:18789
```

`openclaw onboard recommendations` reads pending app-recommendation matches
stored during onboarding. Add `--json` for the machine-readable list used by
the first-run bootstrap. The command does not rescan installed apps or call a
model. Its output contains only validated install IDs, source, and tier; it
intentionally omits untrusted marketplace prose, model reasons, and local app
labels. After the recommendation offer has been answered, the command returns
an empty list and future onboarding runs skip the step entirely.
`openclaw onboard recommendations refresh` clears the stored offer so the next
onboarding run rescans installed apps and creates a new offer.

Fresh workspaces defer the recommendation choice to the bootstrap conversation.
After that conversation handles the user's choices,
`openclaw onboard recommendations acknowledge` marks the stored offer answered.
The acknowledgement is idempotent. If a chosen install fails, pass each failed
opaque ID with `--retry <id...>`; successful and declined matches are consumed,
while failed matches remain pending for a later onboarding run. Unknown IDs
fail without changing the stored offer. After an interrupted ClawHub skill
install, an existing target counts as successful only when
`openclaw skills verify "@owner/slug"` succeeds for the same
publisher-qualified recommendation ID and its JSON output reports
`openclaw.resolution.source: "installed"`. Registry verification alone is not
proof of a local install. Otherwise keep that ID pending with `--retry` and do
not overwrite the existing skill.

- `--classic`: opens the full step-by-step wizard. It cannot be combined with
  `--non-interactive`; omit `--classic` for automated setup.
- `--agent-name <name>`: names the first agent when no roster exists. Interactive
  onboarding asks **What should we call your first agent?** and suggests `main`;
  non-interactive onboarding keeps `main` unless this flag is provided. The id
  `main` is not reserved: if you later recreate it beside a named agent, run
  `openclaw doctor --fix` first when creation reports legacy-session or
  shared-auth ownership still attached to the old `main` installation.
- `--flow quickstart`: opens the classic wizard with minimal prompts, uses
  token auth by default, and generates a token when no stored or explicit
  credential applies. Explicit local Gateway flags such as
  `--gateway-port`, `--gateway-bind`, `--gateway-auth`, and `--tailscale`
  override the corresponding stored or default quickstart values; omitted
  options keep their current values.
- `--flow manual` (alias `advanced`): opens the classic wizard's **Manual
  setup** flow with full prompts for port, bind, and auth.
- `--flow import`: runs a detected migration provider (for example Hermes via `--import-from hermes`) against a fresh setup. After confirmation, onboarding stages config, credentials, workspace files, memory, and skills under private temporary targets; imported inference must pass a live completion before workspace and agent state are promoted and configuration is committed. Failure or cancellation before promotion leaves the live target untouched. External activation steps that cannot be rolled back, such as Codex plugin installation, run afterward and remain retryable from the migration report. Migration import options (`--flow import`, `--import-from`, `--import-source`, and `--import-secrets`) cannot be combined with `--reset`; run the import without `--reset`. Use [`openclaw migrate`](/cli/migrate) for dry-run plans, overwrite mode, verified backups, reports, and exact mappings.
- `--remote-url`, `--remote-token`, and `--remote-password`: prefill the classic remote Gateway step and override stored remote values for this run. Pass either a token or a password, not both. Changing the URL does not reuse stored credentials unless you also provide a new token or password. Credentials stay masked in prompts and follow the wizard's existing plaintext or SecretRef storage choice.
- `--modern` is a compatibility alias for the OpenClaw conversational setup
  assistant. It uses the same live-inference gate as `openclaw setup` and
  accepts only `--workspace`, `--agent-name`, `--accept-risk`,
  `--non-interactive`, and `--json`. Other setup flags are rejected instead of
  being silently ignored.

## Guided flow

Plain `openclaw onboard` starts the guided flow. It shows the security notice,
asks for the first agent's name when no roster exists, then asks one discovery
question up front: **full access** (recommended — setup looks for
AI apps, keys, and local runtimes automatically) or **ask first** (setup asks
once before looking around, or lets you configure manually). The
choice persists as `wizard.accessMode`. With discovery allowed, onboarding
detects AI access already available through configured models, API-key
environment variables, and supported local CLIs, then tests the recommended
candidate with a real completion. If a candidate fails, onboarding quietly
tries the next usable one and summarizes anything that did not respond in a
single line; the working route is announced with a one-keystroke option to see
everything else instead.

If automatic detection is exhausted, the provider picker shows OpenAI,
Anthropic, xAI (Grok), Google, and OpenRouter first. Choose **More…** for every
other supported provider, grouped by provider; regions, plans, and auth methods
then appear in a second menu. Supported browser or device sign-in and masked
API-key or token methods use the same live completion path. OpenClaw persists
only the verified model route and its credential after the test succeeds; a
failed candidate does not replace the configured model or save the attempted
credential. Choose **Skip for now** to exit without starting OpenClaw and
rerun `openclaw onboard` when you are ready. Workspace and Gateway setup remain
unchanged until OpenClaw starts.

In guided mode, `--workspace <dir>` supplies OpenClaw's proposed workspace
and the isolated inference context. It is not persisted until you approve the
OpenClaw setup proposal. Classic and noninteractive onboarding persist their
workspace through their normal setup flow. On a rerun with an existing agent
roster, onboarding preserves the configured fleet workspace: the classic
wizard shows both paths and requires explicit confirmation before moving it,
while non-interactive setup warns and keeps the current value.

After inference passes, onboarding checks for memories from supported local AI
tools: Claude Code auto-memory, Codex consolidated memories, and Hermes memory
files. When it finds any, one page offers to copy them into the agent workspace
under `memory/imports/` for indexed recall. Nothing is imported without
confirmation, previously imported files are skipped, and you can always import
later from the Control UI [Memory import page](/web/control-ui), which offers
the same memory-only scope. (A full [`openclaw migrate`](/cli/migrate) run is
broader: it can also import config, skills, and credentials.) The classic
wizard shows the same page after it prepares the workspace.

After inference passes (and the memory-import offer), guided onboarding
applies the standard setup automatically — workspace, Gateway, and sessions,
the same plan the conversational `openclaw setup` chat would apply on "yes" —
then offers plugin and skill recommendations from installed apps; app names
are matched through your configured model and ClawHub search, and the step can
be disabled with [`wizard.appRecommendations`](/gateway/configuration-reference#wizard).
When the platform has a supported browser opener, it then opens the authenticated
Control UI dashboard and waits up to 60 seconds for the browser client to
connect. The short-lived handoff gives that exact signed browser a durable
administrator credential. This includes display-less WSL when `wslview` is installed.
On headless Linux, WSL without an opener, or over SSH without a display, it prints a prominent
copy-pasteable dashboard URL, including an SSH port-forward command for a
loopback Gateway, and waits up to five minutes. A successful connection
continues in the browser; an unreachable Gateway or a timeout falls back to the
same terminal hatch as before. Pass `--tui` to skip the browser handoff and
force that terminal hatch.
If applying setup fails, onboarding falls back to the conversational OpenClaw
chat to finish interactively. Channels, agents,
plugins, and other optional features remain OpenClaw chat territory: run
`openclaw` and use `open channel wizard for <channel>` to hand channel
credential collection to a masked terminal wizard. To change the model
provider or its authentication, exit OpenClaw and run `openclaw onboard`;
OpenClaw does not open the guided or classic provider flows.

On a configured install, running `openclaw onboard` again verifies the current
default model first, so the same flow acts as a verification and repair pass —
it does not re-apply setup, reinstall, or restart the Gateway service.
If that check fails, the configured model is never replaced automatically —
onboarding stops and asks how to continue. The check runs outside your
workspace, so a model provided by a workspace plugin can fail here while still
working in the agent.
Use `openclaw onboard --classic` for provider-specific auth, channels, skills,
remote Gateway setup, imports, or full Gateway controls. For conversational
non-inference setup and repair, run `openclaw setup`; `openclaw onboard
--modern` is a compatibility alias through the same inference gate. The classic
wizard can optionally verify the default model with a live completion, but
OpenClaw will not start until its own live inference check passes.

In an interactive terminal, bare `openclaw` (no subcommand) routes by config
state:

- If the active config file is missing or has no authored settings (empty or
  metadata-only), it starts guided onboarding.
- If the config file exists but fails validation, it starts the classic
  onboarding path with `openclaw doctor` guidance. OpenClaw needs working
  inference and is not used to repair this pre-inference state.
- If the config file is valid, it opens the normal agent TUI. A reachable
  configured Gateway with an agent and model goes directly to that UI without
  onboarding or OpenClaw. On a configured install, reach OpenClaw with
  `/openclaw` inside the TUI or `openclaw setup`.

Plaintext `ws://` is accepted for loopback, private IP literals, `.local`, and Tailnet `*.ts.net` gateway URLs. For other trusted private-DNS names, set `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` in the onboarding process environment.

## Reset

```bash
openclaw onboard --reset
openclaw onboard --reset --reset-scope full
```

`--reset` is a destructive pre-dispatch flag, not a choice in the classic
wizard's **Setup mode** menu. `--reset-scope` controls how much it removes:
`config` (config only), `config+creds+sessions` (default when `--reset` is
passed without a scope), or `full` (also resets the workspace). Before moving
state to Trash, onboarding validates TTY availability, the reset scope, auth
and Gateway options, migration import options, and the workspace target for a
full reset. Migration import options cannot be combined with `--reset`; run the
import without `--reset`. Non-interactive setup also requires `--accept-risk` before reset.
Interactive classic setup performs reset before showing its risk
acknowledgement, so invoking `--reset` can move state to Trash before you can
decline that prompt. After reset, the command runs guided, classic, or
non-interactive onboarding according to the other flags.

## Locale

Interactive onboarding uses the CLI wizard locale for fixed setup copy. It uses the first nonblank value in this order:

1. `OPENCLAW_LOCALE`
2. `LC_ALL`
3. `LC_MESSAGES`
4. `LANG`
5. English fallback

Supported wizard locales are `en`, `zh-CN`, and `zh-TW`. Locale values may use underscore or POSIX suffix forms such as `zh_CN.UTF-8`. Product names, command names, config keys, URLs, provider IDs, model IDs, and plugin/channel labels remain literal.

```bash
OPENCLAW_LOCALE=zh-CN openclaw onboard
OPENCLAW_LOCALE=en openclaw onboard # Explicit English override
```

## Non-interactive setup

`--non-interactive` requires `--accept-risk` (acknowledges that agents are powerful and full system access is risky). `--mode` defaults to `local`.

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --agent-name robby \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --secret-input-mode plaintext \
  --custom-compatibility openai \
  --custom-image-input
```

`--custom-api-key` is optional; if omitted, onboarding checks `CUSTOM_API_KEY` in env. OpenClaw marks common vision model IDs (GPT-4o/4.1/5.x, Claude 3/4, Gemini, Qwen-VL, LLaVA, Pixtral, and similar) as image-capable automatically. Pass `--custom-image-input` for unknown custom vision IDs, or `--custom-text-input` to force text-only metadata. Use `--custom-compatibility openai-responses` for OpenAI-compatible endpoints that support `/v1/responses` but not `/v1/chat/completions`; valid values are `openai` (default), `openai-responses`, `anthropic`.

LM Studio also has a provider-specific key flag:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice lmstudio \
  --custom-base-url "http://localhost:1234/v1" \
  --custom-model-id "qwen/qwen3.5-9b" \
  --lmstudio-api-key "$LM_API_TOKEN"
```

Non-interactive Ollama:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice ollama \
  --custom-base-url "http://ollama-host:11434" \
  --custom-model-id "qwen3.5:27b"
```

`--custom-base-url` defaults to `http://127.0.0.1:11434`. `--custom-model-id` is optional; if omitted, onboarding uses Ollama's suggested defaults. Cloud model IDs such as `kimi-k2.5:cloud` also work here.

Store provider keys as refs instead of plaintext:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice openai-api-key \
  --secret-input-mode ref
```

With `--secret-input-mode ref`, onboarding stores new credentials as refs instead of plaintext: auth profiles use `keyRef: { source: "env", provider: "default", id: <envVar> }`, and custom providers use `models.providers.<id>.apiKey` (for example `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`). Set the provider env var when adding a new credential; an inline key flag without its matching env var fails fast. Existing resolvable named auth profiles and their `env`, `file`, `exec`, or `store` references are reused unchanged, without a new `apiKey` or `keyRef` write or additional provider env var. Existing plaintext profile credentials are not migrated; run `openclaw secrets configure --apply`, then `openclaw secrets audit --check`. See [Secrets management](/gateway/secrets).

### Gateway auth (non-interactive)

- `--gateway-auth token --gateway-token <token>` stores a plaintext token. `token` is the default auth mode.
- `--gateway-auth token --gateway-token-ref-env <name>` stores `gateway.auth.token` as an env SecretRef. Requires a non-empty env var of that name in the onboarding process environment.
- `--gateway-token` and `--gateway-token-ref-env` are mutually exclusive.
- Remote onboarding uses `--remote-token <token>` or `--remote-password <password>` for `gateway.remote` credentials. `--gateway-password` configures local Gateway auth and is not valid in remote mode.
- With `--secret-input-mode ref`, non-interactive `--gateway-password` and `--remote-password` require a matching `OPENCLAW_GATEWAY_PASSWORD`, and `--remote-token` requires a matching `OPENCLAW_GATEWAY_TOKEN`; onboarding stores an env SecretRef and rejects missing or mismatched values before changing state. Interactive setup can also select configured file, exec, or store refs.
- With `--install-daemon`: a SecretRef-managed `gateway.auth.token` is validated but not persisted as resolved plaintext in supervisor service environment metadata; if the ref is unresolved, install fails closed with remediation guidance. If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, install blocks until mode is set explicitly.
- Local onboarding writes `gateway.mode="local"` into the config. A later config file missing `gateway.mode` indicates config damage or an incomplete manual edit, not a valid local-mode shortcut.
- Local onboarding installs downloadable plugins the chosen setup path requires (for example a Codex or Copilot runtime plugin for those auth choices). Remote onboarding only writes connection info for the remote Gateway - it never installs local plugin packages.
- `--allow-unconfigured` is a separate `openclaw gateway run` escape hatch; it does not let onboarding skip `gateway.mode`.

```bash
export OPENAI_API_KEY="your-provider-key"
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN
```

### Local gateway health

- Unless you pass `--skip-health`, onboarding waits for a reachable local gateway before exiting successfully.
- `--install-daemon` starts the managed gateway install path first. With no daemon flag, a local gateway must already be running (for example `openclaw gateway run`).
- Explicit `--skip-daemon` or `--no-install-daemon` still probes for an existing gateway. If none is listening, setup reports that the gateway was not started and exits successfully; a reachable but unhealthy gateway still fails the health check.
- `--skip-health` skips the wait if you only want config/workspace/bootstrap writes in automation.
- `--skip-bootstrap` sets `agents.defaults.skipBootstrap: true` and skips creating `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, and `BOOTSTRAP.md`.
- On native Windows, `--install-daemon` tries Scheduled Tasks first and falls back to a per-user Startup-folder login item if task creation is denied.

### Interactive ref mode

- Choose **Use secret reference** when prompted, then either **Environment variable** or a configured secret provider (`file` or `exec`).
- Onboarding runs a fast preflight validation before saving the ref and lets you retry on failure.

### Z.AI endpoint choices

<Note>
`--auth-choice zai-api-key` auto-detects the best Z.AI endpoint and model for your key: Coding Plan endpoints prefer `zai/glm-5.2` (falling back to `glm-5.1` if unavailable); general API endpoints default to `zai/glm-5.1`. To force a Coding Plan endpoint, pick `zai-coding-global` or `zai-coding-cn` directly.
</Note>

```bash
# Promptless endpoint selection
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# Other Z.AI endpoint choices: zai-coding-cn, zai-global, zai-cn
```

Mistral:

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice mistral-api-key \
  --mistral-api-key "$MISTRAL_API_KEY"
```

## Additional non-interactive flags

Token-based model auth (used with `--auth-choice token`):

| Flag                            | Description                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--token-provider <id>`         | Token provider id issuing the token                                                                                         |
| `--token <token>`               | Token value for model authentication                                                                                        |
| `--token-profile-id <id>`       | Auth profile id (default `<provider>:manual`; some provider-owned flows use their own default, such as `anthropic:default`) |
| `--token-expires-in <duration>` | Optional token expiry duration (e.g. `365d`, `12h`)                                                                         |

Cloudflare AI Gateway: `--cloudflare-ai-gateway-account-id <id>`, `--cloudflare-ai-gateway-gateway-id <id>`.

Daemon install control: `--no-install-daemon` / `--skip-daemon` (aliases; skip gateway service install), `--daemon-runtime <node>`.

Skills: `--node-manager <npm|pnpm|bun>` (default `npm`), `--skip-skills`.

UI and hook setup: `--skip-ui` (skip Control UI/TUI prompts), `--skip-hooks` (skip webhook/hook setup), `--skip-channels`, `--skip-search`.

Output: `--suppress-gateway-token-output` disables the automatic Control UI handoff in guided onboarding. Classic onboarding never prints reusable Gateway token values or tokenized URLs; it still prints safe recovery commands.

<Note>
`--json` does not imply non-interactive mode in guided or classic onboarding.
With `--modern`, JSON is a one-shot OpenClaw overview and exits after that
single result. Use `--non-interactive` for other scripts.
</Note>

## Provider prefiltering

When an auth choice implies a preferred provider, onboarding prefilters the default-model and allowlist pickers to that provider's models. The filter also matches other providers owned by the same plugin, which covers coding-plan variants such as `volcengine`/`volcengine-plan` and `byteplus`/`byteplus-plan`. If the preferred-provider filter yields no loaded models, onboarding falls back to the unfiltered catalog instead of leaving the picker empty.

## Web-search follow-ups

Some web-search providers trigger provider-specific follow-up prompts during onboarding:

- **Grok** can offer optional `x_search` setup with the same xAI auth and an `x_search` model choice.
- **Kimi** can ask for the Moonshot API region (`api.moonshot.ai` vs `api.moonshot.cn`) and the default Kimi web-search model.

## Other behaviors

- Local onboarding DM scope behavior: [CLI setup reference](/start/wizard-cli-reference#outputs-and-internals).
- Fastest first chat: `openclaw dashboard` (Control UI, no channel setup).
- Custom provider: connect any OpenAI- or Anthropic-compatible endpoint, including hosted providers not listed. Use **Unknown** compatibility to auto-detect via a live probe.
- If Hermes state is detected, onboarding offers a migration flow (see `--flow import` above).

## Common follow-up commands

Use `openclaw configure` later for targeted non-inference changes and `openclaw
channels add` for channel-only setup. For model provider or auth route changes,
run `openclaw onboard` instead.

```bash
openclaw channels add
openclaw configure
openclaw agents add <name>
```
