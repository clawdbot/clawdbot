---
summary: "CLI reference for `openclaw secrets` (store, reload, audit, configure, apply)"
read_when:
  - Re-resolving secret refs at runtime
  - Managing team-scoped values in the shared secret store
  - Auditing plaintext residues and unresolved refs
  - Configuring SecretRefs and applying one-way scrub changes
title: "Secrets"
---

# `openclaw secrets`

Manage SecretRefs and keep the active runtime snapshot healthy.

| Command     | Role                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reload`    | Gateway RPC (`secrets.reload`): re-resolves refs and atomically publishes the owner-aware runtime snapshot (no config writes); eligible owner failures may publish as cold or stale warnings |
| `store`     | Manages team-scoped secret and environment values in the local shared state SQLite database                                                                                                  |
| `audit`     | Read-only scan of config/auth/generated-model stores and legacy residues for plaintext, unresolved refs, and precedence drift (exec refs skipped unless `--allow-exec`)                      |
| `configure` | Interactive planner for provider setup, target mapping, and preflight (requires a TTY)                                                                                                       |
| `apply`     | Executes a saved plan (`--dry-run` validates only and skips exec checks by default; write mode rejects exec-containing plans unless `--allow-exec`), then scrubs targeted plaintext residues |

Recommended operator loop:

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets audit --check
openclaw secrets reload
```

If your plan includes `exec` SecretRefs/providers, pass `--allow-exec` on both the dry-run and write `apply` commands.

Exit codes for CI/gates:

- `audit --check` returns `1` on findings.
- Unresolved refs return `2` (regardless of `--check`).
- Store validation and disclosure-policy failures return `2`; `store get` returns `3` when the name is missing.

Related: [Secrets Management](/gateway/secrets) · [1Password plugin](/plugins/onepassword) · [SecretRef Credential Surface](/reference/secretref-credential-surface) · [Security](/gateway/security)

## Shared secret store

`openclaw secrets store` writes directly to the local shared state database. The store is Gateway-wide and team-scoped; this release accepts only `--scope team`. `--scope me` is rejected because identity scope is not supported yet.

```bash
openclaw secrets store list
openclaw secrets store set <NAME>
openclaw secrets store get <NAME>
openclaw secrets store rm <NAME>...
openclaw secrets store import [--from <file>]
```

Names must match `^[A-Z][A-Z0-9_]{0,127}$`. Values are limited to 64 KiB (65,536 UTF-8 bytes); an oversized value is rejected with exit code 2 whether it arrives from stdin, `--value`, or `--value-file`. A `secret` entry may not be empty, because an empty credential cannot be diagnosed later (`get` refuses secret kinds and listings mask them); `env` entries may be empty. `--kind secret|env` overrides automatic kind detection; otherwise names ending in common credential suffixes such as `_API_KEY`, `_TOKEN`, `_PASSWORD`, `_PRIVATE_KEY`, or `_SECRET` become `secret`, and other names become `env`.

### Set values safely

`--value` is accepted only when the resolved kind is `env`:

```bash
openclaw secrets store set LOG_LEVEL --kind env --value debug
```

For `secret` values, `--value` is refused with exit code `2` because command-line arguments can leak through shell history and process listings. Use one of the three safe inputs instead:

- Pipe stdin when stdin is not a TTY.
- Pass `--value-file <path>`; `--value-file -` means stdin.
- Run interactively and enter the value in the no-echo prompt.

Examples:

```bash
op read 'op://Engineering/OpenAI/apiKey' | \
  openclaw secrets store set OPENAI_API_KEY --kind secret

openclaw secrets store set TLS_PRIVATE_KEY \
  --kind secret \
  --value-file ./client-key.pem
```

`set` is idempotent and updates an existing name. Add `--dry-run` to validate and preview the operation without writing. A successful write reminds you to run `openclaw secrets reload` before a config-referenced value can take effect.

Secret egress substitution fails closed until each secret has at least one exact allowed host. Bind or replace hosts with repeatable `--allow-host` flags; this policy-only form does not ask for or replace an existing secret value:

