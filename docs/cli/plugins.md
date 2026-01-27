---
summary: "CLI reference for `moltbot plugins` (list, install, enable/disable, doctor)"
read_when:
  - You want to install or manage in-process Gateway plugins
  - You want to debug plugin load failures
---

# `moltbot plugins`

Manage Gateway plugins/extensions (loaded in-process).

Related:
- Plugin system: [Plugins](/plugin)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
moltbot plugins list
moltbot plugins info <id>
moltbot plugins enable <id>
moltbot plugins disable <id>
moltbot plugins doctor
moltbot plugins update <id>
moltbot plugins update --all
```

Bundled plugins ship with Moltbot but start disabled. Use `plugins enable` to
activate them.

All plugins must ship a `moltbot.plugin.json` file with an inline JSON Schema
(`configSchema`, even if empty). Missing/invalid manifests or schemas prevent
the plugin from loading and fail config validation.

### Install

```bash
moltbot plugins install <path-or-spec>
```

Security note: treat plugin installs like running code. Prefer pinned versions.

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
moltbot plugins install -l ./my-plugin
```

### Update

```bash
moltbot plugins update <id>
moltbot plugins update --all
moltbot plugins update <id> --dry-run
```

Updates only apply to plugins installed from npm (tracked in `plugins.installs`).
