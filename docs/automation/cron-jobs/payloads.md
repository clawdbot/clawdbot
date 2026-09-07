---
doc-schema-version: 1
summary: "Payload kinds, agent-turn flags, command and script payloads, and session execution styles"
read_when:
  - Choosing a system-event, agent-turn, command, or script payload
  - Setting a per-job model, thinking level, or tool policy
  - Deciding between main, current, isolated, and custom sessions
title: "Automation payloads"
sidebarTitle: "Payloads"
---

What a job runs and where it runs: the four payload kinds, their flags, and the four session execution styles. Part of the [Automations](/automation/cron-jobs) guide.

## Payloads

Every job carries exactly one payload kind, chosen by flag:

| Payload       | Flag                                           | Runs                                                       |
| ------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| System event  | `--system-event <text>`                        | Enqueued into the main session, no model call by itself    |
| Agent message | `--message <text>`                             | A model-backed agent turn                                  |
| Command       | `--command <shell>` or `--command-argv <json>` | A shell/process on the Gateway host, no model call         |
| Script        | `--script <file\|->`                           | A headless code-mode script using the owning agent's tools |

System-owned monitor jobs are gateway-converged and cannot be created or edited through the CLI or API. The `heartbeat` kind creates one heartbeat monitor job per heartbeat-enabled agent (see [Heartbeat](/gateway/heartbeat)). The weekly Skill Workshop review is a normal isolated `agentTurn` job with a reserved declaration key. Both appear in `openclaw cron list`; use `--all` to include disabled rows.
The `skillCollectionReview` payload kind is gone; existing rows are replaced with the canonical review job during upgrade.

Skill collection review runs every 7 days. It is enabled when `skills.workshop.autonomous.mode` is `auto`; `propose` and `off` keep the system-owned job disabled. The Gateway converges these jobs at startup and after config reload. Scheduled reviews require automations. When `cron.enabled` is `false` or `OPENCLAW_SKIP_CRON=1`, the Gateway logs a startup warning and does not run scheduled reviews. There is no separate weekly Gateway timer.

### Agent-turn options

<ParamField path="--message" type="string" required>
  Prompt text (required for isolated/current/custom-session jobs).
</ParamField>
<ParamField path="--model" type="string">
  Model override; must resolve to an allowed model or the run fails with a validation error.
</ParamField>
<ParamField path="--fallbacks" type="string">
  Per-job fallback model list, for example `--fallbacks openai/gpt-5.6-sol,openrouter/meta-llama/llama-3.3-70b-instruct:free`. Pass `--fallbacks ""` for a strict run with no fallbacks.
</ParamField>
<ParamField path="--clear-fallbacks" type="boolean">
  On `automations edit`, removes the per-job fallback override so the job follows configured fallback precedence. Cannot combine with `--fallbacks`.
</ParamField>
<ParamField path="--clear-model" type="boolean">
  On `automations edit`, removes the per-job model override so the job follows normal automation model precedence (stored automation-session override, else agent/default model). Cannot combine with `--model`.
</ParamField>
<ParamField path="--thinking" type="string">
  Thinking level override (`off|minimal|low|medium|high|xhigh|adaptive|max|ultra`). Available levels still depend on the selected model and agent runtime.
</ParamField>
<ParamField path="--clear-thinking" type="boolean">
  On `automations edit`, removes the per-job thinking override. Cannot combine with `--thinking`.
</ParamField>
<ParamField path="--light-context" type="boolean">
  Skip workspace bootstrap file injection.
</ParamField>
<ParamField path="--tools" type="string">
  Restrict which tools the job can use, for example `--tools exec,read`.
</ParamField>

New jobs that can run tools always store an explicit tool policy. Jobs created by an agent
are capped to the tools available to that creating turn, and the agent cannot widen the
stored list. Jobs created by an authenticated operator without `--tools` store an
unrestricted `*` policy; `automations edit --clear-tools` restores that explicit unrestricted
policy. Existing jobs that predate an explicit tool policy retain their current behavior
until their tool policy is explicitly edited or the job is recreated.

`--model` sets the job's primary model; it does not replace a session `/model` override, so configured fallback chains still apply on top of it. An unresolved or disallowed model fails the run with an explicit validation error rather than silently falling back to the default. If a job has `--model` but no explicit or configured fallback list, OpenClaw passes an empty fallback override instead of silently appending the agent primary as a hidden retry target.

Pick the model for the job's difficulty, not the agent's default. Routine
automation - summaries, triage, classification, status checks - runs well on a
lighter model, which is cheaper and faster per run and adds up across a
schedule. Keep your default model for jobs that need deep reasoning, and use
`--fallbacks` when a light primary should escalate on failure.

Model-selection precedence for isolated jobs, highest first:

