---
summary: "OpenClaw ACP runtime backend with plugin-owned session and transport management."
read_when:
  - You are installing, configuring, or auditing the acpx plugin
title: "ACPx plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

OpenClaw ACP runtime backend with plugin-owned session and transport management.

## Distribution

- Package: `@openclaw/acpx`
- Install route: npm or ClawHub

## Surface

- Skills

<!-- openclaw-plugin-reference:manual-start -->

## Pi native sessions

The bundled runtime auto-detects Pi's session store on the Gateway and paired
nodes. Stored sessions appear in the **Pi** sessions-sidebar group, with
transcript browsing from Pi's documented JSONL session format. Local rows also
offer **Continue**, which creates an OpenClaw session whose first turn resumes
the native Pi session through ACP. Pi retains the full model context from its
session file, and OpenClaw imports the recent native history into the adopted
session transcript. Very long transcripts import only their most recent 200
items using a 512 KiB serialized-item budget. Paired-node rows remain view-only.
Custom session
directories outside the store scanned by `pi-acp` remain browse-only because the
adapter cannot resume those files by id.

The catalog honors project and global `settings.json` session directories plus
`PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`. Relative paths resolve
from the directory containing their `settings.json` file.

Turn **Pi Session Catalog** off under **Config > Plugins > ACPX Runtime** to
disable discovery. It is enabled by default.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [acpx](/tools/acp-agents-setup)
