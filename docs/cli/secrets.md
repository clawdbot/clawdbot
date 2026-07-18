---
summary: "CLI reference for `openclaw secrets` (reload, audit, configure, apply)"
read_when:
  - Re-resolving secret refs at runtime
  - Auditing plaintext residues and unresolved refs
  - Configuring SecretRefs and applying one-way scrub changes
title: "Secrets"
---

# `openclaw secrets`

Manage SecretRefs and keep the active runtime snapshot healthy.

| Command     | Role                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reload`    | Gateway RPC (`secrets.reload`): re-resolves refs and swaps the runtime snapshot only on full success (no config writes)                                                                      |
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

Related: [Secrets Management](/gateway/secrets) · [SecretRef Credential Surface](/reference/secretref-credential-surface) · [Security](/gateway/security)

## Reload runtime snapshot

```bash
openclaw secrets reload
openclaw secrets reload --json
openclaw secrets reload --url ws://127.0.0.1:18789 --token <token>
```

Uses gateway RPC method `secrets.reload`. If resolution fails, the gateway keeps its last-known-good snapshot and returns an error (no partial activation). JSON response includes `warningCount`.

Options: `--url <url>`, `--token <token>`, `--timeout <ms>`, `--json`.

## Audit

Scans OpenClaw state for:

- plaintext secret storage
- unresolved refs
- precedence drift (`auth-profiles.json` credentials shadowing `openclaw.json` refs)
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
- `summary`: `plaintextCount`, `unresolvedRefCount`, `shadowedRefCount`, `legacyResidueCount`
- finding codes: `PLAINTEXT_FOUND`, `REF_UNRESOLVED`, `REF_SHADOWED`, `LEGACY_RESIDUE`

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
- `--agent <id>`: scope `auth-profiles.json` target discovery and writes to one agent store
- `--allow-exec`: allow exec SecretRef checks during preflight/apply (may execute provider commands)

`--providers-only` and `--skip-provider-setup` cannot be combined.

Notes:

- Requires an interactive TTY.
- Targets secret-bearing fields in `openclaw.json` plus `auth-profiles.json` for the selected agent scope; canonical supported surface: [SecretRef Credential Surface](/reference/secretref-credential-surface).
- Supports creating new `auth-profiles.json` mappings directly in the picker flow.
- Runs preflight resolution before apply.
- Generated plans default to scrub options enabled (`scrubEnv`, `scrubAuthProfilesForProviderTargets`, `scrubLegacyAuthJson`). Apply is one-way for scrubbed plaintext values.
- `--plan-out` refuses to create a plan whose UTF-8 serialized form exceeds 16 MiB (16,777,216 bytes), matching the `apply --from` input limit.
- Without `--apply`, the CLI still prompts `Apply this plan now?` after preflight.
- With `--apply` (and no `--yes`), the CLI prompts an extra irreversible-migration confirmation.
- `--json` prints the plan + preflight report, but still requires an interactive TTY.

### Exec provider safety

Homebrew installs often expose symlinked binaries under `/opt/homebrew/bin/*`. Set `allowSymlinkCommand: true` only when needed for trusted package-manager paths, paired with `trustedDirs` (for example `["/opt/homebrew"]`). On Windows, if ACL verification is unavailable for a provider path, OpenClaw fails closed; for trusted paths only, set `allowInsecurePath: true` on that provider to bypass the path security check.

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
- `auth-profiles.json` (provider-target scrubbing)
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