1. Per-job payload `model` (explicit config; a disallowed model fails the run)
2. Gmail hook model override (only when the run came from Gmail and that override is allowed)
3. User-selected stored automation-session model override
4. Agent/default model selection

Fast mode follows the resolved live selection. Isolated automation resolves it in this order: stored session `fastMode`, per-agent `agents.entries.*.fastModeDefault`, global `agents.defaults.fastModeDefault`, then selected-model `params.fastMode`. Auto mode uses the model's `params.fastAutoOnSeconds` cutoff, defaulting to 60 seconds.

When a runtime reports token usage without a cost, automation estimates use the selected agent's local `models.json` prices and the model metadata retained for that run.

If a run hits a live model-switch handoff, the scheduler retries with the switched provider/model and persists that selection (and any new auth profile) for the active run. Retries are bounded: after the initial attempt plus 2 switch retries, the scheduler aborts instead of looping.

Before an isolated run starts, OpenClaw checks reachable local endpoints for configured `api: "ollama"` and `api: "openai-completions"` providers whose `baseUrl` is loopback, private-network, or `.local`. This preflight walks the job's configured fallback chain and only marks the run `skipped` once every candidate is unreachable; `--fallbacks ""` keeps that walk strict to just the primary model. A down endpoint records the run as `skipped` with a clear error instead of starting a model call. The result is cached for 5 minutes per endpoint (not per job or model), so many due jobs sharing a dead local Ollama/vLLM/SGLang/LM Studio server cost one probe instead of a request storm. Skipped preflight runs do not increment execution-error backoff; set `failureAlert.includeSkipped` to opt into repeated skip alerts.

### Command payloads

Command payloads run deterministic scripts inside the Gateway scheduler without starting a model-backed turn. They execute on the Gateway host, capture stdout/stderr, record the run in the job's run history, and reuse the same `announce`, `webhook`, and `none` delivery modes as agent-turn jobs.

<Note>
When an agent-turn automation's exec needs approval, the card is delivered to connected approval surfaces and the run waits for the decision; answering **Always allow** mints a scoped standing grant so later occurrences run without prompting. See [Standing grants for automations](/tools/exec-approvals#standing-grants-for-automations) for lifetime, listing, and revocation.

Command payloads are an operator-admin Gateway automation surface, not an agent `tools.exec` call. Creating, updating, removing, or manually running automation jobs requires `operator.admin`; scheduled command runs later execute inside the Gateway process as that admin-authored automation. Agent exec policy (`tools.exec.mode`, approval prompts, per-agent tool allowlists) governs model-visible exec tools, not command payloads.
</Note>

```bash
openclaw automations create "*/15 * * * *" \
  --name "Queue depth probe" \
  --command "scripts/check-queue.sh" \
  --command-cwd "/srv/app" \
  --announce \
  --channel telegram \
  --to "-1001234567890"
```

`--command <shell>` stores `argv: ["sh", "-lc", <shell>]`. Use `--command-argv '["node","scripts/report.mjs"]'` for exact argv execution without shell parsing. Optional `--command-env KEY=VALUE` (repeatable), `--command-input`, `--timeout-seconds` (default 10 minutes), `--no-output-timeout-seconds`, and `--output-max-bytes` control the process environment, stdin, and output bounds.

Delivered text is derived from process output: non-empty stdout wins; if stdout is empty and stderr is non-empty, stderr is delivered; if both are present, the scheduler sends a small `stdout:` / `stderr:` block. Exit code `0` records the run `ok`; non-zero exit, signal, timeout, or no-output timeout records `error` and can trigger failure alerts. A command that prints only `NO_REPLY` uses the normal automation silent-token suppression and posts nothing back to chat.

### Script payloads

Script payloads run headlessly in the same code-mode executor as trigger scripts, without starting a conversational agent turn. They are available by default; setting `cron.triggers.enabled: false` disables creation and execution of script payloads together with condition-trigger scripts and stream schedules. Script jobs support only `main` and `isolated` session targets.

```bash
openclaw automations create "0 * * * *" \
  --name "Hourly queue check" \
  --script ./automation/check-queue.js \
  --script-timeout-seconds 300 \
  --script-tool-budget 50 \
  --session isolated \
  --announce
```

Use `--script <file|->` to read JavaScript from a file or stdin. The timeout defaults to 300 seconds and is capped at 900; the tool budget defaults to 50 calls and is capped at 200. These payload budgets are separate from the smaller trigger-gate evaluation budgets.

The script may return an object with these optional fields:

