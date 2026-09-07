---
summary: "Share native Codex threads, supervise sessions, and enable native plugins and Computer Use"
read_when:
  - You want OpenClaw to share the native Codex home
  - You are enabling Codex supervision
  - You are enabling native Codex plugins or Computer Use
title: "Native Codex state and features"
sidebarTitle: "Native state and features"
---

Opt-in features that connect an OpenClaw agent to native Codex state and Codex-owned capabilities. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Share threads with Codex Desktop and CLI

The default `appServer.homeScope: "agent"` isolates each OpenClaw agent from
the operator's native Codex state. To let an owner inspect and manage the
same native threads shown by Codex Desktop and the Codex CLI, opt into the
user Codex home:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            homeScope: "user",
          },
        },
      },
    },
  },
}
```

User-home mode supports a local managed stdio process or the shared Unix-socket
transport. It uses `$CODEX_HOME` when set and `~/.codex` otherwise, including
that home's native Codex auth, config, plugins, and thread store. OpenClaw does
not inject an OpenClaw auth profile into this app-server, even when the agent's
model route has a stored OpenAI profile. The native account is verified against
the route instead, in both directions:

- A subscription route requires the native home to be signed in to ChatGPT. Run
  `codex login` in that home if a turn reports missing subscription credentials.
- A Platform (API-key) route refuses a native home signed in with a ChatGPT
  subscription, so an API-billed route never silently spends the plan. Sign that
  home in with `codex login --with-api-key`, or switch to `homeScope: "agent"`
  and let OpenClaw inject the key it already holds.

A stored OpenAI profile is fine alongside `homeScope: "user"`; OpenClaw keeps it
for agent-scoped connections and simply does not hand it to the native home. Use
`openclaw models auth list --provider openai` to inspect stored profiles and
`openclaw models auth logout <profileId> --yes` to remove one you no longer want.

Owner turns gain the `codex_threads` tool: list, search, read, fork, rename,
archive, and restore native threads. Fork a thread to continue it in
OpenClaw; the fork attaches to the current OpenClaw session and remains readable
by ID from other native Codex clients. It appears in native thread lists after
its first user turn. Archiving requires explicit
confirmation that the thread is closed elsewhere. When supervision is also
enabled, transcript fields and mutations require the matching
`supervision.allowRawTranscripts` or `supervision.allowWriteControls` opt-in.

Do not resume or write the same thread concurrently through independent managed
stdio App Servers. Codex coordinates live writers inside one App Server, not
across separate processes. Forking is the safe coexistence path for ordinary
user-home stdio sessions.

`appServer.homeScope: "user"` alone does not control the fleet catalog. Native
session discovery is enabled while the plugin is active; set
`sessionCatalog.enabled: false` to remove it from the OpenClaw sidebar without
disabling Codex. The catalog uses a separate supervision connection; without
explicit `appServer` connection settings, that connection defaults to managed
user-home stdio while the ordinary harness stays agent-scoped. Explicit
`appServer` settings are honored by both paths. Set `homeScope: "user"`
explicitly, as above, when the ordinary harness should also share native state.

## Supervise Codex sessions

The same `codex` plugin can list non-archived Codex sessions from the Gateway
computer and opted-in paired nodes. A stored or idle Gateway-local session can
create a model-locked Chat that mirrors its bounded persisted user and assistant
history. Its private binding uses the supervision connection for the native
snapshot, canonical branch, and later turns while ordinary Codex sessions remain
agent-scoped. The first canonical start uses exactly the model and provider that
Codex returns for the snapshot fork. Later resumes leave selection to Codex's
native configuration; the outer OpenClaw model and fallback chain never replace
it. Stored and idle local rows can be archived after explicit no-other-runner
confirmation. Active sources cannot create a branch or be archived; an existing
supervised Chat can still be opened. Paired-node sessions expose bounded,
paginated transcripts. Eligible stored or idle paired-node rows also support
continuation for `operator.admin` when the node advertises and permits the
required catalog and CLI-resume commands. That flow resumes the exact native
thread on the node rather than creating a Gateway-local branch; paired-node
archive remains unavailable.

See [Supervise Codex sessions](/plugins/codex-supervision) for setup, branching
rules, paired-node limits, metadata exposure, and troubleshooting.

## Native Codex plugins

Native Codex plugin support uses Codex app-server's own app and plugin
capabilities in the same Codex thread as the OpenClaw harness turn. OpenClaw
does not translate Codex plugins into synthetic `codex_plugin_*` OpenClaw
dynamic tools.

`codexPlugins` affects only sessions that select the native Codex harness.
It has no effect on built-in harness runs, normal OpenAI provider runs, ACP
conversation bindings, or other harnesses.

Minimal migrated config:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: true,
            plugins: {
              "google-calendar": {
                enabled: true,
                marketplaceName: "openai-curated",
                pluginName: "google-calendar",
              },
            },
          },
        },
      },
    },
  },
}
```

Thread app config is computed when OpenClaw establishes a Codex harness
session or replaces a stale Codex thread binding; it is not recomputed on
every turn. After changing `codexPlugins`, use `/new`, `/reset`, or restart
the gateway so future Codex harness sessions start with the updated app
set.

For migration eligibility, app inventory, destructive action policy,
elicitations, and native plugin diagnostics, see
[Native Codex plugins](/plugins/codex-native-plugins).

OpenAI-side app and plugin access is controlled by the signed-in Codex
account and, for Business and Enterprise/Edu workspaces, workspace app
controls. See
[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
for OpenAI's account and workspace-control overview.

## Computer Use

Computer Use has its own setup guide:
[Codex Computer Use](/plugins/codex-computer-use).

Short version: OpenClaw does not vendor the desktop-control app or execute
desktop actions itself. It prepares Codex app-server, verifies that the
`computer-use` MCP server is available, and then lets Codex own the native
MCP tool calls during Codex-mode turns.
