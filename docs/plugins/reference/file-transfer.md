---
summary: "Fetch, list, and write files on paired nodes via dedicated node commands. Bypasses bash stdout truncation by using base64 over node.invoke for binaries up to 16 MB."
read_when:
  - You are installing, configuring, or auditing the file-transfer plugin
title: "File Transfer plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Fetch, list, and write files on paired nodes via dedicated node commands. Bypasses bash stdout truncation by using base64 over node.invoke for binaries up to 16 MB.

## Distribution

- Package: `@openclaw/file-transfer`
- Install route: included in OpenClaw

## Surface

- CLI commands: `openclaw file-transfer`
- Contracts: `tools`

<!-- openclaw-plugin-reference:manual-start -->

## Directory archives

`dir_fetch` fetches the whole directory tree, including dotfiles and hidden
directories. File-transfer policy checks every descendant; a denied entry
rejects the whole transfer instead of being filtered out. Path identity,
symlink, archive-size, and extraction limits still apply.

## Migrate existing permissions

After upgrading, older positive file-transfer permissions remain inactive until
you review them. Deny rules, size limits, and symlink settings continue to
apply. Run this command on the Gateway host in an interactive terminal:

```bash
openclaw file-transfer approvals migrate
```

For each older path, choose one outcome:

- **Require exact reapproval** removes the ambiguous permission. The next use
  prompts once and records the exact node, command, requested path, and
  canonical target.
- **Keep as an intentional wildcard** preserves the entry as an
  operator-authored glob.
- **Remove this permission** deletes the positive entry.

Use `--dry-run` to review the plan without writing. Non-interactive and `--json`
runs never guess; they list unresolved items and direct you back to the same
interactive command.

The migration writes the new format once after confirmation and reports whether
the adjacent config backup was verified. Older OpenClaw versions cannot read
the migrated format. To downgrade, restore that reported `.bak` file before
starting the older version; doing so also restores the older permission
semantics.

<!-- openclaw-plugin-reference:manual-end -->
