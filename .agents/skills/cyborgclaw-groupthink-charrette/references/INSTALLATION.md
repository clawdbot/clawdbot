# Installation and upgrade

The source skill is self-contained and uses Node 22 without third-party packages.

## Install

Run from the source skill directory:

```bash
node scripts/validate-skill.mjs
node --test tests/*.test.mjs
node scripts/install.mjs --source "$PWD" --target-root "$HOME/.agents/skills"
```

The installer:

- resolves and validates the source and target root;
- rejects symlinks, special files, hard links, overlap, and path escape;
- refuses unknown, newer, same-version-different, or receipt-drifted targets;
- inventories files, empty directories, types, modes, sizes, and file hashes;
- acquires a nonce-owned per-skill lock and writes a phase journal;
- reads state through owned, non-group-writable, single-link regular files with no symlink following;
- stages a complete sibling copy on the target filesystem;
- requires `source-before == stage == source-after == installed`;
- preserves a known older target as a receipt-bound, immutable backup;
- writes an immutable receipt and detached hash outside the payload;
- verifies the final source/installed logical-tree identity.

A receipt-managed identical installed copy is a verified no-op. An unmanaged but byte-identical target is adopted without payload replacement: dry-run reports `ADOPT_IDENTICAL`, while an actual run writes the receipt/current pointer and reports `ADOPTED_IDENTICAL`.

Initial activation is one same-filesystem rename from an absent target. An
update is crash-consistent, not an uninterrupted one-step directory exchange:
it renames the old target to a backup and then renames the verified stage into
place. A journal makes either the old or new verified tree recoverable after an
interruption. It does not claim that every reader is guaranteed to avoid the
brief between-renames absence.

## Upgrade

Inspect the existing `manifest.json`, installation receipt, and version first. Run the same installer from the newly validated source. Never copy individual files over an installed tree.

Use `--dry-run` to inspect the disposition without mutation. Dry-run still validates locks, journals, receipts, and current pointers; an incomplete transaction reports `RECOVERY_REQUIRED` instead of mutating recovery state.

Use `--timestamp YYYY-MM-DDTHH:mm:ss.sssZ` only for deterministic tests or custodied automation. Other ISO-8601 variants are rejected.

The next mutation-capable invocation recovers an unambiguous interrupted journal while holding the installer lock. Journal transaction, stage, backup, target, and prior-receipt paths are exact-bound to managed state. A crash that leaves only one member of a receipt/hash pair is repaired only when the active journal proves the expected exact bytes. Ambiguous bytes, receipt drift, unsafe state ownership/mode/linkage, or a live/uncertain lock stop without guessing or deleting anything.

## Roll back a known update

Select the receipt for the update whose prior-version backup is wanted:

```bash
node scripts/install.mjs rollback \
  --target-root "$HOME/.agents/skills" \
  --receipt-id "<update-receipt-uuid>"
```

Rollback verifies the current receipt and selected backup, copies that backup
into a fresh stage, preserves the current version as another backup, performs
the same journaled cutover, and emits a new receipt. It never consumes the
selected backup or prunes backup history.

## Validate the installed copy

```bash
installed="$HOME/.agents/skills/cyborgclaw-groupthink-charrette"
node "$installed/scripts/validate-skill.mjs" --root "$installed"
node --test "$installed"/tests/*.test.mjs
node "$installed/scripts/build-checksums.mjs" --root "$installed" --check
```

Then start a fresh Codex context from outside the source repository, invoke `$cyborgclaw-groupthink-charrette` by name, and run a fixture-only decision. Static files alone do not prove discovery.

Logical-tree equality deliberately excludes ownership, timestamps, ACLs,
extended attributes, and filesystem allocation. Receipt hashes prove equality
and integrity, not authenticity against an attacker who can rewrite the same
user account.

The installer re-inventories source immediately around activation. If source bytes drift after staging, it preserves the unexpected bytes and restores the prior target and current-receipt pointer rather than claiming success.

## Uninstall

This skill intentionally provides no delete command. Removal is a separate destructive decision. Preserve the installation receipt and any backup before requesting exact removal authority.
