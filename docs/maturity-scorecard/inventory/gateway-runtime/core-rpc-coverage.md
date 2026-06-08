---
title: Gateway Runtime WebSocket Feature Matrix - Gateway RPC APIs and Events
version: 3
last_refreshed: 2026-05-29
last_refreshed_by: codex
feature_family: Gateway RPC APIs and Events
feature_slug: core-rpc-coverage
---

# Gateway RPC APIs and Events

## Summary

Core RPC coverage is broad in source and docs: the Gateway has typed
descriptors, scope metadata, advertised-method and event discovery, lazy handler
modules, request/response/event framing, two-stage accepted-then-final result
semantics, and many handler implementations for the system, identity, model,
usage, session, channel, config, wizard, agent, automation, task, tool, and
skill families.

The maturity limit is not raw implementation breadth. The family is too broad
for a `Coverage: Yes` score because real Gateway/server-flow tests cover several
representative paths, but many important method groups still rely on handler or
unit tests rather than end-to-end WS/RPC proof. Archive evidence also shows
substantial historical user/operator pain around `agent.wait`, `cron.run`,
`tools.invoke`, `commands.list`, `skills.status`, and status/channel reporting.

## Features

- Health APIs: `health` and `status` RPCs.
- Identity and presence APIs: `gateway.identity.get`, `system-presence`, `system-event`, and heartbeat RPCs.
- Model APIs: `models.list` RPCs.
- Usage and memory APIs: Usage summaries and memory readiness RPCs.
- Session APIs: `sessions.*` RPCs.
- Chat APIs: `chat.*` and `agent.wait` RPCs.
- Channel APIs: `channels.status` and `channels.logout` RPCs.
- Web login and wake APIs: `web.login.*`, `push.test`, and `voicewake.*` RPCs.
- Config and secrets APIs: `config.*` and `secrets.*` RPCs.
- Update and setup APIs: `update.*` and `wizard.*` RPCs.
- Agent and artifact APIs: `agents.*`, agent files, environments, and artifact RPCs.
- Task and automation APIs: `wake`, `cron.*`, and `tasks.*` RPCs.
- Tool and skill APIs: `commands.list`, `tools.*`, and `skills.*` RPCs.
- Request and event envelopes: Request, response, and event frame shapes.
- Idempotent side effects: Idempotency requirements for side-effecting methods.
- Method discovery: Method discovery via `hello-ok.features.methods`.
- Event discovery: Event discovery via `hello-ok.features.events`.
- Accepted-then-final results: Immediate accepted ack plus later final result.
- Event ordering: Sequence handling and per-client monotonic event ordering.
- State refresh after gaps: No-replay event model and explicit gap recovery via state refresh.

## Archive Freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: 68

Label: Partial

Positive signals:

- The docs enumerate the Core RPC families in one place: system/identity,
  models/usage, channels/login helpers, config/update/wizard, agent/workspace
  helpers, automation/skills/tools, and operator helper methods are described
  in `docs/gateway/protocol.md:334`, `docs/gateway/protocol.md:346`,
  `docs/gateway/protocol.md:358`, `docs/gateway/protocol.md:400`,
  `docs/gateway/protocol.md:415`, `docs/gateway/protocol.md:474`, and
  `docs/gateway/protocol.md:543`.
- `docs/gateway/index.md:312` states that `hello-ok.features.methods` is the
  conservative discovery list, and `docs/gateway/index.md:331` describes
  liveness/readiness checks that use Gateway RPCs.
- `src/gateway/methods/core-descriptors.ts:18` declares the core method specs
  and scopes, including the inventory families at
  `src/gateway/methods/core-descriptors.ts:87`,
  `src/gateway/methods/core-descriptors.ts:94`,
  `src/gateway/methods/core-descriptors.ts:109`,
  `src/gateway/methods/core-descriptors.ts:128`,
  `src/gateway/methods/core-descriptors.ts:174`, and
  `src/gateway/methods/core-descriptors.ts:182`.
- `src/gateway/server-methods-list.ts:11` builds the advertised core method
  list, and `src/gateway/server/ws-connection/message-handler.ts:1799` includes
  the method list in `hello-ok.features`.
