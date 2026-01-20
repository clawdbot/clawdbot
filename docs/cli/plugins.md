---
summary: "CLI reference for `clawdbot plugins` (list, install, enable/disable, doctor)"
read_when:
  - You want to install or manage in-process Gateway plugins
  - You want to debug plugin load failures
---

# `clawdbot plugins`

Manage Gateway plugins/extensions (loaded in-process).

Related:
- Plugin system: [Plugins](/plugin)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
clawdbot plugins list
clawdbot plugins info <id>
clawdbot plugins enable <id>
clawdbot plugins disable <id>
clawdbot plugins doctor
clawdbot plugins update <id>
clawdbot plugins update --all
```

Bundled plugins ship with Clawdbot but start disabled. Use `plugins enable` to
activate them.

All plugins must ship a `clawdbot.plugin.json` file with an inline JSON Schema
(`configSchema`, even if empty). Missing/invalid manifests or schemas prevent
the plugin from loading and fail config validation.

### Install

```bash
clawdbot plugins install <path-or-spec>
```

Security note: treat plugin installs like running code. Prefer pinned versions.

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
clawdbot plugins install -l ./my-plugin
```

### Update

```bash
clawdbot plugins update <id>
clawdbot plugins update --all
clawdbot plugins update <id> --dry-run
```

Updates only apply to plugins installed from npm (tracked in `plugins.installs`).
