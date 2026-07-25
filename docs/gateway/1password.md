---
summary: "Resolve Gateway secrets with the 1Password CLI and let agents use the bundled 1password skill"
read_when:
  - You want API keys out of openclaw.json and inside 1Password
  - You run the Gateway headless and need service account auth for op
  - You want agents to read or inject secrets with the op CLI
title: "1Password"
---

OpenClaw pairs with **1Password** in three independent ways:

- **Config secrets:** any [SecretRef](/gateway/secrets) field in `openclaw.json` can resolve through the `op` CLI at runtime, so API keys never live in the config file.
- **Agent workflows:** the bundled `1password` skill teaches agents to sign in and read or inject secrets with `op` for their own tasks.
- **Browser sign-in:** the `claude-cli` backend can use Claude Code's Chrome integration with [1Password for Claude](https://support.1password.com/1password-claude/), letting the agent sign in to websites without the password ever reaching the model or OpenClaw.

## Requirements

- The [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) installed on the Gateway host (`brew install 1password-cli` on macOS).
- An auth mode for `op`:
  - **Service account** (recommended for headless Gateways): export `OP_SERVICE_ACCOUNT_TOKEN` in the Gateway service environment. No desktop app, no interactive sign-in.
  - **Desktop app integration**: the 1Password app runs on the same machine with CLI integration enabled. First calls may trigger Touch ID or system auth.
  - **Standalone sign-in**: `op signin` prompts per session. Workable for agents through the skill, but not suited for config secret resolution on a headless Gateway.

## Resolve config secrets with op

Declare an exec secret provider that runs `op read` with an `op://vault/item/field` reference, then point any SecretRef-capable field at it:

```json5
{
  secrets: {
    providers: {
      onepassword_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/op",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["read", "op://Personal/OpenClaw QA API Key/password"],
        passEnv: ["HOME"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "onepassword_openai", id: "value" },
      },
    },
  },
}
```

How the pieces fit:

- `command` must be an absolute path; `trustedDirs` marks its directory as trusted, and `allowSymlinkCommand` is needed because Homebrew installs `op` as a symlink.
- `args` carries the `op://vault/item/field` reference verbatim. OpenClaw does not parse the `op://` scheme itself; the `op` binary resolves it.
- `passEnv` forwards the listed variables from the Gateway environment. Desktop app integration needs `HOME`; service accounts also need `OP_SERVICE_ACCOUNT_TOKEN` present in the Gateway service environment (add it to `passEnv`, or set it via `env` only if you accept the token being readable in the config file).
- For single-value output keep `id: "value"`. With `jsonOnly: true` and a JSON payload, address fields with a JSON pointer id instead.
- One provider entry per secret keeps references auditable; name providers after their consumer (`onepassword_openai`, `onepassword_telegram`).

See [Gateway secrets](/gateway/secrets) for resolution order, caching, and failure semantics, and [SecretRef Credential Surface](/reference/secretref-credential-surface) for every field that accepts SecretRefs.

## Service account setup for headless Gateways

1. Create a service account in your 1Password account and grant it read access to only the vault items the Gateway needs.
2. Provide `OP_SERVICE_ACCOUNT_TOKEN` to the Gateway service (launchd plist, systemd unit, or container env).
3. Add `"OP_SERVICE_ACCOUNT_TOKEN"` to the provider `passEnv` list.
4. Verify from the Gateway host environment: `op whoami` should print the service account without prompting.

Service account reads require the vault to be named explicitly in the `op://` reference. Scope the account tightly; it is a bearer credential.

## The 1password skill for agents

OpenClaw bundles a `1password` skill that turns agents into competent `op` operators: it detects the available auth mode (service account, desktop app integration, or standalone sign-in), verifies access with `op whoami` before reading anything, and prefers `op run` / `op inject` over writing secret values to disk. The skill requires the `op` binary and offers a Homebrew install when it is missing.

Agents use it for their own workflows, for example reading a deploy token mid-task or injecting env vars into a command. It is independent of config secret resolution; the Gateway resolves SecretRefs without any skill involved.

## Browser sign-in with 1Password for Claude

[1Password for Claude](https://support.1password.com/1password-claude/) lets Claude request a login while the 1Password browser extension fills the credential directly into the page over an encrypted channel. The secret never enters the model context, the transcript, or OpenClaw. When OpenClaw runs the [`claude-cli` backend](/gateway/cli-backends#claude-cli-specifics) with Claude Code's Chrome integration enabled, agent tasks can use that flow for websites that need a real signed-in session.

What this requires, beyond the backend itself:

- A macOS gateway host with Chrome, the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome) connected, the 1Password desktop app, and the 1Password browser extension (both 8.12.28 or later).
- Claude Code signed in to a direct Anthropic plan (Pro, Max, Team, or Enterprise). Chrome integration is not available through Amazon Bedrock, Google Cloud, or other third-party providers.
- The one-time 1Password connection on the Anthropic side: 1Password for Claude is set up through the Claude desktop app or extension flow described in [1Password's guide](https://support.1password.com/1password-claude/), and it is currently a macOS beta. On 1Password Business, an administrator must first enable "Allow AI agents to autofill for users" under Policies; Anthropic Team/Enterprise plans also ship with the integration off until an Owner enables it.
- A [CLI backend plugin](/plugins/cli-backend-plugins) that adds `--chrome` to the Claude launch args; the bundled backend does not enable Chrome.
- A person at the gateway host: every credential use shows a 1Password prompt confirmed there (for example with Touch ID). Under a restrictive exec policy the browser tool calls themselves are also relayed to your channel as OpenClaw approvals first.

Before wiring this into OpenClaw, verify the pieces in an interactive session on the gateway host: run `claude --chrome`, confirm the extension connects, and check that the `claude-in-chrome` tools include the credential tools. If they do not appear there, they will not appear through OpenClaw either.

One-time passcodes are filled by 1Password on the same page; never relay verification codes or passwords through chat. Headless or remote gateways cannot use this flow today because the approval and the browser both live on the gateway host.

## Security notes

- Secret values resolved through exec providers stay in Gateway memory; config snapshots and `config.get` responses redact SecretRef fields.
- Never place secret values in `openclaw.json`, logs, or chat. Keep item names in config, values in 1Password.
- The 1Password audit trail shows every service account read, which makes key rotation and incident review practical.

## Troubleshooting

- `command not found` or spawn errors: use the absolute `op` path and include its directory in `trustedDirs`.
- `op` resolves but reads fail with symlink errors: set `allowSymlinkCommand: true` for Homebrew installs.
- `account is not signed in`: for service accounts, confirm `OP_SERVICE_ACCOUNT_TOKEN` reaches the Gateway service and is listed in `passEnv`; for desktop integration, confirm the app is running and unlocked.
- Slow first reads: raise `timeoutMs` on the provider; `op` cold starts can exceed strict timeouts on busy hosts.
