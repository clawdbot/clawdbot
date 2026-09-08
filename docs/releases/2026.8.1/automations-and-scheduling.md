---
title: "v2026.8.1: Automations and Scheduling"
description: "Scheduled work comes together under one name across the agent, Control UI, command line, docs, and supported native apps."
---

[Automations](/automation) now bring scheduled work together under one name across the agent, Control UI, command line, docs, and supported native apps, while existing Cron commands, settings, jobs, and schedule syntax continue to work.

History separates whether an automation ran, whether its result was delivered, and whether the whole request completed. Work genuinely missed during a restart or clock change can return without reviving completed or retired jobs, and connected tools keep only the authority captured when the automation was created or reauthorized, checked against current policy and availability each time it runs.

<AccordionGroup>

<Accordion title="Creating and managing automations">

[Automations](/automation/cron-jobs) is now the user-facing name in the agent tool, Control UI, command line, and docs, while `openclaw automations` offers the same command family as `openclaw cron`. The old command, `/cron` route, `cron.*` settings and RPC names, schedule expressions, identifiers, and stored jobs continue to work.

The Control UI is the fullest place to search, filter, create, clone, inspect, edit, run, pause, and remove automations, including advanced delivery and failure routing. New Quick Create and starter automations stay internal unless you explicitly choose an Announce summary and its destination. iOS and Android expose the fields and actions each client supports, Android changes require administrator scope while read-scoped connections remain inspection-only, and script automations remain visible but read-only on clients that cannot replace their payload.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Safe cron job management on Android [#102997](https://github.com/openclaw/openclaw/pull/102997)
- Redesign scheduled tasks as the Automations workspace [#104251](https://github.com/openclaw/openclaw/pull/104251)
- Add cron starter ideas and immediate first runs [#104761](https://github.com/openclaw/openclaw/pull/104761)
- Redesign the Automations page as a full-width dashboard [#105174](https://github.com/openclaw/openclaw/pull/105174)
- Redesign the Control UI automation editor [#105254](https://github.com/openclaw/openclaw/pull/105254)
- Streamline the Automations page for daily use [#106044](https://github.com/openclaw/openclaw/pull/106044)
- Add native mobile Automations management [#106355](https://github.com/openclaw/openclaw/pull/106355)
- Add the `openclaw automations` CLI alias [#114854](https://github.com/openclaw/openclaw/pull/114854)
- Group automation and show live status in Activity [#125981](https://github.com/openclaw/openclaw/pull/125981)
- Make the Automations list easier to scan on desktop and mobile [#127198](https://github.com/openclaw/openclaw/pull/127198)
- feat: offer to turn a repeated job into a scheduled automation [#130120](https://github.com/openclaw/openclaw/pull/130120)
- Clearer Cron Jobs and Tasks navigation and status summaries [#103122](https://github.com/openclaw/openclaw/pull/103122)
- Rename the scheduler agent tool to automations [#114841](https://github.com/openclaw/openclaw/pull/114841)
- Rename agent and user scheduler wording to Automations [#114852](https://github.com/openclaw/openclaw/pull/114852)
- Use Automations consistently throughout the Control UI [#114853](https://github.com/openclaw/openclaw/pull/114853)
- Derive cron timezone suggestions from the browser [#115973](https://github.com/openclaw/openclaw/pull/115973)
- Consolidate Automations add and update schemas [#121645](https://github.com/openclaw/openclaw/pull/121645)
- Edit and clear automation display names from the CLI [#122702](https://github.com/openclaw/openclaw/pull/122702)
- Add Asia/Shanghai to Cron timezone suggestions [#65936](https://github.com/openclaw/openclaw/pull/65936)
- Highlight read-only automation scripts in Control UI [#113632](https://github.com/openclaw/openclaw/pull/113632)
- Show saved automation descriptions in the Cron dashboard [#118593](https://github.com/openclaw/openclaw/pull/118593)
- Make cron JSON help match actual command output [#124903](https://github.com/openclaw/openclaw/pull/124903)
- Show starter automations only for empty inventories [#125631](https://github.com/openclaw/openclaw/pull/125631)
- Expose all automation schedule filters [#126962](https://github.com/openclaw/openclaw/pull/126962)
- perf(cron): batch list output [#128191](https://github.com/openclaw/openclaw/pull/128191)
- Explain how to find disabled cron jobs [#78139](https://github.com/openclaw/openclaw/pull/78139)

**Bug fixes**

- Show script automations across user clients [#112195](https://github.com/openclaw/openclaw/pull/112195)
- Preserve advanced delivery routes when cloning automations [#117909](https://github.com/openclaw/openclaw/pull/117909)
- Keep cron list columns aligned with Unicode [#103889](https://github.com/openclaw/openclaw/pull/103889)
- Prevent Cron edits from disappearing during save [#105421](https://github.com/openclaw/openclaw/pull/105421)
- Fix blank Account IDs in Control UI cron delivery [#105762](https://github.com/openclaw/openclaw/pull/105762)
- Explain why automation runs do not start [#105858](https://github.com/openclaw/openclaw/pull/105858)
- Preserve second-based automation intervals when editing [#110034](https://github.com/openclaw/openclaw/pull/110034)
- Trim cron job IDs before exact Gateway lookup [#110849](https://github.com/openclaw/openclaw/pull/110849)
- List every cron job from one consistent Gateway snapshot [#113805](https://github.com/openclaw/openclaw/pull/113805)
- fix(tasks): prefer the newest live flow for owner-key TaskFlow lookup (#119129) [#119130](https://github.com/openclaw/openclaw/pull/119130)
- Keep paginated scheduled jobs on one snapshot [#121084](https://github.com/openclaw/openclaw/pull/121084)
- Show the actual selected values in Automations [#121811](https://github.com/openclaw/openclaw/pull/121811)
- Keep automation ownership when viewing all agents [#123381](https://github.com/openclaw/openclaw/pull/123381)
- Accept local port options across automations [#125474](https://github.com/openclaw/openclaw/pull/125474)
- Preserve Automation edits, run feedback, and local state [#125698](https://github.com/openclaw/openclaw/pull/125698)
- Keep Automation conflict recovery attached under active filters [#125782](https://github.com/openclaw/openclaw/pull/125782)
- fix(workboard): let proofId alone resolve an already-terminal proof [AI-assisted] [#127074](https://github.com/openclaw/openclaw/pull/127074)
- Accessible Automations task rows [#127252](https://github.com/openclaw/openclaw/pull/127252)
- fix: automation runs appear in creator activity [#128951](https://github.com/openclaw/openclaw/pull/128951)
- fix(cli): render cron edit JSON failures [#129022](https://github.com/openclaw/openclaw/pull/129022)
- fix(cli): hide banners for implicit JSON output [#129204](https://github.com/openclaw/openclaw/pull/129204)
- fix: agent-created automations appear under the session creator [#129371](https://github.com/openclaw/openclaw/pull/129371)
- fix(ui): automation actions fail and schedule changes unexpectedly [#129469](https://github.com/openclaw/openclaw/pull/129469)
- fix(agents): stop suggesting unavailable automation tools [#129953](https://github.com/openclaw/openclaw/pull/129953)
- fix(lobster): keep rejected approvals cancelled and enforce output limits [#130259](https://github.com/openclaw/openclaw/pull/130259)
- refactor(macos): automation summaries as hosted cards with clickable job rows [#130502](https://github.com/openclaw/openclaw/pull/130502)
- fix(ui): keep new automations internal by default [#131504](https://github.com/openclaw/openclaw/pull/131504)
- Remove missing-agent warnings from command cron jobs [#112043](https://github.com/openclaw/openclaw/pull/112043)
- Keep paused automations after scheduled jobs [#113745](https://github.com/openclaw/openclaw/pull/113745)
- Correct Doctor warnings for automation jobs stored in SQLite [#116769](https://github.com/openclaw/openclaw/pull/116769)
- Align cron list ordering and display-name search [#116834](https://github.com/openclaw/openclaw/pull/116834)
- Fix rounded cron schedule durations [#118280](https://github.com/openclaw/openclaw/pull/118280)
- Require decimal cron scratch revisions [#119518](https://github.com/openclaw/openclaw/pull/119518)
- Reject blank cron routing values during edits [#119879](https://github.com/openclaw/openclaw/pull/119879)
- Reject blank cron model or thinking flags combined with clear flags [#119894](https://github.com/openclaw/openclaw/pull/119894)
- fix(automations): stop offering rejected agent retargets [#121100](https://github.com/openclaw/openclaw/pull/121100)
- Clear saved automation destinations in Control UI [#123171](https://github.com/openclaw/openclaw/pull/123171)
- Give missing automations clear recovery guidance [#124663](https://github.com/openclaw/openclaw/pull/124663)
- fix(cli): keep automation JSON clean with parent connection options [#128343](https://github.com/openclaw/openclaw/pull/128343)
- fix(ui): Cron shows a false empty state during initial loading [#130430](https://github.com/openclaw/openclaw/pull/130430)

**Documentation**

- Rename scheduler documentation to Automations [#114855](https://github.com/openclaw/openclaw/pull/114855)

</details>

</Accordion>

<Accordion title="Schedules and runs">

An owner can turn the current conversation into a [`/loop`](/automation/cron-jobs) or eligible reminder that checks a small amount of recent context when it runs and returns one final answer to the same chat. It starts as a fresh run rather than continuing the original transcript, and work created without a conversation stays isolated.

Recurring schedules, one-time jobs, manual starts, queued work, restart catch-up, on-exit work, commands, and bounded scripts now share one configured capacity limit. Waiting work starts as room becomes available, while successful scripts can retain a small amount of state, notify a destination, wake the main conversation, or ask to be checked again later. Scripts still have time, tool-call, pacing, and state limits, and can be disabled entirely.

Force runs and edits no longer pull recurring work away from its natural schedule. Timezone-aware schedules skip local times that never occur, choose the first real occurrence when a local time repeats, and continue to respect explicit offsets after a restart.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Let cron jobs choose their next check within operator bounds [#110978](https://github.com/openclaw/openclaw/pull/110978)
- Add headless script payloads to cron jobs [#111112](https://github.com/openclaw/openclaw/pull/111112)
- Add conversation-bound scheduling and `/loop` [#114328](https://github.com/openclaw/openclaw/pull/114328)
- Cron jobs use free capacity across timer ticks [#119195](https://github.com/openclaw/openclaw/pull/119195)
- perf(cron): summarize timer schedule in one pass [#127495](https://github.com/openclaw/openclaw/pull/127495)
- improve(cron): reuse resolved schedule timezone [AI] [#127311](https://github.com/openclaw/openclaw/pull/127311)
- perf(cron): skip history checks for future jobs [#128048](https://github.com/openclaw/openclaw/pull/128048)

**Bug fixes**

- Enforce one cron concurrency limit across every trigger [#103323](https://github.com/openclaw/openclaw/pull/103323)
- Keep recurring cron cadence stable across force runs and edits [#111331](https://github.com/openclaw/openclaw/pull/111331)
- Reject malformed Code Mode cron scripts before saving [#118100](https://github.com/openclaw/openclaw/pull/118100)
- Correct cron scheduling across timezone transitions [#118712](https://github.com/openclaw/openclaw/pull/118712)
- Stop active cron runs when jobs are removed or disabled [#123437](https://github.com/openclaw/openclaw/pull/123437)
- Isolate commitment extraction by agent [#104426](https://github.com/openclaw/openclaw/pull/104426)
- Keep manual cron runs alive after their RPC returns [#104595](https://github.com/openclaw/openclaw/pull/104595)
- Retry one-shot cron session-claim races [#107236](https://github.com/openclaw/openclaw/pull/107236)
- Validate recurring schedule intervals exactly [#107480](https://github.com/openclaw/openclaw/pull/107480)
- Prevent completed cron work from replaying after claim conflicts [#108682](https://github.com/openclaw/openclaw/pull/108682)
- Honor cron script limits and permanent failures [#112415](https://github.com/openclaw/openclaw/pull/112415)
- Harden cron pacing, on-exit jobs, and shutdown [#112766](https://github.com/openclaw/openclaw/pull/112766)
- Stop retrying scheduled jobs after permanent billing failures [#114113](https://github.com/openclaw/openclaw/pull/114113)
- Bind DM-created cron jobs to the real conversation [#114421](https://github.com/openclaw/openclaw/pull/114421)
- Give current-bound cron runs recent conversation context [#114455](https://github.com/openclaw/openclaw/pull/114455)
- Prevent false cron failures while execution lanes are busy [#114512](https://github.com/openclaw/openclaw/pull/114512)
- Prevent cron and Workboard lifecycle races [#114674](https://github.com/openclaw/openclaw/pull/114674)
- Stop stalled scheduled-task fallbacks across all execution phases [#114815](https://github.com/openclaw/openclaw/pull/114815)
- Allow no-timeout cron jobs in Control UI [#115090](https://github.com/openclaw/openclaw/pull/115090)
- Protect scheduled-run sessions during model setup [#115804](https://github.com/openclaw/openclaw/pull/115804)
- Honor timezones and end-of-day values in one-shot cron schedules [#117969](https://github.com/openclaw/openclaw/pull/117969)
- Honor time zones and first DST occurrences in one-shot cron schedules [#118297](https://github.com/openclaw/openclaw/pull/118297)
- Keep cold scheduled turns from blocking the Gateway [#123368](https://github.com/openclaw/openclaw/pull/123368)
- Keep explicit-agent cron jobs running without a default agent [#123516](https://github.com/openclaw/openclaw/pull/123516)
- Keep agent-less schedules running after adding an agent [#123914](https://github.com/openclaw/openclaw/pull/123914)
- Stop retrying permanent cron command failures [#126763](https://github.com/openclaw/openclaw/pull/126763)
- Return current-session cron results to the originating chat [#126860](https://github.com/openclaw/openclaw/pull/126860)
- fix(cron): prevent stale current-session results after reset [#127854](https://github.com/openclaw/openclaw/pull/127854)
- refactor(cron): centralize automation mutation options [#128373](https://github.com/openclaw/openclaw/pull/128373)
- fix(cron): prevent script timeouts when system clock changes [#130238](https://github.com/openclaw/openclaw/pull/130238)
- Preserve script worker timeouts across clock changes [#130408](https://github.com/openclaw/openclaw/pull/130408)
- fix(tasks): retain CLI runs in standalone maintenance [#132602](https://github.com/openclaw/openclaw/pull/132602)
- Align isolated cron child-model precedence with native spawning [#58823](https://github.com/openclaw/openclaw/pull/58823)
- Let isolated cron setup use the configured timeout [#93914](https://github.com/openclaw/openclaw/pull/93914)
- Stabilize prompt caching across isolated cron runs [#96686](https://github.com/openclaw/openclaw/pull/96686)
- Reject malformed cron command environment maps instead of dropping them [#106100](https://github.com/openclaw/openclaw/pull/106100)
- Close stalled local-provider sockets during cron preflight [#114540](https://github.com/openclaw/openclaw/pull/114540)
- QQBot reminders honor the Gateway timezone [#116294](https://github.com/openclaw/openclaw/pull/116294)
- Retry Cron jobs after interrupted model streams [#118130](https://github.com/openclaw/openclaw/pull/118130)
- Reject unsupported generic cron timeout edits [#119899](https://github.com/openclaw/openclaw/pull/119899)
- Retry on-exit Cron watchers after transient supervisor failures [#120023](https://github.com/openclaw/openclaw/pull/120023)
- Reject blank cron command working directories locally [#121535](https://github.com/openclaw/openclaw/pull/121535)
- fix(agents): prevent false reminder warnings after compaction [#128581](https://github.com/openclaw/openclaw/pull/128581)
- fix(cron): recurring automations run too early after interval edits [#128893](https://github.com/openclaw/openclaw/pull/128893)
- fix(cron): reject generic timeouts for script payloads [#129407](https://github.com/openclaw/openclaw/pull/129407)
- fix(cron): prevent run waits from failing after clock changes [#129805](https://github.com/openclaw/openclaw/pull/129805)
- fix(cron): avoid cold script timeouts during plugin preparation [#131321](https://github.com/openclaw/openclaw/pull/131321)

**Documentation**

- Recommend lighter models for routine cron jobs [#125000](https://github.com/openclaw/openclaw/pull/125000)

</details>

</Accordion>

<Accordion title="Triggers and connected tools">

An automation can now wait for a [condition or monitored event stream](/automation/cron-jobs) and run when something changes. Conditions can be created, filtered, edited, and inspected in the Control UI, are checked before they are saved, and record checks and matches without creating a run for every non-match. Stream schedules are created through the command line or agent and remain read-only in the Control UI, with bounded buffering, batching, and restart backoff. Triggers can still be disabled entirely, and condition intervals must be at least 30 seconds.

New or reauthorized Codex jobs can keep the app permissions and eligible connected-tool access they were created with across restarts. That captured authority is a ceiling checked on every run against current accounts, configuration, policy, approvals, and availability. Tools requiring someone present to approve them stay excluded, existing limits do not expand automatically, and some older jobs need a one-time edit or reauthorization before they can retain this access.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Let Claw packages own scheduled jobs [#102383](https://github.com/openclaw/openclaw/pull/102383)
- Add supervised stream sources to cron schedules [#112387](https://github.com/openclaw/openclaw/pull/112387)
- Preserve Codex app access for scheduled automations [#121859](https://github.com/openclaw/openclaw/pull/121859)
- Enable automation triggers by default [#125025](https://github.com/openclaw/openclaw/pull/125025)
- Manage automation condition triggers in Control UI [#126534](https://github.com/openclaw/openclaw/pull/126534)
- Add a cron reconciliation lifecycle hook for plugins [#104191](https://github.com/openclaw/openclaw/pull/104191)
- Improve unattended cron results and watcher guidance [#110949](https://github.com/openclaw/openclaw/pull/110949)
- Persist explicit tool authority on new scheduled jobs [#112483](https://github.com/openclaw/openclaw/pull/112483)

**Bug fixes**

- Preserve authorized tools for senderless scheduled runs [#112661](https://github.com/openclaw/openclaw/pull/112661)
- Restore configured MCP tools in scheduled Codex turns [#120366](https://github.com/openclaw/openclaw/pull/120366)
- Restore Gateway tools in scheduled agent runs [#126640](https://github.com/openclaw/openclaw/pull/126640)
- fix(cron): capture Codex shell aliases under canonical tool identity with a restrict-only exec pin [#130579](https://github.com/openclaw/openclaw/pull/130579)
- Notify plugins when cron wake times change [#103647](https://github.com/openclaw/openclaw/pull/103647)
- Keep accepted hook agent runs alive after the response [#104686](https://github.com/openclaw/openclaw/pull/104686)
- Bound agent-hook runner admission [#104712](https://github.com/openclaw/openclaw/pull/104712)
- Make agent-authored cron condition watchers reliable [#104787](https://github.com/openclaw/openclaw/pull/104787)
- Preserve recurring plugin-scheduled jobs through registry churn [#107752](https://github.com/openclaw/openclaw/pull/107752)
- Recognize auto-detected Brave search in isolated cron preflight [#108636](https://github.com/openclaw/openclaw/pull/108636)
- Preserve bursts of same-session agent hooks [#110575](https://github.com/openclaw/openclaw/pull/110575)
- Preserve condition triggers in flattened cron requests [#110912](https://github.com/openclaw/openclaw/pull/110912)
- fix(cron): ignore inherited normalization fields [#111728](https://github.com/openclaw/openclaw/pull/111728)
- Initialize sessions for detached hook runs [#115765](https://github.com/openclaw/openclaw/pull/115765)
- Prevent cron saturation from starving hook dispatch [#116666](https://github.com/openclaw/openclaw/pull/116666)
- Align cron delivery guidance with available tools [#116908](https://github.com/openclaw/openclaw/pull/116908)
- Match Automations options to cron trigger settings [#122052](https://github.com/openclaw/openclaw/pull/122052)
- Prevent hook traffic from starving older scheduled work [#122764](https://github.com/openclaw/openclaw/pull/122764)
- Validate automation condition triggers before submission [#126718](https://github.com/openclaw/openclaw/pull/126718)
- Keep automation trigger controls aligned with the active scheduler [#126945](https://github.com/openclaw/openclaw/pull/126945)
- Reject invalid automation conditions before saving [#127004](https://github.com/openclaw/openclaw/pull/127004)
- fix(hooks): avoid false admission timeouts during runtime reload [#128975](https://github.com/openclaw/openclaw/pull/128975)
- perf(cron): carry the published plugin generation into hook/cron isolated runs [#130581](https://github.com/openclaw/openclaw/pull/130581)
- fix(cron): surface command prompt capability failures [#131123](https://github.com/openclaw/openclaw/pull/131123)
- fix(hooks): report the actual wake enqueue outcome [#131952](https://github.com/openclaw/openclaw/pull/131952)
- fix: allow subagent spawns from system events [#132890](https://github.com/openclaw/openclaw/pull/132890)
- refactor: keep internal wakes out of message channels [#132986](https://github.com/openclaw/openclaw/pull/132986)
- Preserve tool calls in isolated announce cron jobs [#106596](https://github.com/openclaw/openclaw/pull/106596)
- Reload edited webhook transform modules without restarting [#107875](https://github.com/openclaw/openclaw/pull/107875)
- Reject oversized cron trigger scripts during ingestion [#108130](https://github.com/openclaw/openclaw/pull/108130)
- Remove unchanged Claw cron jobs despite scheduler defaults [#113045](https://github.com/openclaw/openclaw/pull/113045)
- Allow Automations to explicitly run without tools [#113403](https://github.com/openclaw/openclaw/pull/113403)
- Align configured automation trigger status with the Advanced heading [#126784](https://github.com/openclaw/openclaw/pull/126784)
- fix: stop cron exec approval spam [#128031](https://github.com/openclaw/openclaw/pull/128031)
- fix: reject blank trigger scripts when creating automations [#129533](https://github.com/openclaw/openclaw/pull/129533)
- fix(cron): stop suggesting unavailable tools in scheduled runs [#130228](https://github.com/openclaw/openclaw/pull/130228)

**Documentation**

- Document safe external cron projection [#104227](https://github.com/openclaw/openclaw/pull/104227)
- Document Lobster workflow environment variables and step outputs [#108622](https://github.com/openclaw/openclaw/pull/108622)

</details>

</Accordion>

<Accordion title="Heartbeats and email watchers">

[Heartbeat schedules](/automation) are now managed as Automations, with failed work and alerts remaining visible and retryable and queued wakes surviving busy periods, handler replacement, and clock changes. Disabling Cron stops scheduled heartbeats while manual and event-driven wakes remain available. Existing installations using `HEARTBEAT.md` must run `openclaw doctor --fix` to migrate valid work because OpenClaw no longer reads that file at runtime.

[Gmail](/automation/cron-jobs) can split an accepted batch into one isolated run per message when its mapping opts in, filter Sent and Draft mail, and keep forwarding through watcher restarts without overlapping renewals or repeated restart loops. Ordinary custom mappings keep their existing behavior, and expired-OAuth renewal health is unchanged.

The bundled IMAP watcher lets authenticated new mail from an existing mailbox start a restricted reader agent without exposing an HTTP hook. It is disabled by default and inbound-only, requires sender allowlisting and authentication, and cannot send or modify mail. After three temporary admission failures, the message is recorded as skipped.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Move heartbeat checklists into database-backed cron scratch [#112967](https://github.com/openclaw/openclaw/pull/112967)
- Convert heartbeat tasks into independent cron jobs [#113165](https://github.com/openclaw/openclaw/pull/113165)
- feat(plugins): inbound IMAP email trigger [#130230](https://github.com/openclaw/openclaw/pull/130230)
- Move heartbeat cadence into system-owned cron monitors [#112585](https://github.com/openclaw/openclaw/pull/112585)
- Require Doctor migration for legacy HEARTBEAT.md files [#113131](https://github.com/openclaw/openclaw/pull/113131)
- Make cron monitor rows authoritative for heartbeat cadence [#113135](https://github.com/openclaw/openclaw/pull/113135)
- refactor(cron): unify heartbeat automations under cron ownership [#129862](https://github.com/openclaw/openclaw/pull/129862)
- Carry silent heartbeat results into the next user turn [#95838](https://github.com/openclaw/openclaw/pull/95838)
- Explain heartbeat skips when delivery is disabled [#119689](https://github.com/openclaw/openclaw/pull/119689)
- refactor(agents): remove redundant heartbeat system prompts [#129642](https://github.com/openclaw/openclaw/pull/129642)

**Bug fixes**

- Preserve heartbeat failures after unsuccessful tool actions [#107735](https://github.com/openclaw/openclaw/pull/107735)
- Keep scheduled heartbeat tasks active for the model [#110193](https://github.com/openclaw/openclaw/pull/110193)
- Prevent duplicate cron wakes and stale heartbeat races [#114801](https://github.com/openclaw/openclaw/pull/114801)
- Prevent stalled schedules, duplicate cron runs, and lost heartbeats [#115979](https://github.com/openclaw/openclaw/pull/115979)
- Preserve cold automation wakes and bound notification cleanup [#117018](https://github.com/openclaw/openclaw/pull/117018)
- Deliver main-target cron reminders in the owning main session [#125198](https://github.com/openclaw/openclaw/pull/125198)
- Prevent heartbeat ownership from crashing gateway startup [#126232](https://github.com/openclaw/openclaw/pull/126232)
- fix(anthropic): keep automated heartbeats on subscription usage [#129513](https://github.com/openclaw/openclaw/pull/129513)
- fix(gateway): fan out batched gmail hook pushes and bound gmail hook bodies [#130002](https://github.com/openclaw/openclaw/pull/130002)
- Keep global-scope heartbeats with the selected agent [#102307](https://github.com/openclaw/openclaw/pull/102307)
- Validate heartbeat hours without an explicit cadence [#102319](https://github.com/openclaw/openclaw/pull/102319)
- Keep commitment heartbeats responsive with large queues [#105780](https://github.com/openclaw/openclaw/pull/105780)
- Run main-session cron jobs outside heartbeat active hours [#105830](https://github.com/openclaw/openclaw/pull/105830)
- Stop Gmail watcher respawn loops after bind failures [#106314](https://github.com/openclaw/openclaw/pull/106314)
- Prevent overlapping Gmail watch renewals [#108974](https://github.com/openclaw/openclaw/pull/108974)
- Stop cron jobs from blocking their own immediate wake [#109440](https://github.com/openclaw/openclaw/pull/109440)
- Retry authentication alerts after notification delivery fails [#110760](https://github.com/openclaw/openclaw/pull/110760)
- Let Gmail setup skip unsupported Python versions [#112983](https://github.com/openclaw/openclaw/pull/112983)
- Remove retired HEARTBEAT.md from agent file surfaces [#113621](https://github.com/openclaw/openclaw/pull/113621)
- Suppress reasoning-only heartbeat acknowledgements [#114454](https://github.com/openclaw/openclaw/pull/114454)
- Remove silent heartbeat reasoning turns from future context [#115522](https://github.com/openclaw/openclaw/pull/115522)
- Deliver heartbeat follow-ups when scheduled tasks run first [#115581](https://github.com/openclaw/openclaw/pull/115581)
- Route mapped wake hooks to configured sessions [#116109](https://github.com/openclaw/openclaw/pull/116109)
- Serialize heartbeat wakes and cancel active work on shutdown [#116351](https://github.com/openclaw/openclaw/pull/116351)
- Keep failed heartbeat work pending after alerts [#118488](https://github.com/openclaw/openclaw/pull/118488)
- Deliver structured heartbeat replies and clear owned recovery [#119655](https://github.com/openclaw/openclaw/pull/119655)
- Recover isolated heartbeats after session archival [#120314](https://github.com/openclaw/openclaw/pull/120314)
- Prevent heartbeat routing metadata from appearing as user input [#122075](https://github.com/openclaw/openclaw/pull/122075)
- fix(heartbeat): preserve cancelled agent turns [#122345](https://github.com/openclaw/openclaw/pull/122345)
- Deliver completed heartbeats in explicit multi-agent fleets [#123303](https://github.com/openclaw/openclaw/pull/123303)
- Apply heartbeat cadence changes on hot reload [#124410](https://github.com/openclaw/openclaw/pull/124410)
- Honor explicit HTTP hook agent and session targets [#125351](https://github.com/openclaw/openclaw/pull/125351)
- Heartbeat monitor wakes honor the configured session [#127153](https://github.com/openclaw/openclaw/pull/127153)
- fix(heartbeat): preserve cron wakes across clock jumps and handler replacement [#129214](https://github.com/openclaw/openclaw/pull/129214)
- fix(cron): deliver auto-disable warnings when heartbeats are disabled [#129560](https://github.com/openclaw/openclaw/pull/129560)
- fix(cron): immediate script reminders disappear when heartbeat cadence is disabled [#129936](https://github.com/openclaw/openclaw/pull/129936)
- fix(heartbeat): preserve wake outcomes and emit busy skips [#130806](https://github.com/openclaw/openclaw/pull/130806)
- fix(gmail): keep forwarding alive across watcher restarts [#130853](https://github.com/openclaw/openclaw/pull/130853)
- fix: surface delivered heartbeat alerts in target session context [#130871](https://github.com/openclaw/openclaw/pull/130871)
- fix(hooks): run plugin triggers with HTTP hooks disabled [#131059](https://github.com/openclaw/openclaw/pull/131059)
- fix(imap): reject mail with missing DMARC alignment [#131060](https://github.com/openclaw/openclaw/pull/131060)
- fix(imap): retry reader admission during IDLE and reconnect [#131072](https://github.com/openclaw/openclaw/pull/131072)
- refactor(imap): consume the core identifier-authentication scale [#131178](https://github.com/openclaw/openclaw/pull/131178)
- Suppress silent acknowledgements from async command completions [#73785](https://github.com/openclaw/openclaw/pull/73785)
- Bound HEARTBEAT.md reads and warn on oversized files [#101775](https://github.com/openclaw/openclaw/pull/101775)
- Stop ntfy auth notifications from hanging the monitor [#108650](https://github.com/openclaw/openclaw/pull/108650)
- Clean up Gmail watcher helper processes on shutdown [#112452](https://github.com/openclaw/openclaw/pull/112452)
- Honor unlimited timeouts for heartbeat runs [#119297](https://github.com/openclaw/openclaw/pull/119297)
- Reserve the migrated heartbeat-task namespace [#123729](https://github.com/openclaw/openclaw/pull/123729)
- Show quiet-hours heartbeat skips in status [#124542](https://github.com/openclaw/openclaw/pull/124542)
- Report heartbeat responses as accepted before post-turn handling [#125207](https://github.com/openclaw/openclaw/pull/125207)
- Report the heartbeat cadence that is actually active [#126869](https://github.com/openclaw/openclaw/pull/126869)
- fix(heartbeat): deliver manual wakes when recurring cadence is disabled [#129836](https://github.com/openclaw/openclaw/pull/129836)
- fix(imap): stop reporting strength before mail authentication [#131304](https://github.com/openclaw/openclaw/pull/131304)
- fix(gmail): keep setup command failures readable [#131502](https://github.com/openclaw/openclaw/pull/131502)
- Filter sent mail and drafts from Gmail hooks [#56720](https://github.com/openclaw/openclaw/pull/56720)
- Keep sub-minute heartbeats within active hours [#96684](https://github.com/openclaw/openclaw/pull/96684)

**Documentation**

- Remove retired heartbeat options from documentation [#113455](https://github.com/openclaw/openclaw/pull/113455)
- Remove obsolete heartbeat skip paths and guidance [#124385](https://github.com/openclaw/openclaw/pull/124385)

</details>

</Accordion>

<Accordion title="History, alerts, and delivery">

[Automation history](/automation/cron-jobs) now treats running the work, delivering its result, and completing the whole request as separate facts. A job can execute successfully while the request still fails because requested delivery did not settle, and delivery is required unless best-effort is explicitly selected. Current-session work on a web-only Gateway counts the durable conversation result as completion when there is no external route, while an unavailable named route remains a delivery error without rerunning work that already completed. A successful delivery retry clears an earlier transient error, and intentional suppression is shown with its recorded reason in the command line and Control UI instead of looking like a failed delivery. Primary webhooks record accepted or failed outcomes before finalization, while secondary completion webhooks remain detached fan-out.

History can show duration, token totals, cache counters, condition checks and fires, delivery traces, cancellation or failure reasons, and direct Inspect links from eligible visible notifications. Inspect links require `gateway.publicOrigin`, historical rows may not have every optional counter, and condition activity belongs to the job's history rather than the global feed.

Failure alerts use configurable routes, thresholds, and cooldowns, with route-backed alerts defaulting to two consecutive failures and a one-hour cooldown. Recurring `cron` or `every` jobs disable themselves after ten consecutive execution failures and explain how to re-enable them, while delivery-only failures do not advance that streak and a successful run or manual re-enable resets it.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Auto-disable repeatedly failing recurring automations [#118113](https://github.com/openclaw/openclaw/pull/118113)
- feat(cron): link chat notifications to Control UI run inspection [#130049](https://github.com/openclaw/openclaw/pull/130049)
- Show conditional automation activity in run history [#127200](https://github.com/openclaw/openclaw/pull/127200)
- Show the original run time in delayed cron failure alerts [#80246](https://github.com/openclaw/openclaw/pull/80246)

**Bug fixes**

- Prevent cron and Workboard execution races [#114808](https://github.com/openclaw/openclaw/pull/114808)
- Deliver scheduled child results when parents emit no text [#117308](https://github.com/openclaw/openclaw/pull/117308)
- Deliver cron webhooks and record their outcomes [#117783](https://github.com/openclaw/openclaw/pull/117783)
- Report required cron delivery failures as failed completion [#126164](https://github.com/openclaw/openclaw/pull/126164)
- Honor cron failure-alert thresholds and cooldowns [#126483](https://github.com/openclaw/openclaw/pull/126483)
- fix(cron): record real delivery outcomes and stop false-success completions [#131228](https://github.com/openclaw/openclaw/pull/131228)
- Surface failures when scheduled agent runs finish empty [#100229](https://github.com/openclaw/openclaw/pull/100229)
- Reject invalid cron failure-alert channels before saving [#103866](https://github.com/openclaw/openclaw/pull/103866)
- Let recovered cron runs use their final report [#104908](https://github.com/openclaw/openclaw/pull/104908)
- Separate cron execution status from delivery failures [#105215](https://github.com/openclaw/openclaw/pull/105215)
- Avoid duplicate retries for direct cron delivery [#105941](https://github.com/openclaw/openclaw/pull/105941)
- Let Cron failure-alert overrides be cleared [#108578](https://github.com/openclaw/openclaw/pull/108578)
- Keep cron running when its webhook secret is unavailable [#109739](https://github.com/openclaw/openclaw/pull/109739)
- Release cron webhook sockets after unread responses [#111236](https://github.com/openclaw/openclaw/pull/111236)
- Keep successful cron commands on schedule when delivery fails [#111345](https://github.com/openclaw/openclaw/pull/111345)
- Deliver global cron failure alerts to the right destination [#113737](https://github.com/openclaw/openclaw/pull/113737)
- Keep Automations run history matched to the current request [#113765](https://github.com/openclaw/openclaw/pull/113765)
- Deliver scheduled results after heartbeat acknowledgements [#113924](https://github.com/openclaw/openclaw/pull/113924)
- Finalize completed cron jobs without waiting for slower siblings [#114441](https://github.com/openclaw/openclaw/pull/114441)
- Fix cron delivery account selection and plan consistency [#114918](https://github.com/openclaw/openclaw/pull/114918)
- Bound cron alerts and continue heartbeat cleanup after failures [#114920](https://github.com/openclaw/openclaw/pull/114920)
- Deliver explicit cron failure alerts for best-effort jobs [#115762](https://github.com/openclaw/openclaw/pull/115762)
- Preserve cron timeout and cancellation reasons [#116566](https://github.com/openclaw/openclaw/pull/116566)
- Keep cron failure alerts in their configured thread [#116830](https://github.com/openclaw/openclaw/pull/116830)
- Preserve final outcomes for self-removing cron jobs [#116881](https://github.com/openclaw/openclaw/pull/116881)
- Reject disabled channel accounts when scheduling automations [#116899](https://github.com/openclaw/openclaw/pull/116899)
- Fix cron failure-alert routing and account ownership [#117765](https://github.com/openclaw/openclaw/pull/117765)
- Improve automation filter accessibility and focus [#118133](https://github.com/openclaw/openclaw/pull/118133)
- Send cron failure alerts only after outcomes are persisted [#118200](https://github.com/openclaw/openclaw/pull/118200)
- Publish cron auto-disable state only after persistence [#118384](https://github.com/openclaw/openclaw/pull/118384)
- Deliver cron child results after heartbeat-only parent replies [#118743](https://github.com/openclaw/openclaw/pull/118743)
- fix(cron): preserve tool failures after silent replies [#120056](https://github.com/openclaw/openclaw/pull/120056)
- Add one-click Codex re-login to expired automation alerts [#121067](https://github.com/openclaw/openclaw/pull/121067)
- Show actionable Code Mode MCP failures in cron history [#121796](https://github.com/openclaw/openclaw/pull/121796)
- Record exhausted stream failures before sending alerts [#122187](https://github.com/openclaw/openclaw/pull/122187)
- Alert when cron output delivery fails [#123237](https://github.com/openclaw/openclaw/pull/123237)
- Keep multi-agent automation delivery with its owning agent [#123283](https://github.com/openclaw/openclaw/pull/123283)
- Distinguish auto-disabled automations from paused jobs [#123769](https://github.com/openclaw/openclaw/pull/123769)
- Show skipped automation runs as failed tasks [#123787](https://github.com/openclaw/openclaw/pull/123787)
- Show cleaner, accurate Automation failure reasons [#124511](https://github.com/openclaw/openclaw/pull/124511)
- Honor cron job ownership during failure delivery [#124631](https://github.com/openclaw/openclaw/pull/124631)
- Prune terminal cron task history after seven days [#126095](https://github.com/openclaw/openclaw/pull/126095)
- Return final results for completed cron and CLI tasks [#127045](https://github.com/openclaw/openclaw/pull/127045)
- fix(cron): stop reporting suppressed scheduled messages as delivered [#128519](https://github.com/openclaw/openclaw/pull/128519)
- fix(cron): failure alerts silently switch to the wrong conversation [#129645](https://github.com/openclaw/openclaw/pull/129645)
- fix(cron): prevent dropped and duplicate failure alerts [#129908](https://github.com/openclaw/openclaw/pull/129908)
- fix(cron): preserve verified message delivery when an agent run later fails [#129974](https://github.com/openclaw/openclaw/pull/129974)
- fix(cron): persist delivery suppression reason and log strict failures [#130811](https://github.com/openclaw/openclaw/pull/130811)
- fix(hooks): report delivery failures after successful runs [#130926](https://github.com/openclaw/openclaw/pull/130926)
- fix(cron): distinguish intentionally suppressed deliveries [#131774](https://github.com/openclaw/openclaw/pull/131774)
- fix: show recorded delivery suppression in automation history [#131830](https://github.com/openclaw/openclaw/pull/131830)
- fix(cron): current-session automations fail with "Channel is required" on webchat-only gateways [#131975](https://github.com/openclaw/openclaw/pull/131975)
- Let intentionally silent scheduled runs succeed [#95725](https://github.com/openclaw/openclaw/pull/95725)
- Restore channel-based cron failure alerts [#102445](https://github.com/openclaw/openclaw/pull/102445)
- Preserve complete Unicode characters in cron diagnostics [#102624](https://github.com/openclaw/openclaw/pull/102624)
- Preserve valid Unicode in cron exec failure tails [#104385](https://github.com/openclaw/openclaw/pull/104385)
- Reject unsupported cron delivery flags with a clear error [#105910](https://github.com/openclaw/openclaw/pull/105910)
- Reject malformed cron delivery targets before scheduling [#106952](https://github.com/openclaw/openclaw/pull/106952)
- Show readable token counts and durations in cron run history [#108014](https://github.com/openclaw/openclaw/pull/108014)
- Stop reporting successful silent cron turns as errors [#114528](https://github.com/openclaw/openclaw/pull/114528)
- Preserve cron failure-alert account and thread routing [#116933](https://github.com/openclaw/openclaw/pull/116933)
- Link active cron tasks to their actual execution transcripts [#117679](https://github.com/openclaw/openclaw/pull/117679)
- Preserve additional cron delivery fields in the macOS editor [#118047](https://github.com/openclaw/openclaw/pull/118047)
- fix(cron): report a verified agent send instead of "not-requested" [#118260](https://github.com/openclaw/openclaw/pull/118260)
- Reject ambiguous multi-channel cron delivery at mutation time [#118272](https://github.com/openclaw/openclaw/pull/118272)
- Publish cron auto-disable notifications only after persistence [#118778](https://github.com/openclaw/openclaw/pull/118778)
- fix(cron): reject main-session chat delivery instead of silent drop [#119923](https://github.com/openclaw/openclaw/pull/119923)
- Reject invalid cron webhook URLs before Gateway calls [#121533](https://github.com/openclaw/openclaw/pull/121533)
- Retain agent-filtered Cron history after job deletion [#122791](https://github.com/openclaw/openclaw/pull/122791)
- Stop retrying permanent cron delivery rejections [#122821](https://github.com/openclaw/openclaw/pull/122821)
- Stop marking running automations as overdue [#123745](https://github.com/openclaw/openclaw/pull/123745)
- Finalize direct cron runs removed during execution [#124457](https://github.com/openclaw/openclaw/pull/124457)
- fix(cron): run history omits cache token counters, leaving token totals unexplainable [#124657](https://github.com/openclaw/openclaw/pull/124657)
- Add cron delivery traces to the public run-history type [#124856](https://github.com/openclaw/openclaw/pull/124856)
- Report missing automations instead of empty cron history [#125343](https://github.com/openclaw/openclaw/pull/125343)
- Warn when cron notifications reference removed agents [#126361](https://github.com/openclaw/openclaw/pull/126361)
- Show safe automation failure details in chat alerts [#126384](https://github.com/openclaw/openclaw/pull/126384)
- fix(macos): keep Cron run history matched to the selected job [#127266](https://github.com/openclaw/openclaw/pull/127266)
- fix(ui): keep run history dropdown text consistent across devices [#127443](https://github.com/openclaw/openclaw/pull/127443)
- fix(cron): preserve failure alert routes across channel aliases [#128280](https://github.com/openclaw/openclaw/pull/128280)
- fix(cron): scheduled delivery failures are shown as success [#129160](https://github.com/openclaw/openclaw/pull/129160)
- fix(cron): send completion webhooks for failed automation runs [#129247](https://github.com/openclaw/openclaw/pull/129247)
- fix(cron): cancellation reason survives late delivery finalization [#129331](https://github.com/openclaw/openclaw/pull/129331)
- fix(cron): show running status for active paused jobs [#129339](https://github.com/openclaw/openclaw/pull/129339)
- fix(cron): retain stale delivery suppression diagnostics [#129408](https://github.com/openclaw/openclaw/pull/129408)
- fix(cron): reject blank explicit Telegram thread IDs [#129841](https://github.com/openclaw/openclaw/pull/129841)
- fix(cron): successful best-effort retries still report delivery failure [#131419](https://github.com/openclaw/openclaw/pull/131419)
- fix(ui): suppress overdue jobs when scheduler is disabled [#131498](https://github.com/openclaw/openclaw/pull/131498)
- Keep cron announcements focused on the recipient [#90836](https://github.com/openclaw/openclaw/pull/90836)
- Align scheduled-result delivery for current and named sessions [#99115](https://github.com/openclaw/openclaw/pull/99115)

**Documentation**

- Remove retired cron run-log settings from documentation [#106640](https://github.com/openclaw/openclaw/pull/106640)
- Clarify cron channel plugin IDs in help and docs [#124655](https://github.com/openclaw/openclaw/pull/124655)

</details>

</Accordion>

<Accordion title="Automations After a Restart">

[Restart recovery](/gateway/restart-recovery) now distinguishes work that was genuinely missed from work that already finished or no longer belongs to the current automation. Queued and deferred runs, rescheduled one-time reminders, schedule times missed during a restart or clock change, and interrupted one-shot jobs without a terminal result can return under normal catch-up pacing. Attempts with a durable terminal result do not replay, and completed slots, deleted or retired jobs, old schedules, and work from a replaced scheduler stay retired.

Current edits, self-removal, and rescheduling are preserved during startup, concurrent scheduler work no longer overwrites sibling jobs, and damaged older rows remain available for Doctor. Failed or skipped one-shot recovery remains disabled for inspection, while a successful job configured with `deleteAfterRun` is removed normally. Legacy running markers still remain interrupted when they cannot establish whether an outside side effect happened, so exactly-once execution in external systems remains outside the scheduler's recovery boundary.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- feat(cron): recover interrupted one-shot jobs on restart [#131473](https://github.com/openclaw/openclaw/pull/131473)
- Explain stale in-flight cron jobs in doctor [#98620](https://github.com/openclaw/openclaw/pull/98620)

**Bug fixes**

- Preserve queued cron jobs across Gateway restarts [#110159](https://github.com/openclaw/openclaw/pull/110159)
- Preserve cron job changes during startup catch-up [#110977](https://github.com/openclaw/openclaw/pull/110977)
- Preserve cron script state and suppress stale restart effects [#111292](https://github.com/openclaw/openclaw/pull/111292)
- Preserve rescheduled reminders after Gateway restart [#114677](https://github.com/openclaw/openclaw/pull/114677)
- Prevent cron and Workboard lifecycle races [#114744](https://github.com/openclaw/openclaw/pull/114744)
- Preserve scheduler state and truthful delivery outcomes [#116923](https://github.com/openclaw/openclaw/pull/116923)
- Keep cron jobs and malformed-job recovery atomic in SQLite [#117071](https://github.com/openclaw/openclaw/pull/117071)
- Prevent invalid cron timestamps from stranding jobs [#121394](https://github.com/openclaw/openclaw/pull/121394)
- fix(cron): close restart-recovery identity gaps and stop silent heartbeat alert drops [#131219](https://github.com/openclaw/openclaw/pull/131219)
- Prevent completed cron slots from replaying after restart [#101998](https://github.com/openclaw/openclaw/pull/101998)
- Prevent duplicate cron runs after re-enable [#102255](https://github.com/openclaw/openclaw/pull/102255)
- Publish cron removals only after durable deletion [#104130](https://github.com/openclaw/openclaw/pull/104130)
- Keep cron continuation recovery active during suspend preparation [#104397](https://github.com/openclaw/openclaw/pull/104397)
- Preserve cron fast-mode session state [#105094](https://github.com/openclaw/openclaw/pull/105094)
- Back off cron session cleanup after storage failures [#105386](https://github.com/openclaw/openclaw/pull/105386)
- Prune stale cron-run descendant sessions [#105633](https://github.com/openclaw/openclaw/pull/105633)
- Prevent completed cron work from retrying after claim conflicts [#108778](https://github.com/openclaw/openclaw/pull/108778)
- Preserve deferred cron catch-up runs across restarts [#110351](https://github.com/openclaw/openclaw/pull/110351)
- Preserve browser tabs for persistent cron sessions [#113984](https://github.com/openclaw/openclaw/pull/113984)
- Prevent duplicate and lost scheduled deliveries [#114479](https://github.com/openclaw/openclaw/pull/114479)
- Preserve future one-shot cron jobs during manual runs [#114491](https://github.com/openclaw/openclaw/pull/114491)
- Preserve one-shot schedules edited during active runs [#114569](https://github.com/openclaw/openclaw/pull/114569)
- Protect recreated reminders from stale active runs [#114756](https://github.com/openclaw/openclaw/pull/114756)
- Prevent completed cron jobs from rerunning after restart [#114820](https://github.com/openclaw/openclaw/pull/114820)
- fix(cron): preserve active watched commands across Gateway reload [#115761](https://github.com/openclaw/openclaw/pull/115761)
- Stop edited cron schedules from replaying old slots [#115779](https://github.com/openclaw/openclaw/pull/115779)
- fix: clear stale maintenance tasks after gateway restart [#116344](https://github.com/openclaw/openclaw/pull/116344)
- Replay cron jobs missed during subsecond Gateway restarts [#117797](https://github.com/openclaw/openclaw/pull/117797)
- Keep Cron shutdown tracking scoped to each run [#118393](https://github.com/openclaw/openclaw/pull/118393)
- Remove ghost sessions when cron jobs are deleted [#119520](https://github.com/openclaw/openclaw/pull/119520)
- Preserve cron run history when session retention is zero [#120213](https://github.com/openclaw/openclaw/pull/120213)
- Preserve one-shot cron behavior when replacing a trigger script [#120226](https://github.com/openclaw/openclaw/pull/120226)
- Keep cron running when notifications fail [#120266](https://github.com/openclaw/openclaw/pull/120266)
- fix(cron): avoid no-op writes and unbounded page copies [#120910](https://github.com/openclaw/openclaw/pull/120910)
- Remove cron scratch after durable job deletion [#121024](https://github.com/openclaw/openclaw/pull/121024)
- Keep automations runnable after queued runs are disabled [#123725](https://github.com/openclaw/openclaw/pull/123725)
- Stop cron reaper warning loops for deleted agents [#124566](https://github.com/openclaw/openclaw/pull/124566)
- Complete upgrades with legacy cron jobs [#124809](https://github.com/openclaw/openclaw/pull/124809)
- Clear retired cron trigger state when executables change [#126940](https://github.com/openclaw/openclaw/pull/126940)
- Wait for cron exit watchers before Gateway restart [#126963](https://github.com/openclaw/openclaw/pull/126963)
- fix(cron): prevent stale outcomes after same-millisecond restarts [#127003](https://github.com/openclaw/openclaw/pull/127003)
- fix(cron): Gateway shutdown hangs when the system clock changes [#128374](https://github.com/openclaw/openclaw/pull/128374)
- fix(cron): reset trigger state when once changes [#128495](https://github.com/openclaw/openclaw/pull/128495)
- fix(cron): fence stale execution generations [#128573](https://github.com/openclaw/openclaw/pull/128573)
- fix(cron): prevent retired scheduled jobs from running after Gateway restart [#128678](https://github.com/openclaw/openclaw/pull/128678)
- fix(cron): recover reminders missed across spring-forward gaps [#129478](https://github.com/openclaw/openclaw/pull/129478)
- fix: retain best-effort cron context for follow-up replies [#130551](https://github.com/openclaw/openclaw/pull/130551)
- Delete successful on-exit one-shot cron jobs [#104550](https://github.com/openclaw/openclaw/pull/104550)
- Clean up recurring jobs converted to one-time schedules [#110431](https://github.com/openclaw/openclaw/pull/110431)
- Recover cron jobs after backward clock changes [#111743](https://github.com/openclaw/openclaw/pull/111743)
- Preserve cron schedule edits during active runs [#114919](https://github.com/openclaw/openclaw/pull/114919)
- Remove stopped scheduler automation after failed shutdown [#115316](https://github.com/openclaw/openclaw/pull/115316)
- Release cron session admission after cleanup failures [#126413](https://github.com/openclaw/openclaw/pull/126413)
- fix(doctor): expose disabled in-flight automations [#128664](https://github.com/openclaw/openclaw/pull/128664)

**Documentation**

- Document Doctor's in-flight cron job warning [#99086](https://github.com/openclaw/openclaw/pull/99086)

</details>

</Accordion>

</AccordionGroup>
