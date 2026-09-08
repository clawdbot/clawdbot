---
title: "v2026.8.1: Quality-of-Life Improvements"
description: "Everyday work takes less effort to find, follow, move, and protect, including past conversations, visible progress on long jobs, and cloud or paired-computer sessions."
---

Everyday work in OpenClaw now takes less effort to find, follow, move, and protect. [Past conversations](/concepts/session-search) are easier to return to, long jobs keep useful progress visible, portable snapshots can be checked before they are needed, and eligible work can run on a [cloud worker](/gateway/cloud-workers) or [paired computer](/gateway/cloud-sessions), with cloud sessions later reclaimed to the main machine. Voice, video, meeting capture, agent tools, keyboard access, maintained translations, interface polish, and documentation also pick up changes that make the product easier to use across ordinary work.

<AccordionGroup>

<Accordion title="Past Conversations and Long-Running Work">

[Past conversations](/concepts/session-search) and long-running work are easier to find and follow. The session catalog groups and opens Codex, Claude Code, OpenCode, and Pi work from the main OpenClaw computer or an eligible paired one, and each session can carry one of eight colors across the Control UI, macOS, iOS, and Android. An eligible Claude Code continuation also brings its chosen color and renamed title into OpenClaw without replacing later edits. Durable [progress cards](/tools/progress-card) survive reloads and reconnects, and background-task history is available on the web, iOS, and Android. An optional observer can summarize a conversation, answer questions about it, show its timeline, and alert an operator when attention is needed.

