---
summary: "CLI reference for `openclaw setup` (system-agent chat with onboarding fallback)"
read_when:
  - You want to chat with OpenClaw for setup or repair
  - You're doing first-run setup with the onboarding wizard
  - You want to set the default workspace path
  - You need the baseline-only setup flag for scripts
title: "Setup"
---

# `openclaw setup`

`openclaw setup` is the system-agent entry point. On a configured system, bare
`openclaw setup` opens an interactive OpenClaw chat. On a fresh system, it
falls through to guided onboarding. Use `-m`/`--message` for one request or
`--baseline` to initialize config/workspace folders without the wizard.

Routing order:

1. Any onboarding option (`--wizard`, `--baseline`, workspace, reset,
   non-interactive, flow, mode, Gateway, daemon, skip, import, remote, or auth
   options) runs onboarding exactly as `openclaw onboard` does.
2. `-m`/`--message` or `--yes` runs the system agent.
3. With no routing option, a configured interactive system opens OpenClaw. A
   fresh system runs onboarding. On a configured system, `--json` prints the
   system overview even without a TTY; an onboarding option keeps onboarding's
   JSON summary.

In guided mode, `--workspace <dir>` is the workspace proposed to OpenClaw;
it is persisted only after you approve that proposal. Baseline, classic, and
noninteractive setup persist the supplied workspace through their normal flow.

Guided inference detection runs on the Gateway host on macOS or Linux. The CLI
and macOS app call the same Gateway-owned detector, which checks configured
models, supported CLI logins, API-key environment variables, and already
installed Ollama or LM Studio models. Local models are never downloaded by this
automatic pass; the selected candidate must answer a real completion before its
provider and model configuration is saved.

`setup` accepts the same onboarding flags as `openclaw onboard`, including
auth (`--auth-choice`, `--token`, provider key flags), Gateway
(`--gateway-port`, `--gateway-bind`, `--gateway-auth`, `--install-daemon`),
Tailscale (`--tailscale`), reset (`--reset`, `--reset-scope`), flow
(`--flow quickstart|advanced|manual|import`), and skip flags
(`--skip-channels`, `--skip-skills`, `--skip-bootstrap`, `--skip-search`,
`--skip-health`, `--skip-ui`, `--skip-hooks`). See [Onboard](/cli/onboard) and
[CLI automation](/start/wizard-cli-automation) for the full flag reference and
non-interactive examples. `openclaw onboard --modern` remains a compatibility
entry for the same inference-gated OpenClaw assistant.

<Note>
`openclaw setup` is for mutable config installs. In Nix mode (`OPENCLAW_NIX_MODE=1`) OpenClaw refuses setup writes because the config file is managed by Nix. Use the first-party [nix-openclaw Quick Start](https://github.com/openclaw/nix-openclaw#quick-start) or the equivalent source config for another Nix package.
</Note>

## Options

| Flag                       | Description                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `-m, --message <text>`     | Run one OpenClaw request.                                                                             |
| `--yes`                    | Approve persistent config writes for one `--message` request.                                         |
| `--workspace <dir>`        | Workspace proposal in guided mode; persisted directly by baseline, classic, and noninteractive setup. |
| `--baseline`               | Create baseline config/workspace/session folders without onboarding.                                  |
| `--wizard`                 | Force interactive onboarding.                                                                         |
| `--non-interactive`        | Run onboarding without prompts.                                                                       |
| `--accept-risk`            | Acknowledge full-system agent access risk; required with `--non-interactive`.                         |
| `--mode <mode>`            | Onboarding mode: `local` or `remote`.                                                                 |
| `--flow <flow>`            | Onboard flow: `quickstart`, `advanced`, `manual`, or `import`.                                        |
| `--reset`                  | Reset config + credentials + sessions before onboarding (workspace only with `--reset-scope full`).   |
| `--reset-scope <scope>`    | Reset scope: `config`, `config+creds+sessions`, or `full`.                                            |
| `--import-from <provider>` | Migration provider to run during onboarding.                                                          |
| `--import-source <path>`   | Source agent home for `--import-from`.                                                                |
| `--import-secrets`         | Import supported secrets during onboarding migration.                                                 |
| `--remote-url <url>`       | Remote Gateway WebSocket URL.                                                                         |
| `--remote-token <token>`   | Remote Gateway token (optional).                                                                      |
| `--json`                   | Configured system: OpenClaw overview. Onboarding route: onboarding summary.                           |

`--classic` and `--non-interactive` are mutually exclusive: classic opens the
prompted wizard, while noninteractive setup uses the automation path.

### Baseline mode

`openclaw setup --baseline` preserves the older baseline-only behavior: it
creates the config, workspace, and session directories, then exits without
running onboarding.

## Examples

```bash
openclaw setup
openclaw setup -m "status"
openclaw setup -m "restart gateway" --yes
openclaw setup --json
openclaw setup --wizard
openclaw setup --baseline
openclaw setup --workspace ~/.openclaw/workspace
openclaw setup --import-from hermes --import-source ~/.hermes
openclaw setup --non-interactive --accept-risk --mode remote --remote-url wss://gateway-host:18789 --remote-token <token>
```

## Notes

- After baseline setup, run `openclaw onboard` for the full guided journey, `openclaw configure` for targeted changes, or `openclaw channels add` to add channel accounts.
- If Hermes state is detected, interactive onboarding can offer migration automatically. Import onboarding requires a fresh setup; use [Migrate](/cli/migrate) for dry-run plans, backups, and overwrite mode outside onboarding.

## Related

- [CLI reference](/cli)
- [Onboard](/cli/onboard)
- [Onboarding (CLI)](/start/wizard)
- [Getting started](/start/getting-started)
- [Install overview](/install)
