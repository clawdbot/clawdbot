---
summary: "OpenClaw ACP runtime backend with plugin-owned session and transport management."
read_when:
  - You are installing, configuring, or auditing the acpx plugin
title: "ACPx plugin"
---

# ACPx plugin

OpenClaw ACP runtime backend with plugin-owned session and transport management.

## Distribution

- Package: `@openclaw/acpx`
- Install route: npm; ClawHub

## Surface

skills

<!-- openclaw-plugin-reference:manual-start -->

## Pi native sessions

The bundled runtime auto-detects Pi's session store on the Gateway and paired
nodes. Stored sessions appear in the **Pi** sessions-sidebar group, with
read-only transcript browsing from Pi's documented JSONL session format. The
catalog honors project and global `settings.json` session directories plus
`PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`. Relative paths resolve
from the directory containing their `settings.json` file.

Turn **Pi Session Catalog** off under **Config > Plugins > ACPX Runtime** to
disable discovery. It is enabled by default.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [acpx](/tools/acp-agents-setup)
