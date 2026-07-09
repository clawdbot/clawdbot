---
summary: "Supervise Codex app-server sessions from OpenClaw."
read_when:
  - You are installing, configuring, or auditing the codex-supervisor plugin
title: "Codex Supervisor plugin"
---

# Codex Supervisor plugin

Supervise Codex app-server sessions from OpenClaw.

## Distribution

- Package: `@openclaw/codex-supervisor`
- Install route: included in OpenClaw

## Surface

contracts: tools

<!-- openclaw-plugin-reference:manual-start -->

## Enable the plugin

The plugin is disabled by default. Enable it independently on the Gateway and
on every computer whose Codex sessions should appear in the federated catalog:

```json5
{
  plugins: {
    entries: {
      "codex-supervisor": {
        enabled: true,
      },
    },
  },
}
```

Each entry belongs to the OpenClaw process on that computer:

| Entry location                           | What it enables                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Gateway `openclaw.json`                  | The Gateway-local catalog, fleet aggregation, `openclaw codex sessions`, and the Control UI page |
| Headless node host `openclaw.json`       | The node-local catalog command advertised by `openclaw node run` or the installed node service   |
| Native macOS app's local `openclaw.json` | The same node-local catalog command, implemented by the app                                      |

The node entry is local consent to share session metadata with its paired
Gateway. Enabling only the Gateway does not authorize access to another
computer. This setting belongs under `plugins.entries`, not `gateway.nodes`.

Restart the Gateway, node host, or macOS app after changing plugin activation.
A newly advertised catalog command changes the node's approved command surface.
Approve that update from the Gateway host:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

## App Server selection

The catalog opens a dedicated local Codex App Server over stdio. By default it
runs `codex app-server --listen stdio://`. If
`plugins.entries.codex-supervisor.config.endpoints` contains a `stdio-proxy`
endpoint, the catalog uses the first one and honors its `command`, `args`, and
`cwd`. Raw App Server endpoints are never exposed through the Gateway or node
connection.

The plugin's configured endpoints also back its supervisor agent tools. The
catalog uses a separate App Server connection so session listing does not
replace or attach to the live-control connection.

## List sessions from the CLI

The command queries the Gateway and groups results by stable host id:

```bash
openclaw codex sessions
openclaw codex sessions --json
openclaw codex sessions --search "Fix tests"
openclaw codex sessions --archived
```

Options:

| Option              | Behavior                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| `--search <text>`   | Case-sensitive session-title substring search. Transcript previews are not searched. |
| `--archived`        | List archived sessions instead of active history.                                    |
| `--host <id>`       | Query one exact `gateway:<endpointId>` or `node:<nodeId>` host id.                   |
| `--limit <count>`   | Return 1-100 sessions per host. The default is 50.                                   |
| `--cursor <cursor>` | Continue one host's page. Requires `--host`.                                         |
| `--json`            | Print the structured host-grouped response.                                          |

Cursors are opaque and host-specific. Reuse the same search and archive
filters when continuing a page. Search is applied to the normalized titles in
each fetched page, so a matching page can contain fewer than `--limit` entries
while still returning another cursor. Gateway endpoint ids that exceed the
catalog's routing limit receive a stable `gateway:sha256:<digest>` host id.

## Use the Control UI

Open the **Codex Sessions** plugin page in the Control UI. It provides active
and archived views, title search, refresh, host status, and per-host **Load
more** controls. Background refresh preserves pages that you already loaded.

Catalog failures are isolated by host. An offline node, unavailable local App
Server, timeout, or malformed node response produces an error on that host;
sessions from healthy hosts remain available in the same response and page.

## Metadata and security boundary

The node command is read-only and returns normalized metadata only:

- thread and session identifiers
- session name and working directory
- status, active status flags, and archive state
- created, updated, and activity timestamps
- source, model provider, Codex CLI version, and Git branch

It does not return transcript previews, turns, rollout paths, the Codex home
path, Git remotes, commit SHAs, or raw App Server errors. Title search is
performed after normalization so query results cannot reveal matches from
transcript-derived previews. `notLoaded` means the thread is stored but is not
loaded in the catalog's dedicated App Server process; it does not mean that no
other Codex process is using the thread.

Working directories, titles, and branch names can still be sensitive. Enable
the plugin only on nodes paired with a trusted Gateway. Catalog access requires
the `operator.write` Gateway scope because federation uses the standard
`node.invoke` path, even though the catalog command itself is read-only.

The separate `allowRawTranscripts` and `allowWriteControls` plugin settings
apply to supervisor agent tools and default to `false`. They do not expand the
metadata-only CLI or Control UI catalog.

## Supervisor agent session listing

`codex_sessions_list` defaults to loaded Codex sessions only. Set
`include_stored` to include stored history; the plugin uses Codex App Server's
state-DB-only listing path and caps stored results at 200 by default. Pass
`max_stored_sessions` to lower or raise that cap, up to 1000.

<!-- openclaw-plugin-reference:manual-end -->
