---
summary: "Resolve Gateway secrets with the 1Password CLI and let agents use the bundled 1password skill"
read_when:
  - You want API keys out of openclaw.json and inside 1Password
  - You run the Gateway headless and need service account auth for op
  - You want agents to read or inject secrets with the op CLI
title: "1Password"
---

OpenClaw pairs with **1Password** in two independent ways:

- **Config secrets:** any [SecretRef](/gateway/secrets) field in `openclaw.json` can resolve through the `op` CLI at runtime, so API keys never live in the config file.
- **Agent workflows:** the bundled `1password` skill teaches agents to sign in and read or inject secrets with `op` for their own tasks.

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

## Security notes

- Secret values resolved through exec providers stay in Gateway memory; config snapshots and `config.get` responses redact SecretRef fields.
- Never place secret values in `openclaw.json`, logs, or chat. Keep item names in config, values in 1Password.
- The 1Password audit trail shows every service account read, which makes key rotation and incident review practical.

## Troubleshooting

- `command not found` or spawn errors: use the absolute `op` path and include its directory in `trustedDirs`.
- `op` resolves but reads fail with symlink errors: set `allowSymlinkCommand: true` for Homebrew installs.
- `account is not signed in`: for service accounts, confirm `OP_SERVICE_ACCOUNT_TOKEN` reaches the Gateway service and is listed in `passEnv`; for desktop integration, confirm the app is running and unlocked.
- Slow first reads: raise `timeoutMs` on the provider; `op` cold starts can exceed strict timeouts on busy hosts.