- `src/gateway/server-methods.ts:248` wires lazy core handlers across most
  inventory groups, with visible groupings for health/status, channels, cron,
  config, wizard, tools, skills, sessions, system identity/presence,
  update, usage, agent, agents, and artifacts at
  `src/gateway/server-methods.ts:265`, `src/gateway/server-methods.ts:269`,
  `src/gateway/server-methods.ts:281`, `src/gateway/server-methods.ts:356`,
  `src/gateway/server-methods.ts:368`, `src/gateway/server-methods.ts:398`,
  `src/gateway/server-methods.ts:423`, `src/gateway/server-methods.ts:439`,
  `src/gateway/server-methods.ts:467`, `src/gateway/server-methods.ts:477`,
  `src/gateway/server-methods.ts:523`, `src/gateway/server-methods.ts:533`,
  `src/gateway/server-methods.ts:537`, and
  `src/gateway/server-methods.ts:549`.
- Real Gateway/WS or live-flow proof exists for important representatives:
  `health`, `status`, `system-presence`, heartbeat, and `system-event` in
  `src/gateway/server.health.test.ts:28`, `src/gateway/server.health.test.ts:55`,
  and `src/gateway/server.health.test.ts:110`; `sessions.create` plus
  `agent.wait` in `src/gateway/server.sessions.create.test.ts:246`; `chat.send`
  and `chat.history` in `src/gateway/server.chat.gateway-server-chat-b.test.ts:123`
  and `src/gateway/server.chat.gateway-server-chat-b.test.ts:1002`;
  `models.list` and `voicewake.*` in
  `src/gateway/server.models-voicewake-misc.test.ts:148`,
  `src/gateway/server.models-voicewake-misc.test.ts:230`, and
  `src/gateway/server.models-voicewake-misc.test.ts:473`;
  `config.get` / `config.set` in `src/gateway/server.config-patch.test.ts:145`;
  `channels.status` in `src/gateway/server.channels.test.ts:106`;
  `tools.catalog` in `src/gateway/server.tools-catalog.test.ts:7`; and
  `wizard.start` in `src/gateway/gateway.test.ts:391`.
- Live tests use `chat.send`, `chat.history`, `agent.wait`, and `sessions.list`
  against live Gateway clients in `src/gateway/gateway-acp-bind.live.test.ts:391`,
  `src/gateway/gateway-acp-bind.live.test.ts:422`,
  `src/gateway/gateway-acp-bind.live.test.ts:456`,
  `src/gateway/gateway-codex-harness.live.test.ts:369`,
  `src/gateway/gateway-codex-harness.live.test.ts:418`, and
  `src/gateway/gateway-codex-harness.live.test.ts:795`.

Negative signals:

- Several inventory groups are implemented and unit-tested, but lack comparable
  real Gateway/WS proof in the evidence found here: `commands.list`,
  `skills.status/search/detail/install/update`, `skills.upload.*`,
  `tasks.*`, several `cron.*` methods, `web.login.*`, `push.test`,
  `environments.*`, and most `artifacts.*`.
- `tools.invoke` has direct RPC handler tests in
  `src/gateway/tools-invoke-http.test.ts:966`, but the evidence found here does
  not show a full WS client flow exercising the method through the live Gateway
  registry.
- Archive reports show that the most important runtime methods have repeatedly
  regressed or confused operators, especially around long waits, cron manual
  runs, tool invocation, command discovery, skill visibility, and channel/status
  summaries.

Integration gaps:

- Add an explicit "Core RPC smoke" server-flow suite that connects a real WS
  client, reads `hello-ok.features.methods`, and samples every method family
  with harmless read-only or controlled write calls.
- Add real Gateway/WS proof for `commands.list`, `skills.status`,
  `skills.search`, `skills.detail`, `tasks.list`, `tasks.get`, `cron.list`,
  `cron.status`, `cron.run` correlation, `web.login.*` via a fixture channel,
  and `tools.invoke`.
- Add cross-method discovery checks so documented methods, core descriptors,
  advertised method lists, and available handlers cannot drift independently.

## Quality

Score: 57

Label: Medium

Gitcrawl reports:

