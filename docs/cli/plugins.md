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
- Security hardening: [Security](/gateway/security)

## Commands

```bash
clawdbot plugins list
clawdbot plugins info <id>
clawdbot plugins enable <id>
clawdbot plugins disable <id>
clawdbot plugins doctor
```

### Install

```bash
clawdbot plugins install <npm-spec>
```

Security note: treat plugin installs like running code. Prefer pinned versions.