```bash
openclaw secrets store set OPENAI_API_KEY --allow-host api.openai.com
openclaw secrets store set SERVICE_TOKEN \
  --allow-host api.example.com \
  --allow-host uploads.example.com
openclaw secrets store set SERVICE_TOKEN --clear-allowed-hosts
```

Hosts are normalized to lowercase ASCII/punycode. Schemes, paths, ports, and wildcards are rejected. `store list` shows allowed hosts because they are policy metadata, not secret material.

### Read values

```bash
openclaw secrets store list --json
openclaw secrets store list --plain
openclaw secrets store get LOG_LEVEL
```

Secret values never appear in human, `--json`, or `--plain` output. `store get` refuses a `secret` entry as write-only by design and exits `2`; it exits `3` when the name does not exist. Environment-kind values are readable.

Team-scoped `env` entries reach Gateway-hosted commands run by OpenClaw's own exec tool, including OpenClaw Code Mode calls into `openclaw:core:exec` and Codex `gateway_exec`. Explicit per-call env wins over store values. Sandbox, remote `node`, ACP, and Codex-native shell execution do not receive them. `secret` entries stay out of subprocesses by default. With `secrets.egressProxy.enabled: true`, Gateway-hosted exec receives only authenticated sentinels and the Gateway replaces them at HTTPS egress; see [Secret egress proxy](/gateway/secrets#secret-egress-proxy).

<Warning>
Store entries do not reach commands run inside an external agent harness. The Codex app-server and its sandbox exec-server, and ACP children such as Claude Code, build their own child environment and never pass through OpenClaw's exec preparation. In eligible Codex turns, use `gateway_exec` to enter the OpenClaw-managed Gateway environment path instead.
</Warning>

### Remove values

```bash
openclaw secrets store rm OLD_TOKEN
openclaw secrets store rm OLD_TOKEN LEGACY_PASSWORD --yes
openclaw secrets store rm OLD_TOKEN --dry-run
```

Removal is idempotent, so a missing name succeeds quietly. Without `--yes`, the CLI asks for confirmation. Removed rows are soft-deleted and purged after 30 days.

### Import dotenv files

Import dotenv-format assignments from a regular file or stdin:

```bash
openclaw secrets store import --from .env
openclaw secrets store import --from .env --dry-run
openclaw secrets store import --from .env --yes
op read 'op://Engineering/service-account/dotenv' | openclaw secrets store import --yes
```

The importer supports quoted values and multiline quoted values such as PEM keys. Use `--yes` to skip confirmation and `--dry-run` to inspect the import without writing. Kind detection follows the same name-based rule as `store set`.

The store CLI commands do not accept `--url` or `--token` and do not route through the Gateway. The Control UI uses the admin-scoped `secrets.store.*` RPC methods instead; those methods refresh the runtime automatically when a changed name is referenced by active config.

## Reload runtime snapshot

```bash
openclaw secrets reload
openclaw secrets reload --json
openclaw secrets reload --url ws://127.0.0.1:18789 --token <token>
```

Uses gateway RPC method `secrets.reload`. Healthy owners refresh independently. Eligible failed owners become stale only when their ref identities, provider definitions, and complete non-secret owner contract are unchanged; new or changed failures become cold. This degraded activation succeeds and reports `warningCount`. Strict or unmapped failures return an error and preserve the previously active snapshot.

Options: `--url <url>`, `--token <token>`, `--timeout <ms>`, `--json`.

## Audit

Scans OpenClaw state for:

- plaintext secret storage
- unresolved refs
- precedence drift (auth profile store credentials shadowing `openclaw.json` refs)
- store residue (a team store value duplicated by plaintext in `openclaw.json`)
- generated `agents/*/agent/models.json` residues (provider `apiKey` values and sensitive provider headers)
- legacy residues (legacy auth store entries, OAuth reminders)

The `.env` scan covers the effective state directory and the directory containing the active config. When both paths name the same file, it is scanned once.

Sensitive provider header detection is name-heuristic based: it flags headers whose name matches common auth/credential fragments (`authorization`, `x-api-key`, `token`, `secret`, `password`, `credential`).

```bash
openclaw secrets audit
openclaw secrets audit --check
openclaw secrets audit --json
openclaw secrets audit --allow-exec
```

