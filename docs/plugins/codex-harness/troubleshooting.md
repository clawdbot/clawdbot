---
summary: "Symptoms and fixes for Codex harness selection, app-server, and memory problems"
read_when:
  - Codex is not selected when you expect it
  - The Codex app-server fails to start or connect
  - Codex native tools are blocked or use too much memory
title: "Codex harness troubleshooting"
sidebarTitle: "Troubleshooting"
---

Symptoms, causes, and fixes for the Codex app-server harness. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Troubleshooting

**Codex does not appear as a normal `/model` provider:** expected for new
configs. Select an `openai/gpt-*` model, enable
`plugins.entries.codex.enabled`, and check whether `plugins.allow` excludes
`codex`.

**OpenClaw uses the built-in harness instead of Codex:** confirm the effective
route is an exact official HTTPS Platform Responses or ChatGPT Responses route,
has no authored provider request override, and that the Codex plugin is installed
and enabled. Affirmative reasoning support and native reasoning-effort metadata
do not count as request overrides. Headers, request parameters, timeouts, and
payload compatibility switches still do: Codex declares an OpenClaw fallback
that preserves the exact request, including for explicit runtime selections.
Other unsupported routes/authentication and missing explicit harnesses fail
closed. The `openai/gpt-*` prefix and `agentRuntime.id: "codex"` alone are not
execution proof; inspect the actual harness in the completed result. See
[Runtime selection](/concepts/agent-runtimes#runtime-selection).

**OpenAI Codex runtime falls back to the API-key path:** collect a redacted
gateway excerpt that shows the model, runtime, selected provider, and
failure. Ask affected collaborators to run this read-only command on their
OpenClaw host:

```bash
(
  pattern='openai/gpt-5\.[45]|openai[-]codex|agentRuntime(\.id)?|harnessRuntime|Runtime: OpenAI Codex|legacy OpenAI Codex prefix|resolveSelectedOpenAIRuntimeProvider|candidateProvider[": ]+openai|status[": ]+401|Incorrect API key|No API key|api-key path|API-key path|OAuth'

  if ls /tmp/openclaw/openclaw-*.log >/dev/null 2>&1; then
    grep -E -i -n "$pattern" /tmp/openclaw/openclaw-*.log 2>/dev/null || true
  else
    journalctl --user -u openclaw-gateway --since today --no-pager 2>/dev/null \
      | grep -E -i "$pattern" || true
  fi
) | sed -E \
    -e 's/(Authorization: Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/Ig' \
    -e 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/Ig' \
    -e 's/(api[_ -]?key[=: ]+)[^ ,}"]+/\1[REDACTED]/Ig' \
    -e 's/(OPENAI_API_KEY[=: ]+)[^ ,}"]+/\1[REDACTED]/Ig' \
    -e 's/sk-[A-Za-z0-9_-]{12,}/sk-[REDACTED]/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[EMAIL-REDACTED]/g' \
  | tail -200
```

Useful excerpts usually include `openai/gpt-5.6-sol` or `openai/gpt-5.6-luna`,
`Runtime: OpenAI Codex`, `agentRuntime.id` or `harnessRuntime`,
`candidateProvider: "openai"`, and a `401`, `Incorrect API key`, or
`No API key` result. A corrected run should show the OpenAI OAuth path
instead of a plain OpenAI API-key failure.

**Legacy Codex model refs config remains:** run `openclaw doctor --fix`.
Doctor rewrites legacy model refs to `openai/*`, removes stale session and
whole-agent runtime pins, and preserves existing auth-profile overrides.

**The app-server is rejected:** use Codex `0.149.0` or newer. Older, malformed,
and unversioned servers are rejected. Newer semantic versions continue with a
compatibility warning and normal runtime validation against the Codex version
OpenClaw ships. Update or remove custom, remote, or desktop
binary overrides that select another version.

**`/codex status` cannot connect:** check that the `codex` plugin
is enabled, that `plugins.allow` includes it when an allowlist is
configured, and that any custom `appServer.command`, `url`, `authToken`, or
headers are valid.

**The Codex app-server uses too much memory:** distinguish the two processes
first. OpenClaw runs the local Codex app-server as a separate Rust child.
`NODE_OPTIONS=--max-old-space-size=...` changes only the Gateway's Node.js V8
heap; it does not cap or enlarge Codex. Managed Gateway installs already choose
an adaptive V8 heap, and raising it can leave less host memory for Codex. Use
[Gateway memory troubleshooting](/gateway/troubleshooting#gateway-exits-during-high-memory-use)
for Gateway pressure, and inspect host or container memory for the Codex child.

The bundled Codex has no heap or RSS limit and no configurable idle-unload
delay. After the last client unsubscribes, an inactive thread can remain loaded
for up to 30 minutes. OpenClaw independently keeps up to 64 idle conversation
threads subscribed on each Codex app-server for 30 minutes after their last
activity. This preserves warm sessions and session-scoped approvals when several
conversations alternate. Active turns and parents with unfinished native
subagents are protected from idle eviction; session reset or deletion releases
its own thread immediately. Idle-limit eviction unsubscribes the least recently
used conversation, after which Codex applies its separate unloading delay and a
later resumed session can require approvals again.

On constrained hosts, reduce native Codex subagent fan-out before increasing the
Gateway heap:

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            args: ["-c", "agents.max_threads=3", "app-server", "--listen", "stdio://"],
          },
        },
      },
    },
  },
}
```

That setting limits native child threads for the bundled Codex default
multi-agent backend. If you explicitly enable Codex multi-agent v2, use
`features.multi_agent_v2.max_concurrent_threads_per_session=3` instead; the v2
limit includes the root thread and cannot be combined with `agents.max_threads`.
For more Codex headroom, increase the host, container, or cgroup memory
allocation. An OS hard limit can terminate Codex rather than backpressure it.

**Model discovery is slow:** lower
`plugins.entries.codex.config.discovery.timeoutMs` or disable discovery.
See [Codex harness reference](/plugins/codex-harness-reference#model-discovery).

**Codex plugin state has reached its row limit:** run `openclaw doctor` to
check for bindings left behind by deleted or expired OpenClaw sessions. Stop
the Gateway, then run `openclaw doctor --fix` to remove proven orphaned session
bindings after session repair. Doctor preserves supervised bindings, active
leases, ambiguous ownership, and bindings whose session store cannot be read.
This cleanup does not delete native Codex thread history or managed-thread
advisory records.

**WebSocket transport fails immediately:** check `appServer.url`,
`authToken`, headers, and that the remote app-server speaks the same Codex
app-server protocol version. Codex WebSocket transport remains experimental
and unsupported; prefer managed stdio or the local Unix control socket.

**Native shell or patch tools are blocked with `Native hook relay
unavailable`:** the Codex thread is still trying to use a native hook relay
id that OpenClaw no longer has registered. This is a native Codex hook
transport problem, not an ACP backend, provider, GitHub, or shell-command
failure. Start a fresh session in the affected chat with `/new` or `/reset`,
then retry a harmless command. If that works once but the next native tool
call fails again, treat `/new` as a temporary workaround only: copy the
prompt into a fresh session after restarting the Codex app-server or
OpenClaw Gateway so old threads are dropped and native hook registrations
are recreated.

**Codex tool calls create too many short-lived hook processes:** set
`plugins.entries.codex.config.appServer.loopDetectionPreToolUseRelay: false`
and restart the gateway. This disables only the Codex `PreToolUse` subprocess
used for OpenClaw loop detection and its no-policy marker. Required
`before_tool_call` and trusted-tool policy relays remain enabled.

**A non-Codex model uses the built-in harness:** expected unless provider
or model runtime policy routes it to another harness. Plain non-OpenAI
provider refs stay on their normal provider path in `auto` mode.

**Computer Use is installed but tools do not run:** check
`/codex computer-use status` from a fresh session. If a tool reports
`Native hook relay unavailable`, use the native hook relay recovery above.
See [Codex Computer Use](/plugins/codex-computer-use#troubleshooting).