- `gitcrawl search issues "channels.status" -R openclaw/openclaw --state all --json number,title,url,state`
  returned 20 results. Notable quality signals: closed bugs for empty or
  mismatched status/channel tables in #73525, #73824, #72993, #73518, #73582,
  #46494, #72906, #17105, #67937, #67938, #75340, #53544, #11094, #55032, and
  #73605; open #77709 reports Feishu omitted from `status --deep`.
- `gitcrawl search issues "tools.invoke" -R openclaw/openclaw --state all --json number,title,url,state`
  returned 20 results. Notable quality signals: closed bugs/features for missing
  cron/tools support and tool availability in #55430, #54391, #68874, #74705,
  #52888, #44071, #79849, #76616, and #74019; open feature requests #13948
  and #8287 ask for action-level tool deny and node-registered agent tools.
- `gitcrawl search issues "agent.wait" -R openclaw/openclaw --state all --json number,title,url,state`
  returned 20 results. Notable quality signals: closed reports around timeouts,
  orphaned subagents, delivery drops, and crashes in #4133, #19506, #49494,
  #45926, #63718, #61947, and #40862; open reports #74363, #58067, #54622,
  #78656, and #68065 still point at wait/lane/delivery rough edges.
- `gitcrawl search issues "cron.run" -R openclaw/openclaw --state all --json number,title,url,state`
  returned 20 results. Notable quality signals: closed cron manual-run
  deadlocks/timeouts/history gaps in #19601, #52898, #44232, #38755, #20288,
  #25981, #29601, #62876, #42579, #43008, #54320, and #19300; #80019 added a
  read-only cron inspection scope and #16799 requested better status UX for
  cron-heavy setups.
- `gitcrawl search issues "skills.status" -R openclaw/openclaw --state all --json number,title,url,state`
  returned 20 results. Notable quality signals: closed bugs #57678, #1843,
  #8290, #21094, #57599, #58712, #64816, and feature #37595; open #78553,
  #85015, #80206, #59078, and #73082 show remaining UI/setup expectation
  pressure.
- `gitcrawl search issues "commands.list" -R openclaw/openclaw --state all --json number,title,url,state`
  returned 20 results. Notable quality signals: #80061 says the Gateway RPC was
  silently removed while docs still advertised it, #52919 added the RPC for
  remote clients, and #38856/#38857/#38858/#38863 plus #29012 show autocomplete
  and per-agent/per-channel command configuration pressure.
- `gitcrawl search issues "config.schema Gateway RPC" -R openclaw/openclaw --state all --json number,title,url,state`
  returned 20 results. Notable quality signals: closed #36508 and #81409 around
  `config.get` / config schema behavior; open #86136 asks to allow agent
  `config.patch` hardening of bundled discovery; open #46656 and #74632 request
  additional callback/session envelope RPC shape.
- `gitcrawl search issues "gateway identity get system-presence system-event heartbeat" -R openclaw/openclaw --state all --json number,title,url,state`
  returned `[]`.

Discrawl reports:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json sql "<FTS count query>"` counted
  exact-term archive hits: `channels.status=6302`, `agent.wait=332`,
  `tools.invoke=501`, `cron.run=1984`, `skills.status=268`,
  `commands.list=143`, and `config.schema=2451`.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "channels.status"`
  returned users-helping-users reports from 2026-05-25 and 2026-05-06 where
  `channels status --probe` reported healthy/working while Slack or Telegram
  inbound delivery still failed; it also returned a 2026-05-23 log excerpt with
  a successful `channels.status` WS response during config/skills changes.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "agent.wait"` returned
  GitHub mirror comments for #49494, #42233, #66978, #64519, #63724, #62787,
  and #62469, mostly about timeout, self-call, keepalive, and completion-race
  fixes.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "tools.invoke"` returned
  a 2026-05-14 maintainer note that direct Gateway `tools.invoke` and MCP
  loopback run `before_tool_call` but do not consistently run `after_tool_call`,
  plus user-facing `/tools/invoke` auth/thread-reply guidance from 2026-04-27.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "cron.run"` returned
  2026-05-17 maintainer/user discussion of `openclaw cron run --wait`
  behavior and 2026-05-15 maintainer commentary that #81929's exact-`runId`
  wait shape looked safe while keeping the Gateway RPC itself non-blocking.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "skills.status"` returned
  GitHub mirror comments closing #57678, #60504, #46063, #42095, and #37595,
  plus user doctor/skills status outputs showing visible missing-requirement and
  eligibility state.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "commands.list"` returned
  user log excerpts from 2026-05-25 and 2026-05-02 showing slow
  `commands.list`, `models.list`, `sessions.list`, and `chat.history` WS
  responses, plus GitHub mirror comments for command autocomplete and command
  advertisement behavior.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "config.schema Gateway RPC"`
  returned maintainer review comments about config-schema compatibility and
  sensitive path registration, plus user guidance that `config.get` / schema
  building can be expensive and is part of Gateway probe behavior.