Resume support depends on the runtime that owns the session. OpenCode and Pi catalogs are view-only, paired-computer actions need an opted-in capable host and an eligible session, and external transcripts remain with their original runtime. The observer can be disabled and requires an available utility model.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add shareable board filtering to Workboard [#102068](https://github.com/openclaw/openclaw/pull/102068)
- Browse Codex sessions across Gateway and nodes [#102586](https://github.com/openclaw/openclaw/pull/102586)
- Add native Codex session supervision [#104045](https://github.com/openclaw/openclaw/pull/104045)
- Show Codex sessions and transcripts in the sidebar [#104437](https://github.com/openclaw/openclaw/pull/104437)
- Browse Claude sessions across paired computers [#104528](https://github.com/openclaw/openclaw/pull/104528)
- Durable child-session state notices and reconciliation [#104636](https://github.com/openclaw/openclaw/pull/104636)
- Bring Claude Code and Codex histories into native sessions [#104717](https://github.com/openclaw/openclaw/pull/104717)
- Let session coordinators watch peer state changes [#104815](https://github.com/openclaw/openclaw/pull/104815)
- Add full-text recall across past sessions [#105057](https://github.com/openclaw/openclaw/pull/105057)
- Create provider-native sessions from the sidebar [#105810](https://github.com/openclaw/openclaw/pull/105810)
- Continue Claude Code sessions on paired nodes [#105833](https://github.com/openclaw/openclaw/pull/105833)
- Reinforce follow-through on promised agent work [#105958](https://github.com/openclaw/openclaw/pull/105958)
- Expose safe session classification facts to clients [#106832](https://github.com/openclaw/openclaw/pull/106832)
- Show compaction savings and active-run time in Control UI [#106921](https://github.com/openclaw/openclaw/pull/106921)
- Continue paired-node Codex sessions from the Control UI [#106927](https://github.com/openclaw/openclaw/pull/106927)
- Discover OpenCode and Pi sessions on local and paired nodes [#106941](https://github.com/openclaw/openclaw/pull/106941)
- feat(sessions): upstream liveness for adopted catalog sessions [#107009](https://github.com/openclaw/openclaw/pull/107009)
- Open Codex and Claude sessions in their native terminal [#107086](https://github.com/openclaw/openclaw/pull/107086)
- Resume OpenCode and Pi sessions in the terminal [#107200](https://github.com/openclaw/openclaw/pull/107200)
- Show live agent plan checklists in chat channels [#108597](https://github.com/openclaw/openclaw/pull/108597)
- Show live plan checklists in first-party chat clients [#108675](https://github.com/openclaw/openclaw/pull/108675)
- Show Atlas and ChatGPT Codex sessions in the catalog [#109142](https://github.com/openclaw/openclaw/pull/109142)
- Inspect background tasks across web, iOS, and Android [#109150](https://github.com/openclaw/openclaw/pull/109150)
- Show live plan checklists inside the chat thread [#109343](https://github.com/openclaw/openclaw/pull/109343)
- Group Codex and Claude session catalogs by project [#109575](https://github.com/openclaw/openclaw/pull/109575)
- Speed up native session loading from paired Macs [#110030](https://github.com/openclaw/openclaw/pull/110030)
- Keep main agents aware of same-agent group activity [#110332](https://github.com/openclaw/openclaw/pull/110332)
- Flow dashboard thread activity back to the main agent [#110913](https://github.com/openclaw/openclaw/pull/110913)
- Keep reset session history searchable [#111194](https://github.com/openclaw/openclaw/pull/111194)
- Connect session dashboards end to end [#111218](https://github.com/openclaw/openclaw/pull/111218)
- Show online users and session viewers on shared Gateways [#111225](https://github.com/openclaw/openclaw/pull/111225)
- Connect Workboard cards with live session dashboards [#111989](https://github.com/openclaw/openclaw/pull/111989)
- Align chat widgets, add dashboard deep links, and show trust status [#112076](https://github.com/openclaw/openclaw/pull/112076)
- Add Gateway session observer digests [#112216](https://github.com/openclaw/openclaw/pull/112216)
- Add the session observer HUD and status summaries [#112260](https://github.com/openclaw/openclaw/pull/112260)
- Add direct WorkBoard routes, sidebar pins, icons, and colors [#112302](https://github.com/openclaw/openclaw/pull/112302)
- Add Beam read-only coding session sharing [#112323](https://github.com/openclaw/openclaw/pull/112323)
- Simplify coding session headers and add Codex thread creation [#112354](https://github.com/openclaw/openclaw/pull/112354)
- Add native WorkBoard widgets to session dashboards [#112434](https://github.com/openclaw/openclaw/pull/112434)
- Ask the session observer from the Control UI [#112448](https://github.com/openclaw/openclaw/pull/112448)
- Add an Observer timeline card to session boards [#112565](https://github.com/openclaw/openclaw/pull/112565)
- Show safe model preambles as live session subtitles [#112958](https://github.com/openclaw/openclaw/pull/112958)
- Show subagent details inside the Background tasks rail [#113671](https://github.com/openclaw/openclaw/pull/113671)
- Continue Pi and OpenCode sessions from the catalog [#113718](https://github.com/openclaw/openclaw/pull/113718)
- Notify operators when background sessions need attention [#113819](https://github.com/openclaw/openclaw/pull/113819)
- Reorder custom sidebar groups around built-in session sections [#113948](https://github.com/openclaw/openclaw/pull/113948)
- Detect external activity in adopted Pi and OpenCode sessions [#113957](https://github.com/openclaw/openclaw/pull/113957)
- Mirror local coding sessions to a team Beam receiver [#114735](https://github.com/openclaw/openclaw/pull/114735)
- Reuse live Codex app-server threads safely [#115089](https://github.com/openclaw/openclaw/pull/115089)
- Speed up session listings with prepared plugin metadata [#117707](https://github.com/openclaw/openclaw/pull/117707)
- Remove quadratic work from streaming fanout [#118192](https://github.com/openclaw/openclaw/pull/118192)
- Keep session dashboards responsive during concurrent streaming [#118207](https://github.com/openclaw/openclaw/pull/118207)
- Add CLI commands to archive and delete sessions [#118791](https://github.com/openclaw/openclaw/pull/118791)
- Make bulk session archive complete in one batch [#120493](https://github.com/openclaw/openclaw/pull/120493)
- Resume recent sessions directly from the CLI [#120664](https://github.com/openclaw/openclaw/pull/120664)
- Resume Codex catalog sessions reliably in a full-size terminal [#120708](https://github.com/openclaw/openclaw/pull/120708)
- Continue dashboard sessions directly from the CLI [#120893](https://github.com/openclaw/openclaw/pull/120893)
- Prevent busy sessions from delaying other gateway updates [#121104](https://github.com/openclaw/openclaw/pull/121104)
- Retire inferred follow-up commitments [#121479](https://github.com/openclaw/openclaw/pull/121479)
- Show live subagent activity and edit counts in Control UI chat [#121840](https://github.com/openclaw/openclaw/pull/121840)
- Recover sessions interrupted by Gateway restarts [#122644](https://github.com/openclaw/openclaw/pull/122644)
- Continue a Control UI session in the terminal [#122870](https://github.com/openclaw/openclaw/pull/122870)
- Open live subagent details in the Chat sidebar [#122941](https://github.com/openclaw/openclaw/pull/122941)
- Open every task in one shared details panel [#123003](https://github.com/openclaw/openclaw/pull/123003)
- Add opt-in Anthropic server-side compaction [#123402](https://github.com/openclaw/openclaw/pull/123402)
- Add server-side context compaction for xAI sessions [#123622](https://github.com/openclaw/openclaw/pull/123622)
- Add extra Codex homes to the session catalog [#124660](https://github.com/openclaw/openclaw/pull/124660)
- Keep durable agent work visible and archive inactive sessions [#124925](https://github.com/openclaw/openclaw/pull/124925)
- Add main-session visibility and trusted-room routing [#124965](https://github.com/openclaw/openclaw/pull/124965)
- Show agent creation hierarchy in the Control UI [#124967](https://github.com/openclaw/openclaw/pull/124967)
- Show full Workboard boards on session dashboards [#125094](https://github.com/openclaw/openclaw/pull/125094)
- Add durable progress cards for agent sessions [#125125](https://github.com/openclaw/openclaw/pull/125125)
- Pin live session progress cards to the dashboard [#125438](https://github.com/openclaw/openclaw/pull/125438)
- Prefer delegation in main sessions and coalesce watcher wakes [#125691](https://github.com/openclaw/openclaw/pull/125691)
- Prompt eligible agents to keep progress cards current [#125701](https://github.com/openclaw/openclaw/pull/125701)
- Add standalone and browser-fullscreen dashboards [#125806](https://github.com/openclaw/openclaw/pull/125806)
- Make Activity session filters compact and easier to use [#125917](https://github.com/openclaw/openclaw/pull/125917)
- Link agent-created pull requests to public work sessions [#126057](https://github.com/openclaw/openclaw/pull/126057)
- refactor(anthropic): replace handwritten Claude sessions with Agent SDK [#128131](https://github.com/openclaw/openclaw/pull/128131)
- feat(github): surface team-session attribution [#129012](https://github.com/openclaw/openclaw/pull/129012)
- feat: per-session colors across web, macOS, iOS, Android with Claude Code import [#132570](https://github.com/openclaw/openclaw/pull/132570)
- Refresh Workboard from live changes [#99051](https://github.com/openclaw/openclaw/pull/99051)
- Use a plain Working label for agent progress [#107260](https://github.com/openclaw/openclaw/pull/107260)
- Cache unchanged Claude session-catalog metadata [#109309](https://github.com/openclaw/openclaw/pull/109309)
- Reuse SQLite connections when listing sessions [#113862](https://github.com/openclaw/openclaw/pull/113862)
- Guide subagent labels toward clear task titles [#113950](https://github.com/openclaw/openclaw/pull/113950)
- Speed up large session lists with request-local store reuse [#114003](https://github.com/openclaw/openclaw/pull/114003)
- Speed up session lists on gateways with many sessions [#114237](https://github.com/openclaw/openclaw/pull/114237)
- Clone only requested task-list pages [#114277](https://github.com/openclaw/openclaw/pull/114277)
- Cache local Git facts for session PR summaries [#114311](https://github.com/openclaw/openclaw/pull/114311)
- Reuse session catalog entries within each request [#114358](https://github.com/openclaw/openclaw/pull/114358)
- Speed up session Files panel loading with incremental transcript reads [#114401](https://github.com/openclaw/openclaw/pull/114401)
- Cache session branch summaries behind transcript watermarks [#114412](https://github.com/openclaw/openclaw/pull/114412)
- Cache local Claude session discovery [#114833](https://github.com/openclaw/openclaw/pull/114833)
- Incrementally revalidate SQLite session snapshots [#115359](https://github.com/openclaw/openclaw/pull/115359)
- Stream large Codex session JSONL scans [#115997](https://github.com/openclaw/openclaw/pull/115997)
- Reuse Claude transcript discovery across pagination pages [#116324](https://github.com/openclaw/openclaw/pull/116324)
- Reuse the Codex App Server for macOS catalog reads [#116325](https://github.com/openclaw/openclaw/pull/116325)
- Speed up bulk read, archive, and category changes for sessions [#120629](https://github.com/openclaw/openclaw/pull/120629)
- Make bulk session archiving substantially faster [#120873](https://github.com/openclaw/openclaw/pull/120873)
- Add live subagent activity and file-change stats to task events [#121549](https://github.com/openclaw/openclaw/pull/121549)
- Show live Codex subagent activity in task rows [#121899](https://github.com/openclaw/openclaw/pull/121899)
- Release compacted tool-result data from embedded-session memory [#122646](https://github.com/openclaw/openclaw/pull/122646)
- Name additional Codex session-catalog homes [#124807](https://github.com/openclaw/openclaw/pull/124807)
- Record agent creation origins and add roster tree output [#124828](https://github.com/openclaw/openclaw/pull/124828)
- Speed up chat history and startup loading [#125123](https://github.com/openclaw/openclaw/pull/125123)
- Keep Workboard visible in the Control UI sidebar [#125473](https://github.com/openclaw/openclaw/pull/125473)
- Let agents organize visible sessions by sidebar category [#126074](https://github.com/openclaw/openclaw/pull/126074)
- improve(ui): compact Live activity filters [#128972](https://github.com/openclaw/openclaw/pull/128972)
- improve(gateway): load session history faster without duplicate readers [#129114](https://github.com/openclaw/openclaw/pull/129114)
- Show Codex answer candidate lifecycle in Activity [#90610](https://github.com/openclaw/openclaw/pull/90610)
- Remove redundant sorting from task-list refreshes [#102202](https://github.com/openclaw/openclaw/pull/102202)
- Centralize session catalog search normalization [#108240](https://github.com/openclaw/openclaw/pull/108240)
- Split Control UI chat transcript ownership and retire legacy pins [#122420](https://github.com/openclaw/openclaw/pull/122420)
- Make progress cards choose the clearest representation [#125613](https://github.com/openclaw/openclaw/pull/125613)
- Link known PRs and issues in progress cards [#125887](https://github.com/openclaw/openclaw/pull/125887)
- Lazily scan transcripts for newest-event checks [#127162](https://github.com/openclaw/openclaw/pull/127162)

**Bug fixes**

- fix: gateway kill leaves Codex tool processes running [#107721](https://github.com/openclaw/openclaw/pull/107721)
- Make session usage fast on large, active histories [#108834](https://github.com/openclaw/openclaw/pull/108834)
- Stream native sessions as each host finishes [#110211](https://github.com/openclaw/openclaw/pull/110211)
- fix(agents): never drop or stall a steer accepted at the end of a turn [#127836](https://github.com/openclaw/openclaw/pull/127836)
- fix(sessions): prevent participant misattribution in Activity [#130986](https://github.com/openclaw/openclaw/pull/130986)
- fix(gateway): reduce memory pressure with large session histories [#131653](https://github.com/openclaw/openclaw/pull/131653)
- fix(agents): restore collector output and prepared harness execution [#131739](https://github.com/openclaw/openclaw/pull/131739)
- fix(cli): read session history from the canonical store, not a retired file [#132185](https://github.com/openclaw/openclaw/pull/132185)
- fix(worktrees): reclaim archived checkouts and bound disk allocation [#132706](https://github.com/openclaw/openclaw/pull/132706)
- fix: recovery compaction ignores Stop and loses committed counts [#133260](https://github.com/openclaw/openclaw/pull/133260)
- fix(agents): accept visible session-only subagent completions [9516211](https://github.com/openclaw/openclaw/commit/9516211)
- fix(handoff): skip orchestrator framing for solo agents without subagents [#102636](https://github.com/openclaw/openclaw/pull/102636)
- fix(sessions): keep retry identity on active rewrite branch [#126503](https://github.com/openclaw/openclaw/pull/126503)
- fix(agents): surface failed subagent completion notices [#128512](https://github.com/openclaw/openclaw/pull/128512)
- fix(agent-core): restore drained steer/follow-up to its source queue on abort [#128695](https://github.com/openclaw/openclaw/pull/128695)
- perf: per-delta cost grows with concurrent agent count because every delta walks every run's event listeners [#129174](https://github.com/openclaw/openclaw/pull/129174)
- fix(agents): expose queued session status [#131444](https://github.com/openclaw/openclaw/pull/131444)
- fix(compaction): record omitted images instead of dropping them silently [#131977](https://github.com/openclaw/openclaw/pull/131977)
- fix(subagents): recognize requester replies when retrying settle-wake delivery [#132032](https://github.com/openclaw/openclaw/pull/132032)
- fix(auto-reply): preserve successful compaction in terminal failures [#132084](https://github.com/openclaw/openclaw/pull/132084)
- fix(subagents): resolve completion recovery by exact run identity [#132111](https://github.com/openclaw/openclaw/pull/132111)
- fix(sessions): preserve defaults and managed parent repositories in visible spawns [#132364](https://github.com/openclaw/openclaw/pull/132364)
- fix(gateway): native subagent delivery stays pending after completion [#132430](https://github.com/openclaw/openclaw/pull/132430)
- fix(sessions): keep reset history closed after compaction [#132606](https://github.com/openclaw/openclaw/pull/132606)
- fix: prevent bounded transcript event ID reuse [#132620](https://github.com/openclaw/openclaw/pull/132620)
- fix(sessions): adopt native threads with duplicate titles [#132678](https://github.com/openclaw/openclaw/pull/132678)
- fix(agents): preserve keyed turns across compaction [#133094](https://github.com/openclaw/openclaw/pull/133094)
- fix(codex): avoid startup failures from unrelated unreadable processes [#133111](https://github.com/openclaw/openclaw/pull/133111)
- fix(agents): settle owned orphan transcript repair [#133243](https://github.com/openclaw/openclaw/pull/133243)
- Clear stale subagent lineage on top-level sessions [#67946](https://github.com/openclaw/openclaw/pull/67946)
- fix(acp): preserve timeout progress summaries [#91479](https://github.com/openclaw/openclaw/pull/91479)
- fix(sessions): identify refused transcript appends safely [#130997](https://github.com/openclaw/openclaw/pull/130997)
- fix: sessions.create rejects file working directories [#131955](https://github.com/openclaw/openclaw/pull/131955)

**Documentation**

- docs: clarify paired-node Codex continuation limits [#132637](https://github.com/openclaw/openclaw/pull/132637)

</details>

</Accordion>

<Accordion title="Stored Data and Backups">

Sessions and transcripts, selected device and authentication records, meeting capture, and runtime journals now use SQLite-backed stores, and [portable snapshots](/cli/backup) can be created, verified, and restored through the same toolset. This gives backup and recovery a checkable path before an incident.

Some legacy stores require the owning process to be stopped before `openclaw doctor --fix` can migrate them. Pending pairing requests and bootstrap codes are not imported, the macOS tunnel migration cannot be read by older JSON-only builds, and restore refuses to write over an existing target.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Harden SQLite state lifecycle and snapshots [#104859](https://github.com/openclaw/openclaw/pull/104859)
- Create and verify portable SQLite snapshots [#105718](https://github.com/openclaw/openclaw/pull/105718)
- Centralize Reef peer trust in SQLite [#108375](https://github.com/openclaw/openclaw/pull/108375)
- Move node-host identity and Gateway settings to SQLite [#108457](https://github.com/openclaw/openclaw/pull/108457)
- Move APNs registrations to shared SQLite [#108543](https://github.com/openclaw/openclaw/pull/108543)
- Store workspace setup state in SQLite [#109147](https://github.com/openclaw/openclaw/pull/109147)
- Add bounded SQLite BLOB storage for trusted plugins [#109328](https://github.com/openclaw/openclaw/pull/109328)
- Move channel runtime state into shared SQLite storage [#109380](https://github.com/openclaw/openclaw/pull/109380)
- Move remaining non-session runtime journals into SQLite [#109427](https://github.com/openclaw/openclaw/pull/109427)
- Move MCP OAuth credentials and refresh state to SQLite [#109844](https://github.com/openclaw/openclaw/pull/109844)
- Raise the default session archive disk budget to 10 GiB [#110221](https://github.com/openclaw/openclaw/pull/110221)
- Preserve Ask OpenClaw conversations across restarts [#111440](https://github.com/openclaw/openclaw/pull/111440)
- Unify offline storage for iPhone and Mac [#111598](https://github.com/openclaw/openclaw/pull/111598)
- Migrate saved media history to canonical facts [#113695](https://github.com/openclaw/openclaw/pull/113695)
- Move local tool notes into AGENTS.md [#113966](https://github.com/openclaw/openclaw/pull/113966)
- Speed up gateway startup when transcript indexes are current [#117342](https://github.com/openclaw/openclaw/pull/117342)
- Move shared agent credentials into shared state SQLite [#123349](https://github.com/openclaw/openclaw/pull/123349)
- Preserve recently active session history during maintenance [#123987](https://github.com/openclaw/openclaw/pull/123987)
- Move sessions and transcripts to per-agent SQLite storage [#98236](https://github.com/openclaw/openclaw/pull/98236)
- Move device pairing state to the shared SQLite database [#103160](https://github.com/openclaw/openclaw/pull/103160)
- Harden SQLite snapshot publication for backups [#105412](https://github.com/openclaw/openclaw/pull/105412)
- Move managed image metadata into SQLite [#108290](https://github.com/openclaw/openclaw/pull/108290)
- Move device identity into shared SQLite state [#110392](https://github.com/openclaw/openclaw/pull/110392)
- Move macOS SSH tunnel ownership records to SQLite [#110527](https://github.com/openclaw/openclaw/pull/110527)
- Move device auth tokens into shared SQLite state [#112663](https://github.com/openclaw/openclaw/pull/112663)
- Move meeting-capture transcripts to SQLite [#112910](https://github.com/openclaw/openclaw/pull/112910)
- Unify claim-fenced cross-channel delivery [#114689](https://github.com/openclaw/openclaw/pull/114689)
- Reuse synchronous SQLite prepared statements [#114777](https://github.com/openclaw/openclaw/pull/114777)
- Avoid repeated migration scans during local CLI turns [#119051](https://github.com/openclaw/openclaw/pull/119051)
- Retire the obsolete commitments database schema [#122176](https://github.com/openclaw/openclaw/pull/122176)
- fix(logbook): index frame and batch queries [#129570](https://github.com/openclaw/openclaw/pull/129570)
- Add a separate thinking level for embedded compaction [#98074](https://github.com/openclaw/openclaw/pull/98074)
- Explain safe recovery from newer state schemas [#104751](https://github.com/openclaw/openclaw/pull/104751)
- Move usage-cost cache state into per-agent SQLite [#106051](https://github.com/openclaw/openclaw/pull/106051)
- Use SQLite only for Gateway session lookup [#112676](https://github.com/openclaw/openclaw/pull/112676)
- Simplify TOOLS.md migration recovery [#115857](https://github.com/openclaw/openclaw/pull/115857)

**Bug fixes**

- fix(sessions): preserve shared history across startup and repairs [#127241](https://github.com/openclaw/openclaw/pull/127241)
- fix(sqlite): prevent WAL split-brain cleanup corruption [#132844](https://github.com/openclaw/openclaw/pull/132844)
- Remove repeated full-table scans from ACP replay writes [#104739](https://github.com/openclaw/openclaw/pull/104739)
- Batch Doctor canonical session repairs [#117068](https://github.com/openclaw/openclaw/pull/117068)
- fix(sessions): retain completed summaries on multi-store cleanup partial failure (#127583) [#128905](https://github.com/openclaw/openclaw/pull/128905)
- fix: agent database reopen accepts a newer schema after close or eviction [#131331](https://github.com/openclaw/openclaw/pull/131331)

**Documentation**

- refactor(state): retire six dead shared-state tables at schema v10 [#129626](https://github.com/openclaw/openclaw/pull/129626)

</details>

</Accordion>

<Accordion title="Remote computers and devices">

Work no longer has to stay on the main machine running OpenClaw. A configured [cloud worker](/gateway/cloud-workers) can start a session in a selected repository and later return it to the main machine, and the Control UI now identifies the service and profile behind a placement when that identity can be resolved safely. Crabbox profiles can leave machine sizing to the service or choose it for one session. An explicitly opted-in [paired computer](/gateway/cloud-sessions), including an eligible native Mac, can run a complete turn using a worker bundle verified and supplied by OpenClaw rather than whatever code happens to be installed there.

Those are two different paths with different requirements. Cloud workers need a configured profile and the OpenClaw runtime, while paired computers need compatible versions, consent, available capacity, and support for the requested commands. The portable worker bundle does not include the destination machine's native terminal module, so work that depends on a truly interactive terminal still has a real boundary.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Direct Apple Watch Gateway node over Wi-Fi or cellular [#102893](https://github.com/openclaw/openclaw/pull/102893)
- Add durable cloud-worker environment foundations [#104401](https://github.com/openclaw/openclaw/pull/104401)
- feat(cloud-workers): add crabbox worker provider plugin and profile-aware lease lifecycle [#104465](https://github.com/openclaw/openclaw/pull/104465)
- Bootstrap cloud workers with pinned, verified bundles [#104532](https://github.com/openclaw/openclaw/pull/104532)
- Unify machine status on the Devices page [#104561](https://github.com/openclaw/openclaw/pull/104561)
- Route node alerts to the active Mac [#105083](https://github.com/openclaw/openclaw/pull/105083)
- Add replayable live events for cloud worker sessions [#105275](https://github.com/openclaw/openclaw/pull/105275)
- Combine CLI and native capabilities in one Mac node [#105642](https://github.com/openclaw/openclaw/pull/105642)
- Add the restricted cloud-worker runtime [#105865](https://github.com/openclaw/openclaw/pull/105865)
- Move Devices into Settings and redesign the inventory [#106055](https://github.com/openclaw/openclaw/pull/106055)
- Add durable cloud-worker session placement and dispatch [#106332](https://github.com/openclaw/openclaw/pull/106332)
- Add camera, location, and notifications to Linux nodes [#107193](https://github.com/openclaw/openclaw/pull/107193)
- Create cloud-worker sessions from Control UI [#107670](https://github.com/openclaw/openclaw/pull/107670)
- Let cloud workers use a selected repository [#107976](https://github.com/openclaw/openclaw/pull/107976)
- Discover nearby gateways from the Linux desktop app [#108115](https://github.com/openclaw/openclaw/pull/108115)
- Run and safely reclaim cloud worker sessions [#108398](https://github.com/openclaw/openclaw/pull/108398)
- Show cloud workspace conflicts and recovery steps in the Control UI [#111329](https://github.com/openclaw/openclaw/pull/111329)
- Connect multiple gateways simultaneously across official apps [#111932](https://github.com/openclaw/openclaw/pull/111932)
- Manage reusable macOS Gateway profiles and windows [#111986](https://github.com/openclaw/openclaw/pull/111986)
- Add paired Gateway nodes as a first-class Code Mode API [#114877](https://github.com/openclaw/openclaw/pull/114877)
- Watch and control cloud-worker desktops from the Control UI [#120727](https://github.com/openclaw/openclaw/pull/120727)
- Add one-paste device pairing with `oc-pair://` links [#120768](https://github.com/openclaw/openclaw/pull/120768)
- Cloud Worker Desktop apps and browser autonomy [#121475](https://github.com/openclaw/openclaw/pull/121475)
- Let cloud sessions spawn and message nested cloud sessions [#121846](https://github.com/openclaw/openclaw/pull/121846)
- Add one-paste onboarding for new node machines [#122499](https://github.com/openclaw/openclaw/pull/122499)
- Expose a public Gateway ingress for workers [#122578](https://github.com/openclaw/openclaw/pull/122578)
- Allow workers to connect through the public gateway [#122643](https://github.com/openclaw/openclaw/pull/122643)
- Run complete agent turns on paired devices [#123157](https://github.com/openclaw/openclaw/pull/123157)
- Warn when cloud sessions run low on disk space [#123177](https://github.com/openclaw/openclaw/pull/123177)
- Remember offline devices in the session picker [#123198](https://github.com/openclaw/openclaw/pull/123198)
- Transfer worker workspaces to paired nodes and reconcile results [#123280](https://github.com/openclaw/openclaw/pull/123280)
- Run Codex session work on cloud workers [#123743](https://github.com/openclaw/openclaw/pull/123743)
- Run paired-device sessions from Gateway worker bundles [#124037](https://github.com/openclaw/openclaw/pull/124037)
- Show validated worker bundle status for connected devices [#124640](https://github.com/openclaw/openclaw/pull/124640)
- Manage cloud worker profiles and choose machine sizes per session [#124864](https://github.com/openclaw/openclaw/pull/124864)
- Run disposable cloud workers through node transport [#125288](https://github.com/openclaw/openclaw/pull/125288)
- Show cloud machine CPU and RAM in the picker [#125696](https://github.com/openclaw/openclaw/pull/125696)
- Show exact worker slots for connected devices [#125708](https://github.com/openclaw/openclaw/pull/125708)
- Add explicit session-host enrollment to openclaw connect [#125879](https://github.com/openclaw/openclaw/pull/125879)
- Add per-repository cloud-worker profile defaults [#126238](https://github.com/openclaw/openclaw/pull/126238)
- Recover sessions when a paired device goes offline [#126284](https://github.com/openclaw/openclaw/pull/126284)
- Add lifecycle-safe duplex channels for plugin node commands [#126961](https://github.com/openclaw/openclaw/pull/126961)
- feat: run Codex sessions on approved paired devices [#127202](https://github.com/openclaw/openclaw/pull/127202)
- feat(workers): run OpenClaw and Codex on the same cloud profile [#127752](https://github.com/openclaw/openclaw/pull/127752)
- feat(nodes): derive worker capacity from CPU cores and make it configurable [#128352](https://github.com/openclaw/openclaw/pull/128352)
- feat(nodes): automatic device placement for sessions.dispatch [#128421](https://github.com/openclaw/openclaw/pull/128421)
- feat(crabbox): opt-in profile warm images for cloud workers [#130087](https://github.com/openclaw/openclaw/pull/130087)
- feat(portals): expose portals to sessions on node-backed cloud workers [#130105](https://github.com/openclaw/openclaw/pull/130105)
- feat(gateway): auto-suspend idle cloud workers with suspendAfter [#130242](https://github.com/openclaw/openclaw/pull/130242)
- feat(crabbox): allow profiles without a default machine class [#131009](https://github.com/openclaw/openclaw/pull/131009)
- feat(macos): enable native node session hosting [#131717](https://github.com/openclaw/openclaw/pull/131717)
- feat(cloud-workers): warm project seeds and automatic image refresh [#131744](https://github.com/openclaw/openclaw/pull/131744)
- Add Crabbox lease setup commands [5a37cdb](https://github.com/openclaw/openclaw/commit/5a37cdb)
- Add pinned SSH tunnels for Cloud Worker environments [#104553](https://github.com/openclaw/openclaw/pull/104553)
- Add authenticated, closed gateway connections for cloud workers [#104688](https://github.com/openclaw/openclaw/pull/104688)
- Show node version drift and Windows wake guidance [#104735](https://github.com/openclaw/openclaw/pull/104735)
- Add durable transcript commits for cloud workers [#104809](https://github.com/openclaw/openclaw/pull/104809)
- Reduce repeated cloud-worker workspace hashing [#121365](https://github.com/openclaw/openclaw/pull/121365)
- Reuse one SSH tunnel during cloud session startup [#122077](https://github.com/openclaw/openclaw/pull/122077)
- Provision paired nodes as local session hosts [#122966](https://github.com/openclaw/openclaw/pull/122966)
- Publish atomic device runner inventory [#123094](https://github.com/openclaw/openclaw/pull/123094)
- Enforce two-worker capacity on paired nodes [#123612](https://github.com/openclaw/openclaw/pull/123612)
- Separate node-runner consent from launch capacity [#124356](https://github.com/openclaw/openclaw/pull/124356)
- Prewarm delegated Node worker bundles [#124427](https://github.com/openclaw/openclaw/pull/124427)
- Retire the reverse SSH worker-turn tunnel [#125465](https://github.com/openclaw/openclaw/pull/125465)
- Show machine classes reported by Crabbox [#126184](https://github.com/openclaw/openclaw/pull/126184)
- Simplify retired runner recovery and placement wording [#126773](https://github.com/openclaw/openclaw/pull/126773)
- improve: skip re-hashing unchanged worker workspaces after every turn [#131254](https://github.com/openclaw/openclaw/pull/131254)
- feat(cloud-workers): enable warm images by default outside secret-bearing setup [#131874](https://github.com/openclaw/openclaw/pull/131874)
- feat(control-ui): show cloud worker service and profile on session placements [#132405](https://github.com/openclaw/openclaw/pull/132405)
- perf: reduce remote-exec attachment transfer round trips [#132657](https://github.com/openclaw/openclaw/pull/132657)
- Use Devices consistently for paired hardware in the Control UI [#120689](https://github.com/openclaw/openclaw/pull/120689)

**Bug fixes**

- fix: cloud sessions reject image input [#132114](https://github.com/openclaw/openclaw/pull/132114)
- fix(workers): avoid provisioning during failed-dispatch cleanup [#132224](https://github.com/openclaw/openclaw/pull/132224)
- fix: deliver images and PDFs to remote cloud sessions [#132358](https://github.com/openclaw/openclaw/pull/132358)
- fix(cloud): retain canonical ownership for worker turns [#132507](https://github.com/openclaw/openclaw/pull/132507)
- fix: preserve cloud turns when follow-up input arrives [#132887](https://github.com/openclaw/openclaw/pull/132887)
- fix: cloud sessions fail when source builds and worker packages differ [#133037](https://github.com/openclaw/openclaw/pull/133037)
- fix(gateway): preserve paired-worker deadline outcomes [85ae2bc](https://github.com/openclaw/openclaw/commit/85ae2bc)
- fix(workers): evict quiescent live-event windows instead of rejecting new sessions [#131365](https://github.com/openclaw/openclaw/pull/131365)
- fix: worker reply corrections repeat stale live text [#131869](https://github.com/openclaw/openclaw/pull/131869)
- fix(crabbox): show mapped cloud machine choices [#132299](https://github.com/openclaw/openclaw/pull/132299)
- fix(crabbox): explain inaccessible worker CLI installs [#132327](https://github.com/openclaw/openclaw/pull/132327)
- fix(process): settle disconnected workers after pipe closure [#132447](https://github.com/openclaw/openclaw/pull/132447)
- fix: keep near-limit worker launches within transport bounds [#132732](https://github.com/openclaw/openclaw/pull/132732)
- fix: worker sessions cannot message Gateway parents or siblings [#132818](https://github.com/openclaw/openclaw/pull/132818)
- fix(crabbox): retain checkpoint cleanup after warm-image refresh [#132959](https://github.com/openclaw/openclaw/pull/132959)
- fix: concurrent WebVNC viewers can fail to connect [#133226](https://github.com/openclaw/openclaw/pull/133226)
- fix(workers): preserve offline errors during desktop preparation [#133212](https://github.com/openclaw/openclaw/pull/133212)

</details>

</Accordion>

<Accordion title="Voice, meetings, and media">

[Talk](/nodes/talk) can use GPT-Live and GA Realtime voice through supported direct-browser and Gateway-relay paths, including eligible ChatGPT or Codex sign-ins. The routes are not interchangeable though, because credentials and transports vary across clients, Android relay remains gated, and Azure configurations are excluded from the ChatGPT OAuth relay path.

Supported OpenAI and Gemini Live calls can add video, remember whether you use the camera, and switch cameras without restarting voice. Those controls only appear on supported browser and provider transports, permission and capture stay on the device, and an unsupported or fallback relay can omit or reject video.

Enabled [Google Meet, Microsoft Teams, and Zoom bots](/plugins/meeting-plugins) can also retain speaker-attributed transcripts and summaries in SQLite. Google Meet's bounded live-caption buffer is a separate path from that durable archive, and meeting retention can still be disabled globally.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add Qwen 3.6 Flash and update Gemini Live voice [#102791](https://github.com/openclaw/openclaw/pull/102791)
- Add xAI Grok Imagine Video 1.5 support [#103316](https://github.com/openclaw/openclaw/pull/103316)
- Discover current xAI TTS voices dynamically [#103446](https://github.com/openclaw/openclaw/pull/103446)
- Retain bounded Google Meet caption transcripts [#103811](https://github.com/openclaw/openclaw/pull/103811)
- Add native xAI streaming text-to-speech [#103993](https://github.com/openclaw/openclaw/pull/103993)
- Add native xAI realtime voice to Talk [#106267](https://github.com/openclaw/openclaw/pull/106267)
- Add camera-aware OpenAI Video Talk [#109579](https://github.com/openclaw/openclaw/pull/109579)
- Add Gemini Live Video Talk [#109719](https://github.com/openclaw/openclaw/pull/109719)
- Add Microsoft Teams meeting participation [#109964](https://github.com/openclaw/openclaw/pull/109964)
- Move video talk to an in-call camera toggle [#110576](https://github.com/openclaw/openclaw/pull/110576)
- Add camera selection and live switching to Realtime Talk [#111042](https://github.com/openclaw/openclaw/pull/111042)
- Add a Zoom browser-guest meeting plugin [#111048](https://github.com/openclaw/openclaw/pull/111048)
- Add durable Talk voice sessions and spoken confirmations [#111216](https://github.com/openclaw/openclaw/pull/111216)
- Enable Teams and Zoom meeting plugins by default [#113022](https://github.com/openclaw/openclaw/pull/113022)
- Enable the Google Meet plugin by default after installation [#113053](https://github.com/openclaw/openclaw/pull/113053)
- Automatically retain durable meeting transcripts and summaries [#113122](https://github.com/openclaw/openclaw/pull/113122)
- Enable GPT Live Talk with Codex OAuth [#113354](https://github.com/openclaw/openclaw/pull/113354)
- Add GPT-Live full-duplex voice to browser Talk [#115226](https://github.com/openclaw/openclaw/pull/115226)
- Configure realtime voice from Settings → Talk [#115409](https://github.com/openclaw/openclaw/pull/115409)
- Add GPT-Live voice over backend WebSocket [#115622](https://github.com/openclaw/openclaw/pull/115622)
- Use ChatGPT OAuth for GA Realtime browser Talk [#115623](https://github.com/openclaw/openclaw/pull/115623)
- Add byte-range streaming for Gateway media [#115667](https://github.com/openclaw/openclaw/pull/115667)
- Add least-privilege pairing for embedded voice nodes [#115712](https://github.com/openclaw/openclaw/pull/115712)
- Add Fish Audio S2.1 and progressive local Fish speech [#115790](https://github.com/openclaw/openclaw/pull/115790)
- Support GPT-Live through the Gateway Talk relay [#115831](https://github.com/openclaw/openclaw/pull/115831)
- Add lazy playback transcodes for exotic media [#115987](https://github.com/openclaw/openclaw/pull/115987)
- Enable Linux Chrome talk-back in meetings [#118451](https://github.com/openclaw/openclaw/pull/118451)
- Add Gateway-controlled WebRTC Talk sideband [#121054](https://github.com/openclaw/openclaw/pull/121054)
- Send current-turn video to compatible Google Gemini models [#122074](https://github.com/openclaw/openclaw/pull/122074)
- Replay persisted video after session restart [#122257](https://github.com/openclaw/openclaw/pull/122257)
- Add native MP4 video input for Moonshot Kimi K3 [#122337](https://github.com/openclaw/openclaw/pull/122337)
- Add generated-image actions and bounded previews in Control UI [#77017](https://github.com/openclaw/openclaw/pull/77017)
- Modernize DeepInfra video generation and clean DeepSeek replies [#95824](https://github.com/openclaw/openclaw/pull/95824)
- Add time and position context to recent images [#100866](https://github.com/openclaw/openclaw/pull/100866)
- Share audio-energy and speech-onset helpers across voice surfaces [#109466](https://github.com/openclaw/openclaw/pull/109466)
- Remember Talk camera use and clarify the camera toggle [#110817](https://github.com/openclaw/openclaw/pull/110817)
- Audio and video metadata survives from intake to history [#115728](https://github.com/openclaw/openclaw/pull/115728)
- Advertise chat attachment size limits to Gateway clients [#116188](https://github.com/openclaw/openclaw/pull/116188)
- Reduce memory copies during ClickClack media uploads [#127152](https://github.com/openclaw/openclaw/pull/127152)
- Require canonical voice-call configuration at runtime [#105476](https://github.com/openclaw/openclaw/pull/105476)
- Unify meeting manual-action results [#114247](https://github.com/openclaw/openclaw/pull/114247)
- improve(zalo): avoid duplicate media preparation [#128377](https://github.com/openclaw/openclaw/pull/128377)

**Bug fixes**

- Restore GPT-Live subscription calls and model-specific voices [#133079](https://github.com/openclaw/openclaw/pull/133079)
- fix: end failed voice calls and preserve Gemini Live transcripts [#133157](https://github.com/openclaw/openclaw/pull/133157)
- Share realtime voice session lifecycle handling [#117865](https://github.com/openclaw/openclaw/pull/117865)
- fix(transcripts): preserve captures with oversized export names [#131508](https://github.com/openclaw/openclaw/pull/131508)
- fix(meetings): keep realtime audio alive during provider recovery [#131524](https://github.com/openclaw/openclaw/pull/131524)
- fix(transcripts): keep date-shaped IDs readable and stop handles unambiguous [#131723](https://github.com/openclaw/openclaw/pull/131723)
- fix: closed browser Talk sessions admit new agent work [#133019](https://github.com/openclaw/openclaw/pull/133019)
- Preserve voice-note transcripts through message processing [#133261](https://github.com/openclaw/openclaw/pull/133261)
- Support flexible GPT Image 2 dimensions [#118476](https://github.com/openclaw/openclaw/pull/118476)
- improve(msteams): avoid repeated activity preparation on retries [#128329](https://github.com/openclaw/openclaw/pull/128329)
- fix(ui): stop Talk camera preview flicker on rerenders [#131241](https://github.com/openclaw/openclaw/pull/131241)
- fix(transcripts): report auto-start shutdown warnings [#131381](https://github.com/openclaw/openclaw/pull/131381)
- fix(cli): reject conflicting TTS persona selectors [#133191](https://github.com/openclaw/openclaw/pull/133191)

**Documentation**

- fix: voice smoke passes without receiving speech [#133020](https://github.com/openclaw/openclaw/pull/133020)

</details>

</Accordion>

<Accordion title="Code Mode and agent tools">

[Code Mode](/tools/code-mode) remains experimental and off by default. Its Labs switch selects automatic use for preferred models, while Agent Defaults can inherit or override that choice for one exact model. When active, Code Mode can treat authorized tools like ordinary asynchronous functions, letting an agent combine trusted results from conversations, files, and sessions in one program or run independent calls together. This is the final interface rather than another layer beside the old one, so the previous `tools` object, `ALL_TOOLS`, exact-ID calls, and raw call envelopes are gone. What a program can compose still stops at the tools it is authorized to use and the structured results those tools declare.

[Tool Search](/tools) also does a better job of turning a natural request into a discoverable capability, can search several capability groups in one structured request, and now exposes existing session archive and pin actions. Policy can still hide tools and a request with no valid answer can return nothing, while existing single-query request and response shapes continue to work.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add a secure live preview widget to Workspaces [#101354](https://github.com/openclaw/openclaw/pull/101354)
- Add Podman as a built-in agent sandbox backend [#101358](https://github.com/openclaw/openclaw/pull/101358)
- Add trusted chart widgets to Workspaces [#101792](https://github.com/openclaw/openclaw/pull/101792)
- Add live agent status and custom-widget decisions to Workspaces [#101826](https://github.com/openclaw/openclaw/pull/101826)
- Render interactive widgets inline in web chat [#101840](https://github.com/openclaw/openclaw/pull/101840)
- Add operator-approved follow-up task suggestions [#102422](https://github.com/openclaw/openclaw/pull/102422)
- Add actionable task suggestions to the Gateway TUI [#102743](https://github.com/openclaw/openclaw/pull/102743)
- Add worktree ownership, creation, and safer cleanup to the Control UI [#103526](https://github.com/openclaw/openclaw/pull/103526)
- Add agent-composable Workspaces [#104139](https://github.com/openclaw/openclaw/pull/104139)
- Speed up Workboard dependency checks with targeted parent lookups [#104668](https://github.com/openclaw/openclaw/pull/104668)
- Require fresh isolated worktrees for delegated coding [#105993](https://github.com/openclaw/openclaw/pull/105993)
- Add configurable managed-worktree cleanup limits [#106224](https://github.com/openclaw/openclaw/pull/106224)
- Add agent session self-service tools [#107471](https://github.com/openclaw/openclaw/pull/107471)
- Let web-chat widgets send follow-up prompts [#108889](https://github.com/openclaw/openclaw/pull/108889)
- Let agents share a live terminal with operators [#109005](https://github.com/openclaw/openclaw/pull/109005)
- Complete multi-tool code-mode blocks in one exec turn [#109290](https://github.com/openclaw/openclaw/pull/109290)
- Reduce Code Mode tool orchestration turns [#109596](https://github.com/openclaw/openclaw/pull/109596)
- Add declared tool result shapes to Code Mode [#109813](https://github.com/openclaw/openclaw/pull/109813)
- Add more Code Mode tool output hints [#110215](https://github.com/openclaw/openclaw/pull/110215)
- Expose structured filesystem results to Code Mode [#110395](https://github.com/openclaw/openclaw/pull/110395)
- Complete Code Mode contracts for session tools [#110424](https://github.com/openclaw/openclaw/pull/110424)
- Bring question prompts to every app [#110681](https://github.com/openclaw/openclaw/pull/110681)
- Add a theme-aware design system for Canvas widgets [#110832](https://github.com/openclaw/openclaw/pull/110832)
- Add gated Swarm orchestration core [#110932](https://github.com/openclaw/openclaw/pull/110932)
- Add model, workspace, and fork options to visible session spawns [#110943](https://github.com/openclaw/openclaw/pull/110943)
- Add restart-safe Swarm orchestration to QuickJS Code Mode [#111298](https://github.com/openclaw/openclaw/pull/111298)
- Show authoritative write diffs across chat clients [#111456](https://github.com/openclaw/openclaw/pull/111456)
- Complete Swarm wait, progress, and worker guidance [#111605](https://github.com/openclaw/openclaw/pull/111605)
- Let plugins add granted dashboard feeds and actions [#112083](https://github.com/openclaw/openclaw/pull/112083)
- Explicit owners for ambient multi-agent work [#113637](https://github.com/openclaw/openclaw/pull/113637)
- Enable the operator terminal by default [#113888](https://github.com/openclaw/openclaw/pull/113888)
- Add an isolated headless agent runner [#113988](https://github.com/openclaw/openclaw/pull/113988)
- Improve Tool Search ranking for natural requests [#114285](https://github.com/openclaw/openclaw/pull/114285)
- Advertise searchable tool capabilities automatically [#114508](https://github.com/openclaw/openclaw/pull/114508)
- Add per-run agent stats to JSON output [#114688](https://github.com/openclaw/openclaw/pull/114688)
- Add automatic per-model Code Mode selection [#114695](https://github.com/openclaw/openclaw/pull/114695)
- Enable Code Mode automatically for preferred models [#114906](https://github.com/openclaw/openclaw/pull/114906)
- Add bounded Code Mode repair retries [#115729](https://github.com/openclaw/openclaw/pull/115729)
- Apply configured providers and harnesses to agent exec [#116038](https://github.com/openclaw/openclaw/pull/116038)
- Deliver plugin subagent completions to the current requester [#116091](https://github.com/openclaw/openclaw/pull/116091)
- Add batched structured Tool Search queries [#118623](https://github.com/openclaw/openclaw/pull/118623)
- Speed up restart recovery for large subagent sets [#119793](https://github.com/openclaw/openclaw/pull/119793)
- Choose where suggested follow-up tasks run [#121173](https://github.com/openclaw/openclaw/pull/121173)
- feat(sandbox): add Daytona cloud sandbox backend plugin [#121554](https://github.com/openclaw/openclaw/pull/121554)
- Rename the task-card tool to `suggest_task` [#121694](https://github.com/openclaw/openclaw/pull/121694)
- Let host agents inspect unsupported local documents [#122408](https://github.com/openclaw/openclaw/pull/122408)
- Preview agent-run web apps through Portals [#122536](https://github.com/openclaw/openclaw/pull/122536)
- Add managed browser actions to Computer Use v2 [#123960](https://github.com/openclaw/openclaw/pull/123960)
- Add managed recording and replay to CUA Computer Use [#124035](https://github.com/openclaw/openclaw/pull/124035)
- Standardize image inspection as `view_image` [#125024](https://github.com/openclaw/openclaw/pull/125024)
- Link Workboards to their owning automations [#125076](https://github.com/openclaw/openclaw/pull/125076)
- Run attached Workboard automations when linked work finishes [#125170](https://github.com/openclaw/openclaw/pull/125170)
- Connect CLI tools through identity-aware gateway proxies [#125700](https://github.com/openclaw/openclaw/pull/125700)
- Call Code Mode tools as ordinary async functions [#126262](https://github.com/openclaw/openclaw/pull/126262)
- Broker GitHub publication from the Gateway [#126306](https://github.com/openclaw/openclaw/pull/126306)
- feat(ui): add collapsible Workboard columns [#128115](https://github.com/openclaw/openclaw/pull/128115)
- feat: configure Code Mode per model with inherited defaults [#132332](https://github.com/openclaw/openclaw/pull/132332)
- Move Workboard cards from the CLI, chat, or agent tools [#96554](https://github.com/openclaw/openclaw/pull/96554)
- Let operators raise the Workboard per-pass start cap [#100174](https://github.com/openclaw/openclaw/pull/100174)
- Reduce Code Mode tool-discovery turns [#109651](https://github.com/openclaw/openclaw/pull/109651)
- Let Code Mode compose conversation tools from declared results [#110098](https://github.com/openclaw/openclaw/pull/110098)
- Give `web_fetch` a compact, exact output contract [#110223](https://github.com/openclaw/openclaw/pull/110223)
- Compact `show_widget` guidance with a widget pattern [#110999](https://github.com/openclaw/openclaw/pull/110999)
- Explain visible-session spawn constraints upfront [#111502](https://github.com/openclaw/openclaw/pull/111502)
- Promote the plan-tool switch to `tools.updatePlan` [#113958](https://github.com/openclaw/openclaw/pull/113958)
- Use declared channel traits for thread delivery [#114245](https://github.com/openclaw/openclaw/pull/114245)
- Make session archive and pin actions discoverable to agents [#114463](https://github.com/openclaw/openclaw/pull/114463)
- Give managed worktrees readable default names [#114488](https://github.com/openclaw/openclaw/pull/114488)
- Avoid duplicate subagent registry writes [#114705](https://github.com/openclaw/openclaw/pull/114705)
- Reduce board read work and ticket polling [#114748](https://github.com/openclaw/openclaw/pull/114748)
- Select an OpenShell control-plane workspace [#114952](https://github.com/openclaw/openclaw/pull/114952)
- Add Code Mode model acceptance matrix and agent exec controls [#115305](https://github.com/openclaw/openclaw/pull/115305)
- Add operator-defined headers for direct web fetches [#115545](https://github.com/openclaw/openclaw/pull/115545)
- Add custom headers for Gemini web search [#115549](https://github.com/openclaw/openclaw/pull/115549)
- Scale requester settlement for large subagent groups [#116619](https://github.com/openclaw/openclaw/pull/116619)
- Reduce scheduler overhead for large multi-group swarms [#116623](https://github.com/openclaw/openclaw/pull/116623)
- Speed up high-fanout subagent lifecycle cleanup [#116661](https://github.com/openclaw/openclaw/pull/116661)
- Explain why archived Workboard cards are skipped [#117290](https://github.com/openclaw/openclaw/pull/117290)
- Reduce restricted-worker startup imports [#119644](https://github.com/openclaw/openclaw/pull/119644)
- Record why managed worktrees are removed or retained [#120434](https://github.com/openclaw/openclaw/pull/120434)
- Stream live line-count progress for file edits [#121528](https://github.com/openclaw/openclaw/pull/121528)
- Add capability-filtered guidance for computer use [#123949](https://github.com/openclaw/openclaw/pull/123949)
- Encourage proactive widgets on supported surfaces [#124810](https://github.com/openclaw/openclaw/pull/124810)
- Show Code Mode's final tool surface in debug logs [#124934](https://github.com/openclaw/openclaw/pull/124934)
- perf(tools): load image sanitizer only for image results [#132663](https://github.com/openclaw/openclaw/pull/132663)
- perf(agents): defer unused Code Mode runtimes [#132802](https://github.com/openclaw/openclaw/pull/132802)
- refactor(agents): unify session tool sidebar vocabulary on group [#132942](https://github.com/openclaw/openclaw/pull/132942)
- Speed up large subagent registry lookups [#107935](https://github.com/openclaw/openclaw/pull/107935)
- Reduce repeated board reads during Control UI polling [#114363](https://github.com/openclaw/openclaw/pull/114363)
- [AI] docs(tools): clarify per-action required params in gateway and process tool schemas [#114879](https://github.com/openclaw/openclaw/pull/114879)
- Make suspended Code Mode shutdown cleanup linear [#115456](https://github.com/openclaw/openclaw/pull/115456)
- Clarify how Codex parents receive native child results [#115466](https://github.com/openclaw/openclaw/pull/115466)
- Report submitted length in Workboard limit errors [#118888](https://github.com/openclaw/openclaw/pull/118888)
- Avoid duplicate Tool Search catalog fingerprinting [#127188](https://github.com/openclaw/openclaw/pull/127188)
- Add Codex assistant-completion timeout configuration [#97233](https://github.com/openclaw/openclaw/pull/97233)

**Bug fixes**

- fix(code-mode): cancel resumed cells when their catalog closes [#132182](https://github.com/openclaw/openclaw/pull/132182)
- fix(code-mode): resume after read-only reconciliation [#132583](https://github.com/openclaw/openclaw/pull/132583)
- fix(agents): stop drifting exec failure loops (#118402) [a7a2dac](https://github.com/openclaw/openclaw/commit/a7a2dac)
- fix(agents): front-load exec retention-loss disclosure past session caps [#128997](https://github.com/openclaw/openclaw/pull/128997)
- fix(agents): preserve Code Mode source arguments [#129816](https://github.com/openclaw/openclaw/pull/129816)
- fix(agents): disclose 64 KiB code-mode stderr-tail truncation [#130182](https://github.com/openclaw/openclaw/pull/130182)
- fix(process): self-heal dropped poll delivery via aggregated read-offset [#130420](https://github.com/openclaw/openclaw/pull/130420)
- fix(code-mode): host-policy denial no longer triggers read-only recovery [#131007](https://github.com/openclaw/openclaw/pull/131007)
- fix(web-fetch): bound page metadata and preserve prose across sanitized truncation [#131126](https://github.com/openclaw/openclaw/pull/131126)
- fix(code-mode): canceled timers stall automation and closed cells exhaust slots [#131186](https://github.com/openclaw/openclaw/pull/131186)
- fix(agents): keep transcript redaction out of live tool arguments [#131214](https://github.com/openclaw/openclaw/pull/131214)
- fix(agents): keep code mode off by default [#131242](https://github.com/openclaw/openclaw/pull/131242)
- fix(code-mode): continue tasks after proven-safe wait failures [#131282](https://github.com/openclaw/openclaw/pull/131282)
- fix(agents): overwrite apply_patch host files in place instead of truncating first [#131418](https://github.com/openclaw/openclaw/pull/131418)
- fix(code-mode): stop oversized searches from reporting no matches [#131574](https://github.com/openclaw/openclaw/pull/131574)
- fix(web-fetch): honor cancellation before caching or returning provider results [#131585](https://github.com/openclaw/openclaw/pull/131585)
- fix(web-fetch): honor zero and shortened cache TTL on reads across fetch and search [#131648](https://github.com/openclaw/openclaw/pull/131648)
- fix(agents): retain actionable text in bounded tool results [#131827](https://github.com/openclaw/openclaw/pull/131827)
- fix(agents): resolve @ shorthand in remote patches [#131991](https://github.com/openclaw/openclaw/pull/131991)
- fix(code-mode): continue after proven read-only tool failures [#132146](https://github.com/openclaw/openclaw/pull/132146)
- fix: report Code Mode failures without false success [#132248](https://github.com/openclaw/openclaw/pull/132248)
- fix: retain grep matches with fractional context [#132482](https://github.com/openclaw/openclaw/pull/132482)
- fix(code-mode): keep truncation counts tied to original output [#132850](https://github.com/openclaw/openclaw/pull/132850)
- fix(auto-reply): preserve code indentation before inference [#132900](https://github.com/openclaw/openclaw/pull/132900)
- fix(agents): report early Bash output spill failures without crashing [#132906](https://github.com/openclaw/openclaw/pull/132906)
- fix: keep Code Mode results and read cursors intact under model limits [#132945](https://github.com/openclaw/openclaw/pull/132945)
- fix: read Windows PowerShell UTF-16 text files correctly [#133130](https://github.com/openclaw/openclaw/pull/133130)
- fix(process): preserve arguments through Windows batch wrappers [#133185](https://github.com/openclaw/openclaw/pull/133185)
- fix(agents): preserve oversized Bash final-line output [#133216](https://github.com/openclaw/openclaw/pull/133216)
- fix(agents): preserve find result paths [#133302](https://github.com/openclaw/openclaw/pull/133302)
- fix(exec): reject single-character shell variables in Python scripts [#103535](https://github.com/openclaw/openclaw/pull/103535)
- fix(agents): rebind tool search snapshot executors [#125518](https://github.com/openclaw/openclaw/pull/125518)
- fix(code-mode): preserve cancellation diagnostics after catalog teardown [#131311](https://github.com/openclaw/openclaw/pull/131311)
- fix(agents): keep option-only Code Mode configs disabled [#131407](https://github.com/openclaw/openclaw/pull/131407)
- fix(code-mode): correct MCP array union declarations [#131528](https://github.com/openclaw/openclaw/pull/131528)
- fix(agents): allow empty write content [#131696](https://github.com/openclaw/openclaw/pull/131696)
- fix: write tool skips overwrites after lossy UTF-8 decoding [#133282](https://github.com/openclaw/openclaw/pull/133282)

**Documentation**

- docs: clarify Code Mode is off by default [#132191](https://github.com/openclaw/openclaw/pull/132191)

</details>

</Accordion>

<Accordion title="Accessibility and language support">

Keyboard users can open plugin details and select Usage sessions again. The 20 maintained non-English [Control UI](/web/control-ui) catalogs also include refreshed text for prompts, devices, activity, catalogs, and other expanded surfaces. These catalog updates keep the existing language set aligned with the current interface; they do not add languages or change application logic.

Android also has an experimental `mobile_ui` path that lets an authorized agent observe and interact with apps on a supported paired device. It is owner-only, off by default, limited to third-party builds, unavailable through Gateway HTTP and Play builds, and requires both dangerous commands to be armed explicitly.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Refresh all Control UI locales and repair cron test fixtures [#105100](https://github.com/openclaw/openclaw/pull/105100)
- Add the mobile_ui agent tool for Android apps [#112255](https://github.com/openclaw/openclaw/pull/112255)
- Expose protected Android screen observation and control commands [#112241](https://github.com/openclaw/openclaw/pull/112241)
- Refresh generated Control UI translations [#112673](https://github.com/openclaw/openclaw/pull/112673)
- Clarify Custodian setup controls and cancel actions [#119611](https://github.com/openclaw/openclaw/pull/119611)
- Refresh generated Control UI translations [#125213](https://github.com/openclaw/openclaw/pull/125213)
- chore(ui): refresh control ui locales [#130265](https://github.com/openclaw/openclaw/pull/130265)
- chore(ui): refresh control ui locales [#131098](https://github.com/openclaw/openclaw/pull/131098)
- chore(ui): refresh control ui locales [#131291](https://github.com/openclaw/openclaw/pull/131291)
- Translate terminal upload status messages [#107806](https://github.com/openclaw/openclaw/pull/107806)
- Refresh generated Control UI translations [#109633](https://github.com/openclaw/openclaw/pull/109633)
- Refresh Control UI translations for new prompts [#109751](https://github.com/openclaw/openclaw/pull/109751)
- Refresh Control UI translations across 20 locales [#113184](https://github.com/openclaw/openclaw/pull/113184)
- Refresh Control UI translations for the expanded catalog [#121555](https://github.com/openclaw/openclaw/pull/121555)
- Refresh translations across all Control UI locales [#125774](https://github.com/openclaw/openclaw/pull/125774)
- Refresh Control UI translations across 20 locales [#126614](https://github.com/openclaw/openclaw/pull/126614)
- chore(ui): refresh control ui locales [#127207](https://github.com/openclaw/openclaw/pull/127207)
- chore(ui): refresh control ui locales [#130851](https://github.com/openclaw/openclaw/pull/130851)
- chore(ui): refresh control ui locales [#131506](https://github.com/openclaw/openclaw/pull/131506)
- chore(ui): refresh control ui locales [#131755](https://github.com/openclaw/openclaw/pull/131755)
- chore(ui): refresh control ui locales [#131848](https://github.com/openclaw/openclaw/pull/131848)
- chore(ui): refresh control ui locales [#131898](https://github.com/openclaw/openclaw/pull/131898)
- chore(ui): refresh control ui locales [#132072](https://github.com/openclaw/openclaw/pull/132072)
- chore(ui): refresh control ui locales [#132120](https://github.com/openclaw/openclaw/pull/132120)
- chore(ui): refresh control ui locales [#132198](https://github.com/openclaw/openclaw/pull/132198)
- chore(ui): refresh control ui locales [#132380](https://github.com/openclaw/openclaw/pull/132380)
- chore(ui): refresh control ui locales [#132910](https://github.com/openclaw/openclaw/pull/132910)
- chore(ui): refresh control ui locales [#133026](https://github.com/openclaw/openclaw/pull/133026)

**Bug fixes**

- Restore keyboard access to plugin details and Usage sessions [#116820](https://github.com/openclaw/openclaw/pull/116820)
- chore(ui): refresh control ui locales [#131638](https://github.com/openclaw/openclaw/pull/131638)
- chore(ui): refresh control ui locales [#131969](https://github.com/openclaw/openclaw/pull/131969)
- chore(ui): refresh control ui locales [#132870](https://github.com/openclaw/openclaw/pull/132870)
- chore(ui): refresh control ui locales [#133233](https://github.com/openclaw/openclaw/pull/133233)

</details>

</Accordion>

<Accordion title="Interface polish and compatibility">

Startup and several messaging paths now skip unnecessary work, while smaller fixes across onboarding, Tasks, Worktrees, Activity, dashboards, generated titles, durations, phone numbers, and themes make [familiar screens](/web/control-ui) easier to read and use.

The optional [Control UI lobster](/web/lobster) now reacts to status changes and adds seasonal or rare variants, visitors, collection rewards, and controls to dismiss one visit or disable visits. These additions are cosmetic, many appearances remain rare or session-seeded, reduced-motion preferences are preserved, and related CLI flourishes stay inside interactive use so automated output is unchanged.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add a session-seeded lobster status pet to the Control UI sidebar [#102766](https://github.com/openclaw/openclaw/pull/102766)
- Make the Control UI lobster react to you and run outcomes [#103344](https://github.com/openclaw/openclaw/pull/103344)
- Add lobster surprises to the CLI and Control UI [#103412](https://github.com/openclaw/openclaw/pull/103412)
- Calm the working claw and add turn recaps [#112060](https://github.com/openclaw/openclaw/pull/112060)
- Expand the lobster pet with rare visitors and collection rewards [#112073](https://github.com/openclaw/openclaw/pull/112073)
- Expand Lobsterdex with new palettes, lore, and a collection page [#114959](https://github.com/openclaw/openclaw/pull/114959)
- Expand Lobsterdex with nine palettes, deep links, and shiny dates [#115179](https://github.com/openclaw/openclaw/pull/115179)
- Complete the Lobsterdex with 42 varied sprites [#115264](https://github.com/openclaw/openclaw/pull/115264)
- Add balloon, ASCII, and portal Lobsterdex variants [#115308](https://github.com/openclaw/openclaw/pull/115308)
- feat(ui): user-selectable accent color for the Control UI [#128432](https://github.com/openclaw/openclaw/pull/128432)
- feat(ui): save appearance preferences per user profile [#130340](https://github.com/openclaw/openclaw/pull/130340)
- Add rare sidebar lobster pet variants [#102829](https://github.com/openclaw/openclaw/pull/102829)
- Add seeded body-shape variants to the lobster pet [#103091](https://github.com/openclaw/openclaw/pull/103091)
- Make the sidebar lobster an occasional, controllable visitor [#103111](https://github.com/openclaw/openclaw/pull/103111)
- Add personality and reactions to the Control UI lobster pet [#103149](https://github.com/openclaw/openclaw/pull/103149)
- Add rare molting and twin visits for the lobster pet [#103154](https://github.com/openclaw/openclaw/pull/103154)
- Add seasonal outfits for the Control UI lobster [#103158](https://github.com/openclaw/openclaw/pull/103158)
- Show the selected agent's seeded lobster in Dreams [#103167](https://github.com/openclaw/openclaw/pull/103167)
- Add a browser-local Lobsterdex collection [#103172](https://github.com/openclaw/openclaw/pull/103172)
- Add rare pass-through visitors to the lobster pet [#103352](https://github.com/openclaw/openclaw/pull/103352)
- Give the Control UI lobster memories and familiarity [#103359](https://github.com/openclaw/openclaw/pull/103359)
- Give the Control UI lobster anniversary hats and earned titles [#103563](https://github.com/openclaw/openclaw/pull/103563)
- Add responsive lobster mascot interactions [#103573](https://github.com/openclaw/openclaw/pull/103573)
- Let the sidebar lobster occasionally stand in for the logo [#104748](https://github.com/openclaw/openclaw/pull/104748)
- Enforce safe indexed access across core and the Control UI [#104981](https://github.com/openclaw/openclaw/pull/104981)
- Replace the working spark with a pinching claw [#105020](https://github.com/openclaw/openclaw/pull/105020)
- Add a pixel lobster to the CLI wizard banner [#105119](https://github.com/openclaw/openclaw/pull/105119)
- Animate the claw banner on interactive startup [#105540](https://github.com/openclaw/openclaw/pull/105540)
- Give the working claw a clearer punching animation [#105597](https://github.com/openclaw/openclaw/pull/105597)
- Standardize duration parsing and display across OpenClaw [#105988](https://github.com/openclaw/openclaw/pull/105988)
- Finish the managed worktrees list redesign [#106514](https://github.com/openclaw/openclaw/pull/106514)
- Add a claw spinner to wizard wait steps [#108833](https://github.com/openclaw/openclaw/pull/108833)
- Reduce agent startup overhead from TTS imports [#109344](https://github.com/openclaw/openclaw/pull/109344)
- Reduce auth-expiry noise and add lobster logo scares [#110466](https://github.com/openclaw/openclaw/pull/110466)
- Lazy-load the lobster pet after Control UI startup [#110628](https://github.com/openclaw/openclaw/pull/110628)
- Fit the full Token Activity year without scrolling [#112006](https://github.com/openclaw/openclaw/pull/112006)
- Format international phone numbers in Control UI and CLI displays [#112400](https://github.com/openclaw/openclaw/pull/112400)
- Add three rare working-claw animations [#112552](https://github.com/openclaw/openclaw/pull/112552)
- Make working-claw tricks rare one-shot surprises [#114025](https://github.com/openclaw/openclaw/pull/114025)
- Reduce Telegram streaming work on the Gateway hot path [#118349](https://github.com/openclaw/openclaw/pull/118349)
- Add temporary and permanent lobster dismissal choices [#123789](https://github.com/openclaw/openclaw/pull/123789)
- Add observed away duration to Slack presence events [#123805](https://github.com/openclaw/openclaw/pull/123805)
- Configure Slack presence-event guidance [#123875](https://github.com/openclaw/openclaw/pull/123875)
- fix(diffs): load Playwright renderer on demand [#127040](https://github.com/openclaw/openclaw/pull/127040)
- Speed up dense Google Chat bullet-list formatting [#127274](https://github.com/openclaw/openclaw/pull/127274)
- chore: refresh dependencies after seven-day cooldown [#128414](https://github.com/openclaw/openclaw/pull/128414)
- improve(discord): avoid repeated account resolution on sends [#128462](https://github.com/openclaw/openclaw/pull/128462)
- improve(feishu): avoid repeated outbound post rendering [#128471](https://github.com/openclaw/openclaw/pull/128471)
- improve(irc): reuse transient connection for chunked sends [#128487](https://github.com/openclaw/openclaw/pull/128487)
- improve(ui): make Tasks easier to scan [#128853](https://github.com/openclaw/openclaw/pull/128853)
- perf(ui): defer custom theme import to settings [#130710](https://github.com/openclaw/openclaw/pull/130710)
- chore(deps): refresh seven-day-cooled runtimes and tooling [#131719](https://github.com/openclaw/openclaw/pull/131719)
- Refresh CLI startup taglines [#102750](https://github.com/openclaw/openclaw/pull/102750)
- Add roast-style CLI startup taglines [#102789](https://github.com/openclaw/openclaw/pull/102789)
- Attribute OpenClaw to the OpenClaw Foundation [#112536](https://github.com/openclaw/openclaw/pull/112536)
- Add provider icons to coding catalog headings [#115956](https://github.com/openclaw/openclaw/pull/115956)
- Show the Pi logo in external-session catalogs [#119998](https://github.com/openclaw/openclaw/pull/119998)
- Give the collapsed session rail a distinct header icon [#121420](https://github.com/openclaw/openclaw/pull/121420)
- Generate session and thread titles in sentence case [#123389](https://github.com/openclaw/openclaw/pull/123389)
- Reduce Control UI startup CSS [#125539](https://github.com/openclaw/openclaw/pull/125539)
- improve(telegram): reduce rich message planning work [#127719](https://github.com/openclaw/openclaw/pull/127719)
- improve(nextcloud-talk): avoid room credential reads on sends [#128344](https://github.com/openclaw/openclaw/pull/128344)
- improve(googlechat): avoid duplicate DM route reads [#128359](https://github.com/openclaw/openclaw/pull/128359)
- improve(matrix): avoid duplicate outbound body projection [#128392](https://github.com/openclaw/openclaw/pull/128392)
- perf(ui): fix failing startup stylesheet and JavaScript budgets [#130037](https://github.com/openclaw/openclaw/pull/130037)
- fix(ui): make lobster visits less frequent [#132065](https://github.com/openclaw/openclaw/pull/132065)
- Clarify Workboard card drag feedback [#89821](https://github.com/openclaw/openclaw/pull/89821)

**Bug fixes**

- Preserve lobster vigil reactions and cancel interrupted pet gestures [#103483](https://github.com/openclaw/openclaw/pull/103483)
- Center the onboarding dashboard and fix card layout [#121416](https://github.com/openclaw/openclaw/pull/121416)
- Keep the lobster dismiss menu fully visible [#124261](https://github.com/openclaw/openclaw/pull/124261)
- improve(mattermost): speed up inbound direct-message replies [#128431](https://github.com/openclaw/openclaw/pull/128431)
- Keep the lobster pet above the sidebar footer [#106457](https://github.com/openclaw/openclaw/pull/106457)
- Restore the ClawHub verdict panel background [#113776](https://github.com/openclaw/openclaw/pull/113776)
- Restore the bundled Teams plugin icon [#117170](https://github.com/openclaw/openclaw/pull/117170)
- Keep app-card titles intact beside badges [#123375](https://github.com/openclaw/openclaw/pull/123375)
- Remove underlines from dashboard session cards [#124939](https://github.com/openclaw/openclaw/pull/124939)

</details>

</Accordion>

<Accordion title="Documentation">

Setup, migration, recovery, and feature guidance now covers [cloud workers](/gateway/cloud-workers), [meetings and media](/plugins/meeting-plugins), [Code Mode](/tools/code-mode), Swarm, portals, sandboxes, local speech, [SQLite migrations](/reference/database-schemas), [backups](/install/backups), and downgrade recovery more clearly. Mobile readers get better top-level links, and the Release and CI pages lose a redundant navigation layer. These are documentation and QA updates; runtime behaviour continues to follow the referenced product and platform contracts.

Two cloud-worker details remain out of sync. The Cloud Workers settings guide overstates profile information shown for providers other than Crabbox, and the Daytona guide says `settings.class` can be omitted even though profile validation still requires it, so Daytona profiles should keep the class explicit until the guide and product contract agree.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Documentation**

- Add a meeting plugin comparison and setup guide [09dd616](https://github.com/openclaw/openclaw/commit/09dd616)
- Explain one-way database migrations and downgrade recovery [#110487](https://github.com/openclaw/openclaw/pull/110487)
- Document the personal-agent main session [#110905](https://github.com/openclaw/openclaw/pull/110905)
- Document session self-service, visible spawns, task cancellation, and cron contracts [#111095](https://github.com/openclaw/openclaw/pull/111095)
- Add the public Swarm user guide [#111384](https://github.com/openclaw/openclaw/pull/111384)
- Add a cross-client media playback guide [#116005](https://github.com/openclaw/openclaw/pull/116005)
- Add the session synchronization and attachment guide [#121091](https://github.com/openclaw/openclaw/pull/121091)
- Document three-layer session ownership [#125334](https://github.com/openclaw/openclaw/pull/125334)
- Document Cloud Workers settings and machine selection [#126049](https://github.com/openclaw/openclaw/pull/126049)
- Consolidate setup and plugin documentation [#126132](https://github.com/openclaw/openclaw/pull/126132)
- docs: reframe docs for teams and soften group-chat guidance [#132012](https://github.com/openclaw/openclaw/pull/132012)
- Explain the sidebar unsent-draft pencil [4f046b5](https://github.com/openclaw/openclaw/commit/4f046b5)
- Add the Cloud Workers gateway guide [6029bf1](https://github.com/openclaw/openclaw/commit/6029bf1)
- Clarify hosted session state and image attachment debugging [8f23e68](https://github.com/openclaw/openclaw/commit/8f23e68)
- Document Discord voice chat alongside meeting plugins [b51e3d0](https://github.com/openclaw/openclaw/commit/b51e3d0)
- Add mobile-friendly links to top-level docs [#100908](https://github.com/openclaw/openclaw/pull/100908)
- Remove Android's retired Voice Wake code [#104914](https://github.com/openclaw/openclaw/pull/104914)
- Document local TTS setup across macOS, Linux, and Windows [#110230](https://github.com/openclaw/openclaw/pull/110230)
- Correct the Chrome extension session disk budget documentation [#110624](https://github.com/openclaw/openclaw/pull/110624)
- Align interactive client and Screen tool documentation [#111047](https://github.com/openclaw/openclaw/pull/111047)
- Explain Codex memory limits and fan-out controls [#111234](https://github.com/openclaw/openclaw/pull/111234)
- Align ask-user QA and docs with the current answer format [#111429](https://github.com/openclaw/openclaw/pull/111429)
- Fix the SenseAudio documentation link [#114021](https://github.com/openclaw/openclaw/pull/114021)
- Cross-link `agent exec` from automation and policy documentation [#114034](https://github.com/openclaw/openclaw/pull/114034)
- Explain steering at tool-call boundaries [#114249](https://github.com/openclaw/openclaw/pull/114249)
- Correct the documented `system.run` request fields [#116930](https://github.com/openclaw/openclaw/pull/116930)
- Document `nodes push` exit status [#117848](https://github.com/openclaw/openclaw/pull/117848)
- Update agent configuration examples to the canonical roster shape [#118722](https://github.com/openclaw/openclaw/pull/118722)
- Add a top-level Release & CI documentation tab [#119802](https://github.com/openclaw/openclaw/pull/119802)
- Simplify Release & CI documentation navigation [#120684](https://github.com/openclaw/openclaw/pull/120684)
- Document portal availability and tool-policy controls [#123091](https://github.com/openclaw/openclaw/pull/123091)
- Correct compaction-mode help and stabilize a QA timeout test [#124656](https://github.com/openclaw/openclaw/pull/124656)
- Correct Code Mode activation and recovery docs [#124792](https://github.com/openclaw/openclaw/pull/124792)
- docs(skills): teach current TaskFlow managedFlows runtime [#125647](https://github.com/openclaw/openclaw/pull/125647)
- Clarify where system-agent ownership applies [#126431](https://github.com/openclaw/openclaw/pull/126431)
- docs(nodes): clarify Mac node system commands [#128497](https://github.com/openclaw/openclaw/pull/128497)
- fix(docs): document OpenAI API auth for audio understanding alongside OAuth for reasoning [#128885](https://github.com/openclaw/openclaw/pull/128885)
- docs(sqlite): align database-first guidance [#129571](https://github.com/openclaw/openclaw/pull/129571)
- docs: cover sqlite3_rsync pull replication in the backups guide [#129820](https://github.com/openclaw/openclaw/pull/129820)
- docs(gateway): document the Daytona cloud-worker provider [#130282](https://github.com/openclaw/openclaw/pull/130282)
- docs(gateway): add Cloud Sessions overview page [#130301](https://github.com/openclaw/openclaw/pull/130301)
- docs: correct verification and hardened setup claims [#131188](https://github.com/openclaw/openclaw/pull/131188)
- docs: align gateway approval, web-tool limit, and search-provider docs with shipped behavior [#131252](https://github.com/openclaw/openclaw/pull/131252)
- docs: qualify architecture guarantees and refresh Hermes kernel details [#131928](https://github.com/openclaw/openclaw/pull/131928)
- docs: friendlier security and first-touch pages [#132067](https://github.com/openclaw/openclaw/pull/132067)
- docs: align Testing guide with changed-check owner tests [#132354](https://github.com/openclaw/openclaw/pull/132354)
- docs: reconcile session history sanitization guarantees [#132404](https://github.com/openclaw/openclaw/pull/132404)
- docs(mac): correct build commit metadata description [#132568](https://github.com/openclaw/openclaw/pull/132568)
- docs: clarify agent ownership in session monitoring [#132812](https://github.com/openclaw/openclaw/pull/132812)
- Explain valid legacy MEDIA line formatting [#96275](https://github.com/openclaw/openclaw/pull/96275)

</details>

</Accordion>

</AccordionGroup>