Report shape:

- `status`: `clean | findings | unresolved`
- `resolution`: `refsChecked`, `skippedExecRefs`, `resolvabilityComplete`
- `summary`: `plaintextCount`, `unresolvedRefCount`, `shadowedRefCount`, `storeResidueCount`, `legacyResidueCount`
- finding codes: `PLAINTEXT_FOUND`, `REF_UNRESOLVED`, `REF_SHADOWED`, `STORE_PLAINTEXT_RESIDUE`, `LEGACY_RESIDUE`

## Configure (interactive helper)

Build provider and SecretRef changes interactively, run preflight, and optionally apply:

```bash
openclaw secrets configure
openclaw secrets configure --plan-out /tmp/openclaw-secrets-plan.json
openclaw secrets configure --apply --yes
openclaw secrets configure --providers-only
openclaw secrets configure --skip-provider-setup
openclaw secrets configure --agent ops
openclaw secrets configure --json
```

Flow: provider setup first (add/edit/remove `secrets.providers` aliases), then credential mapping (select fields, assign `{source, provider, id}` refs), then preflight and optional apply.

Flags:

- `--providers-only`: configure `secrets.providers` only, skip credential mapping
- `--skip-provider-setup`: skip provider setup, map credentials to existing providers
- `--agent <id>`: scope auth profile target discovery and writes to one agent store
- `--allow-exec`: allow exec SecretRef checks during preflight/apply (may execute provider commands)

`--providers-only` and `--skip-provider-setup` cannot be combined.

Notes:

- Requires an interactive TTY.
- Targets secret-bearing fields in `openclaw.json` plus the selected agent's auth profile store; canonical supported surface: [SecretRef Credential Surface](/reference/secretref-credential-surface).
- Supports creating new auth profile mappings directly in the picker flow.
- Runs preflight resolution before apply.
- Generated plans default to scrub options enabled (`scrubEnv`, `scrubAuthProfilesForProviderTargets`, `scrubLegacyAuthJson`). Apply is one-way for scrubbed plaintext values.
- `--plan-out` refuses to create a plan whose UTF-8 serialized form exceeds 16 MiB (16,777,216 bytes), matching the `apply --from` input limit.
- Without `--apply`, the CLI still prompts `Apply this plan now?` after preflight.
- With `--apply` (and no `--yes`), the CLI prompts an extra irreversible-migration confirmation.
- `--json` prints the plan + preflight report, but still requires an interactive TTY.

### Exec provider safety

Package managers often expose symlinked command paths. Resolve the real binary path (for example with `realpath "$(command -v vault)"`) and configure that absolute, non-symlink path; use `trustedDirs` to restrict executables to approved directories. On Windows, provider paths fail closed when ACL verification is unavailable, with no provider-level bypass.

## Apply a saved plan

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

`--dry-run` validates preflight without writing files; exec SecretRef checks are skipped by default in dry-run. Write mode rejects plans containing exec SecretRefs/providers unless `--allow-exec`. Use `--allow-exec` to opt in to exec provider checks/execution in either mode.

`--from` must point to a regular file no larger than 16 MiB (16,777,216 bytes). The byte limit applies to the complete serialized file, including whitespace.

What `apply` may update:

- `openclaw.json` (SecretRef targets + provider upserts/deletes)
- auth profile store (provider-target scrubbing)
- legacy `auth.json` residues
- `.env` files in the effective state and active-config directories, for known secret keys whose values were migrated

Plan contract details (allowed target paths, validation rules, failure semantics): [Secrets Apply Plan Contract](/gateway/secrets-plan-contract).

### Why no rollback backups

`secrets apply` intentionally does not write rollback backups containing old plaintext values. Safety comes from strict preflight plus atomic-ish apply, with best-effort in-memory restore on failure.

## Example

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

If `audit --check` still reports plaintext findings, update the remaining reported target paths and rerun audit.

## Related

- [CLI reference](/cli)
- [Secrets management](/gateway/secrets)
- [Vault SecretRefs](/plugins/vault)
- [1Password plugin](/plugins/onepassword)