Good qualities:

- Method ownership is explicit and typed through core descriptors and method
  scopes, rather than ad hoc dispatch strings.
- Handler loading is lazy and grouped by capability family, which protects
  Gateway hot paths from eagerly importing every feature implementation.
- The archive shows many historical issues have been closed with targeted fixes
  and follow-up reports, suggesting the surface is actively maintained.

Bad qualities:

- Core RPC is a wide operational surface, so drift between docs, descriptors,
  advertised methods, scopes, and handler availability is hard to spot until a
  user hits the specific method family.
- The archive shows repeated regressions in status/channel summaries, cron run
  behavior, tool visibility/invocation, command discovery, and agent wait
  completion semantics.
- Some direct invocation paths do not appear to share all lifecycle hooks or
  diagnostics with normal agent tool execution, based on the Discrawl
  `tools.invoke` maintainer note.
- `config.get` / schema behavior is powerful but can be expensive and has
  compatibility/sensitivity review history.
- Skills visibility/setup and command customization remain expectation gaps in
  open reports such as #78553, #85015, #73082, and #29012.
- Callback, session-envelope, and config-hardening requests in #46656, #74632,
  and #86136 show RPC shape expectations adjacent to the current Core RPC
  contract.

## Known gaps

- Coverage gaps remain for skill search/detail/install/update and upload,
  command listing, task ledger inspection/cancellation, cron inspection/manual
  run correlation, web login fixture flow, push test, tool invocation, and
  artifacts/environments.
- Direct Gateway tool invocation does not consistently appear to share the
  lifecycle-hook path and diagnostics of normal agent tool execution.
- Historical #80061 reported a docs/source mismatch for `commands.list`, which
  is the kind of drift this Core RPC surface remains sensitive to.
- Open reports request multi-agent skill visibility, skills setup clarity,
  command customization, action-level tool deny, node-registered agent tools,
  inline callback RPCs, per-session envelopes, and agent config hardening.

## Evidence

Docs:

- `docs/gateway/protocol.md:334` documents system/identity RPCs.
- `docs/gateway/protocol.md:346` documents models/usage/memory-readiness RPCs.
- `docs/gateway/protocol.md:358` documents channel/login/push/voicewake RPCs.
- `docs/gateway/protocol.md:400` documents secrets/config/update/wizard RPCs.
- `docs/gateway/protocol.md:415` documents agent/workspace/tasks/artifacts and
  `agent.wait`.
- `docs/gateway/protocol.md:474` documents wake/cron/tools/skills RPCs.
- `docs/gateway/protocol.md:543` documents `commands.list`, `tools.*`, and
  `skills.*` operator helper contracts.
- `docs/gateway/index.md:312` documents operator protocol discovery and the
  two-stage agent run shape.
- `docs/gateway/index.md:331` documents operational liveness/readiness and gap
  recovery calls.

Source:

- `src/gateway/methods/core-descriptors.ts:18` declares core method specs.
- `src/gateway/methods/core-descriptors.ts:224` derives advertised method names.
- `src/gateway/server-methods-list.ts:11` builds advertised core + aux + channel
  methods.
- `src/gateway/server.impl.ts:1143` loads core and aux handlers during Gateway
  startup; `src/gateway/server.impl.ts:1191` publishes the attached method list.
- `src/gateway/server/ws-connection/message-handler.ts:1799` sends methods in
  `hello-ok.features`.
- `src/gateway/server-methods.ts:248` defines lazy `coreGatewayHandlers`.
- `src/gateway/server-methods.ts:592` routes Gateway requests through method
  authorization and the method registry.

Integration tests:

- `src/gateway/server.health.test.ts:28` covers `connect`, `health`, `status`,
  and `system-presence` through a real WS harness.
- `src/gateway/server.health.test.ts:55` covers heartbeat event broadcast,
  `last-heartbeat`, and `set-heartbeats` through the WS harness.
- `src/gateway/server.health.test.ts:110` covers `system-event` and presence
  event sequencing through the WS harness.
- `src/gateway/server.sessions.create.test.ts:246` covers `sessions.create`
  auto-start plus `agent.wait` through a Gateway client.
- `src/gateway/server.chat.gateway-server-chat-b.test.ts:123` covers
  `chat.history`; `src/gateway/server.chat.gateway-server-chat-b.test.ts:1002`
  covers `chat.send`.
- `src/gateway/server.models-voicewake-misc.test.ts:148` and
  `src/gateway/server.models-voicewake-misc.test.ts:473` cover `models.list`
  through Gateway RPC.
- `src/gateway/server.models-voicewake-misc.test.ts:230` covers
  `voicewake.get` / `voicewake.set` plus event broadcast.
- `src/gateway/server.config-patch.test.ts:145` covers `config.get` /
  `config.set`; `src/gateway/server.config-patch.test.ts:266` covers
  `config.get` redaction.
- `src/gateway/server.channels.test.ts:106` covers `channels.status`.
- `src/gateway/server.tools-catalog.test.ts:7` covers `tools.catalog`.
- `src/gateway/gateway.test.ts:391` covers `wizard.start`.
- `src/gateway/gateway-acp-bind.live.test.ts:391`,
  `src/gateway/gateway-acp-bind.live.test.ts:422`, and
  `src/gateway/gateway-acp-bind.live.test.ts:456` cover live `chat.history`,
  `agent.wait`, and `chat.send`.
- `src/gateway/gateway-codex-harness.live.test.ts:369`,
  `src/gateway/gateway-codex-harness.live.test.ts:418`, and
  `src/gateway/gateway-codex-harness.live.test.ts:795` cover live `chat.send`,
  `agent.wait`, and `sessions.list`.

Unit tests:

- `src/gateway/server-methods-list.test.ts:12` covers advertised method list
  behavior.
- `src/gateway/method-scopes.test.ts:38` covers least-privilege scope
  resolution for Core RPC methods; `src/gateway/method-scopes.test.ts:379`
  guards classification for every exposed core handler method.
- `src/gateway/server-methods/commands.test.ts:203` covers `commands.list`.
- `src/gateway/server-methods/tasks.test.ts:80` covers `tasks.list`,
  `src/gateway/server-methods/tasks.test.ts:122` covers `tasks.get`, and
  `src/gateway/server-methods/tasks.test.ts:197` covers `tasks.cancel`.
- `src/gateway/server-methods/cron.validation.test.ts:91` covers direct
  `cron.add/get/update/remove` handler invocation; `src/gateway/server-methods/cron.validation.test.ts:717`
  covers `wake`.
- `src/gateway/server-methods/web.start.test.ts:82` covers `web.login.start`
  and `src/gateway/server-methods/web.start.test.ts:152` covers
  `web.login.wait`.
- `src/gateway/server-methods/push.test.ts:124` covers `push.test`.
- `src/gateway/server-methods/environments.test.ts:64` covers
  `environments.list` / `environments.status`.
- `src/gateway/tools-invoke-http.test.ts:966` covers direct Gateway RPC
  `tools.invoke` envelope behavior.

Gitcrawl queries:

- Command:
  `gitcrawl search issues "channels.status" -R openclaw/openclaw --state all --json number,title,url,state`
  - Results: 20 rows, including #73525, #69341, #73824, #72993, #56949,
    #33070, #73518, #73582, #55744, #77709, #46494, #72906, #17105, #67937,
    #67938, #75340, #53544, #11094, #55032, #73605.
- Command:
  `gitcrawl search issues "tools.invoke" -R openclaw/openclaw --state all --json number,title,url,state`
  - Results: 20 rows, including #55430, #54391, #42471, #68874, #74705,
    #46052, #50279, #68979, #52888, #3906, #44071, #79849, #76616, #74019,
    #17356, #65975, #13948, #9857, #8287, #14363.