- `notify`: Text delivered through the job's `announce`, `webhook`, or `none` delivery mode. If omitted, nothing is delivered. For a `main` job, the text becomes a system event.
- `wake`: `"now"` requests an immediate heartbeat after enqueueing `notify` (or a compact completion event); `"next-heartbeat"` enqueues the event for the next heartbeat.
- `state`: JSON state, capped at 16 KB and persisted only after a successful run. The next run receives a frozen copy as `trigger.state`, matching trigger scripts. Because that namespace has one persisted owner, a script payload cannot be combined with a condition trigger on the same job.
- `nextCheck`: A duration such as `"15m"`. It is valid only for jobs with pacing enabled and uses the same pacing clamp as agent-turn proposals.

Throws, timeouts, exhausted tool budgets, invalid results, and `nextCheck` without pacing are normal automation run errors: they enter run history, backoff, and failure-alert handling without persisting returned state.

## Execution styles

### Codex apps in scheduled automations

Codex-created automations can retain the app IDs and permission ceiling
available to the authenticated creator thread. At execution, OpenClaw requires
the same prepared Codex profile and account, then narrows the stored cap against
current app policy. Revoked apps, account/runtime changes, and interactive
approval requirements fail closed with a recovery message; they never fall
back to broader or different credentials. Older jobs without a captured app
envelope continue their ordinary non-app behavior; recreate or reauthorize one
only when it needs Codex app access. See
[Native Codex plugins](/plugins/codex-native-plugins#scheduled-automations).

| Style           | `--session` value   | Runs in                                              | Best for                        |
| --------------- | ------------------- | ---------------------------------------------------- | ------------------------------- |
| Main session    | `main`              | Owning agent's main session                          | Reminders, system events        |
| Isolated        | `isolated`          | Dedicated `cron:<jobId>`                             | Reports, background chores      |
| Current session | `current`           | Detached; commits to the creation-bound conversation | Context-aware recurring work    |
| Custom session  | `session:custom-id` | Persistent named session                             | Workflows that build on history |

Agent-turn jobs default to the creating conversation when the create request carries session context. Callers without a session key, including CLI and API callers that do not supply one, fall back to `isolated`. System events and heartbeats still default to `main`; command and script payloads still default to `isolated`.

<AccordionGroup>
  <Accordion title="Main session vs current vs isolated vs custom">
    **Main session** jobs enqueue a system event into the owning agent's main session and optionally wake the heartbeat (`--wake now` or `--wake next-heartbeat`). The event is processed with that session's existing context and last delivery context. Internal automation turns do not extend daily or idle reset freshness; only visible user activity updates session freshness. **Current-session** jobs execute in a detached run session, read a bounded tail of the conversation captured when the job was created, and commit the final visible assistant result back to that exact conversation. **Isolated** jobs run a dedicated agent turn with a fresh session. **Custom sessions** (`session:xxx`) persist context across runs, enabling workflows like daily standups that build on previous summaries.

    Main-session automation events are self-contained system-event reminders. They do not automatically include the default heartbeat prompt or the heartbeat monitor scratch; say it explicitly in the automation event text if a reminder should consult that context.

    Main-session jobs use the owning session's delivery context, not a separate chat announce target. Edits that enable announce delivery, or set a chat target without explicitly choosing no delivery, are rejected without changing the job. Use an isolated job with `--message` and `--announce` for chat delivery. Primary webhook delivery remains supported for main-session jobs.

  </Accordion>
  <Accordion title="What 'fresh session' means for isolated jobs">
    A new transcript/session id per run. OpenClaw carries safe preferences (thinking/fast/verbose settings, labels, explicit user-selected model/auth overrides), but does not inherit ambient conversation context from an older automation session row: channel/group routing, send or queue policy, elevation, origin, or ACP runtime binding. Use `current` or `session:<id>` when a recurring job should deliberately build on the same conversation context.
  </Accordion>
  <Accordion title="Unattended run contract">
    Isolated automation and hook agent turns are explicitly unattended: no one is present to clarify or approve. The final reply must be the deliverable rather than a plan, acknowledgement, or request for input. The agent returns `NO_REPLY` when nothing needs doing and states failures plainly; the scheduler owns retry and failure-alert policy.

    For trusted scheduled jobs, the job's own instructions win when they intentionally ask for a question or plan, and the agent may remove a job that is no longer needed. External hook turns receive only the common unattended contract; they do not receive that override or self-removal guidance across the external-content boundary.

  </Accordion>
  <Accordion title="Subagent and Discord delivery">
    When isolated automation runs orchestrate subagents, delivery prefers the final descendant output over stale parent interim text. If descendants are still running, OpenClaw suppresses that partial parent update instead of announcing it.

    For text-only Discord announce targets, OpenClaw sends the canonical final assistant text once instead of replaying both streamed/intermediate text and the final answer. Media and structured Discord payloads are still delivered separately so attachments and components are not dropped.

  </Accordion>
</AccordionGroup>