- Command:
  `gitcrawl search issues "agent.wait" -R openclaw/openclaw --state all --json number,title,url,state`
  - Results: 20 rows, including #4343, #4133, #74363, #10334, #11284, #19506,
    #82791, #58067, #49494, #54622, #45926, #78656, #68065, #40040, #63718,
    #65505, #30581, #61947, #12423, #40862.
- Command:
  `gitcrawl search issues "cron.run" -R openclaw/openclaw --state all --json number,title,url,state`
  - Results: 20 rows, including #19601, #52898, #44232, #38755, #33577,
    #80019, #20288, #69162, #83605, #25981, #87174, #13947, #29601, #16799,
    #62876, #42579, #14356, #43008, #54320, #19300.
- Command:
  `gitcrawl search issues "skills.status" -R openclaw/openclaw --state all --json number,title,url,state`
  - Results: 20 rows, including #57678, #1843, #78553, #7993, #8290, #40853,
    #85015, #21094, #80206, #57599, #58712, #73082, #57053, #85263, #8969,
    #37595, #52572, #84968, #59078, #64816.
- Command:
  `gitcrawl search issues "commands.list" -R openclaw/openclaw --state all --json number,title,url,state`
  - Results: 20 rows, including #12985, #80061, #52919, #53253, #17061,
    #38857, #38856, #38863, #38858, #66958, #81183, #68333, #74195, #29012,
    #77730, #66975, #51865, #62803, #56621, #62335.
- Command:
  `gitcrawl search issues "config.schema Gateway RPC" -R openclaw/openclaw --state all --json number,title,url,state`
  - Results: 20 rows, including #61559, #36508, #46656, #75780, #50195, #8374,
    #70318, #3644, #72496, #74632, #76600, #81409, #17328, #74918, #81311,
    #52830, #86136, #77753, #50174, #52071.
- Command:
  `gitcrawl search issues "gateway identity get system-presence system-event heartbeat" -R openclaw/openclaw --state all --json number,title,url,state`
  - Results: `[]`.

Discrawl queries:

- Command:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "channels.status"`
  - Results: 5 messages. Top matches included 2026-05-25 users-helping-users
    Slack Socket Mode reports where channel status looked healthy but inbound
    events were absent; a 2026-05-23 log excerpt with `channels.status`; a
    2026-05-06 Telegram report where `channels status --probe` said working but
    inbound messages/logs were absent; and a 2026-05-03 maintainer note about
    tracking tool calls to messages.
- Command:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "agent.wait"`
  - Results: 10 messages. Top matches included GitHub mirror comments for
    #49494, #42233, #66978, #64519, #63724, #62787, and #62469, plus a
    `clawtributors` session-tool-surface mention.
- Command:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "tools.invoke"`
  - Results: 10 messages. Top matches included a 2026-05-14 maintainer note
    that direct Gateway `tools.invoke` lacks consistent `after_tool_call`
    coverage, plus 2026-04-27 user-facing n8n/Feishu `/tools/invoke` guidance.
- Command:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "cron.run"`
  - Results: 10 messages. Top matches included 2026-05-17 discussion of
    forced cron-run proof and 2026-05-15 maintainer commentary that #81929's
    `cron run --wait` shape was safe because it waits on an exact `runId`.
- Command:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "skills.status"`
  - Results: 10 messages. Top matches included GitHub mirror comments closing
    #57678, #60504, #46063, #42095, and #37595, plus user-visible doctor and
    skills status outputs.
- Command:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "commands.list"`
  - Results: 10 messages. Top matches included 2026-05-25 and 2026-05-02 user
    log excerpts with slow `commands.list` / `models.list` / `sessions.list`
    RPCs and GitHub mirror comments for Control UI autocomplete.
- Command:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "config.schema Gateway RPC"`
  - Results: 10 messages. Top matches included config-schema review comments
    and user/maintainer guidance that `config.get` and schema construction can
    be expensive or compatibility-sensitive.
- Command:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json sql "select ... from message_fts where message_fts match '\"<term>\"' ..."`
  - Results:
    `channels.status=6302`, `agent.wait=332`, `tools.invoke=501`,
    `cron.run=1984`, `skills.status=268`, `commands.list=143`,
    `config.schema=2451`.
