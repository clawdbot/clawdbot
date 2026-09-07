---
title: "v2026.8.1: Messaging"
description: "Telegram, Slack, Discord, and the native apps keep more of a conversation intact, and accepted messages survive managed restarts."
---

Messaging now keeps more of a conversation intact across the places people already talk to their Claw. [Telegram](/channels/telegram) gains richer messages and media, [Slack](/channels/slack) keeps live progress and the final answer together, [Discord](/channels/discord) adds opt-in Activities and voice rooms that understand who is present, and the native apps keep media and pending sends inside the conversation where they belong.

Across supported channels, OpenClaw now holds accepted messages through managed restarts, reports whether a connection is usable, recovering, or blocked, and preserves an uncertain send instead of blindly sending it again. Recovery starts once OpenClaw has accepted the message, and each service still controls what it can confirm beyond that point.

<AccordionGroup>

<Accordion title="Message Delivery and Recovery">

On supported channels, [messages OpenClaw has accepted](/concepts/messages) now stay pending through a managed restart, and channel status shows whether a connection is usable, recovering, or blocked. When a send times out without a confirmed result, OpenClaw keeps that outcome uncertain and can warn on the next contact rather than creating a likely duplicate. Recovery begins after local acceptance.

Eligible single-choice questions can use native controls on Telegram, Discord, and Slack, while longer Telegram and Discord turns can show a short status headline with compact tool activity. Multi-select and free-text questions continue through the supported client or text path, and Telegram partial-answer streaming remains a separate opt-in mode.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Move six channel streaming configurations to the nested format [#105709](https://github.com/openclaw/openclaw/pull/105709)
- Add a unified implicit-mention policy for supported channels [#108829](https://github.com/openclaw/openclaw/pull/108829)
- Add structured ask_user questions across chat surfaces [#109922](https://github.com/openclaw/openclaw/pull/109922)
- Complete ask_user across harnesses, channels, and native apps [#110372](https://github.com/openclaw/openclaw/pull/110372)
- Open MCP App views from channel replies [#111211](https://github.com/openclaw/openclaw/pull/111211)
- Keep channel media out of primary message text [#111665](https://github.com/openclaw/openclaw/pull/111665)
- Render model-authored collapsible sections [#114556](https://github.com/openclaw/openclaw/pull/114556)
- Teach models to use collapsible details on supported surfaces [#114706](https://github.com/openclaw/openclaw/pull/114706)
- Manage audio and video attachments across Gateway chat [#115842](https://github.com/openclaw/openclaw/pull/115842)
- Publish authoritative lifecycle status for ten bundled channels [#118110](https://github.com/openclaw/openclaw/pull/118110)
- Report truthful lifecycle status across fifteen more channels [#118298](https://github.com/openclaw/openclaw/pull/118298)
- Route default heartbeat alerts only to the configured owner [#121988](https://github.com/openclaw/openclaw/pull/121988)
- Recover channel connections promptly after host sleep [#122489](https://github.com/openclaw/openclaw/pull/122489)
- Resume local Gateways promptly after Linux host sleep [#122719](https://github.com/openclaw/openclaw/pull/122719)
- Add structured speech controls to message sends [#124913](https://github.com/openclaw/openclaw/pull/124913)
- feat(channels): custom emoji discovery via emoji-list across Discord, Slack, Telegram [#128435](https://github.com/openclaw/openclaw/pull/128435)
- feat(channels): post a grounded introduction when the bot joins a group room [#130103](https://github.com/openclaw/openclaw/pull/130103)
- Move legacy channel streaming keys to doctor-only migration [#104693](https://github.com/openclaw/openclaw/pull/104693)
- Unify Matrix, Feishu, and QQBot streaming configuration [#105808](https://github.com/openclaw/openclaw/pull/105808)
- Open a selected channel's setup immediately [#113197](https://github.com/openclaw/openclaw/pull/113197)
- Require nested channel streaming configuration [#113533](https://github.com/openclaw/openclaw/pull/113533)
- Migrate retired channel config aliases and remove orphaned shadow trials [#114709](https://github.com/openclaw/openclaw/pull/114709)
- Remove activity digests from finished channel replies [#124972](https://github.com/openclaw/openclaw/pull/124972)

**Bug fixes**

- fix(channels): bundled channels reject the documented mediaMaxMb override (#118157) [0bb870a](https://github.com/openclaw/openclaw/commit/0bb870a)
- Release reply lanes when pre-delivery callbacks hang [#104256](https://github.com/openclaw/openclaw/pull/104256)
- Reconcile timed-out message sends without duplicate retries [#104632](https://github.com/openclaw/openclaw/pull/104632)
- Preserve streaming settings through config migration [#105054](https://github.com/openclaw/openclaw/pull/105054)
- Preserve completed replies across post-turn compaction failures [#105156](https://github.com/openclaw/openclaw/pull/105156)
- Keep Codex progress messages from ending active turns [#105365](https://github.com/openclaw/openclaw/pull/105365)
- Show progress drafts only for long tasks with model-written headlines [#106026](https://github.com/openclaw/openclaw/pull/106026)
- Recover message sessions after reply finalization stalls [#106792](https://github.com/openclaw/openclaw/pull/106792)
- Keep post-ack webhook processing admitted [#107734](https://github.com/openclaw/openclaw/pull/107734)
- Preserve completed replies when follow-ups arrive [#107799](https://github.com/openclaw/openclaw/pull/107799)
- Recover channel turns safely after gateway restarts [#108283](https://github.com/openclaw/openclaw/pull/108283)
- Keep queued voice replies alive through retries and restarts [#108502](https://github.com/openclaw/openclaw/pull/108502)
- Restore one cross-channel DM session for fresh installs [#110225](https://github.com/openclaw/openclaw/pull/110225)
- Restore structured ask_user questions in Gateway chats [#110961](https://github.com/openclaw/openclaw/pull/110961)
- Recover failed inbound channel events [#111029](https://github.com/openclaw/openclaw/pull/111029)
- Prevent channel echoes and add native login commands [#111341](https://github.com/openclaw/openclaw/pull/111341)
- Remove media placeholder text from iMessage, Signal, and WhatsApp [#111800](https://github.com/openclaw/openclaw/pull/111800)
- Restore message-channel context after restart [#112548](https://github.com/openclaw/openclaw/pull/112548)
- Reject invalid explicit channel account selections [#113417](https://github.com/openclaw/openclaw/pull/113417)
- Prevent busy gateways from silently dropping queued replies [#114058](https://github.com/openclaw/openclaw/pull/114058)
- Stop socketless channels from restart-looping [#114970](https://github.com/openclaw/openclaw/pull/114970)
- Fail channel startup when durable ingress is unavailable [#114998](https://github.com/openclaw/openclaw/pull/114998)
- Prevent false no-reply fallbacks after handled turns [#115016](https://github.com/openclaw/openclaw/pull/115016)
- Report channels with dead inbound delivery as unhealthy [#115229](https://github.com/openclaw/openclaw/pull/115229)
- Match typed group mentions for decorated agent names [#115278](https://github.com/openclaw/openclaw/pull/115278)
- Release inbound debounce after turn admission [#115603](https://github.com/openclaw/openclaw/pull/115603)
- Run channel reply hooks for restart-recovered replies [#115711](https://github.com/openclaw/openclaw/pull/115711)
- Deliver retried messages after queue teardown [#115891](https://github.com/openclaw/openclaw/pull/115891)
- Preserve Markdown code in plain-text channel replies [#116123](https://github.com/openclaw/openclaw/pull/116123)
- Show tool progress beneath channel status headlines [#116143](https://github.com/openclaw/openclaw/pull/116143)
- Unblock channel turns after Gateway restart recovery [#116728](https://github.com/openclaw/openclaw/pull/116728)
- Send workspace attachments through Matrix and Telegram [#117711](https://github.com/openclaw/openclaw/pull/117711)
- Deliver final replies that quote short interim updates [#118178](https://github.com/openclaw/openclaw/pull/118178)
- Preserve actionable channel failure states and Discord retry behavior [#118251](https://github.com/openclaw/openclaw/pull/118251)
- Restore channel autostart after a Gateway crash-loop window clears [#118311](https://github.com/openclaw/openclaw/pull/118311)
- Standardize channel lifecycle recovery and cleanup [#118795](https://github.com/openclaw/openclaw/pull/118795)
- Let agents send progress before one final message-tool reply [#119605](https://github.com/openclaw/openclaw/pull/119605)
- Route Slack and Discord commentary through one per-turn owner [#121009](https://github.com/openclaw/openclaw/pull/121009)
- Preserve channel plugin reply suppression across delivery paths [#121159](https://github.com/openclaw/openclaw/pull/121159)
- Make ambiguous final delivery loss visible without resending [#121833](https://github.com/openclaw/openclaw/pull/121833)
- Deliver heartbeat alerts to the last conversation by default [#121892](https://github.com/openclaw/openclaw/pull/121892)
- Show failed agent runs as errors across channels [#122009](https://github.com/openclaw/openclaw/pull/122009)
- Make headless channel setup fail fast [#122530](https://github.com/openclaw/openclaw/pull/122530)
- Stop Gateways from auto-starting channels from inherited credentials [#123174](https://github.com/openclaw/openclaw/pull/123174)
- Visible chat replies supersede same-session heartbeats [#123458](https://github.com/openclaw/openclaw/pull/123458)
- Keep failed sends from rebinding the main session [#124459](https://github.com/openclaw/openclaw/pull/124459)
- Preserve replies when channel turns overlap [#124623](https://github.com/openclaw/openclaw/pull/124623)
- Base reply visibility on settled delivery outcomes [#124773](https://github.com/openclaw/openclaw/pull/124773)
- Preserve ambiguous message delivery outcomes [#124825](https://github.com/openclaw/openclaw/pull/124825)
- Report queued replies that fail after a status update [#125325](https://github.com/openclaw/openclaw/pull/125325)
- Preserve accepted channel messages across Gateway restarts [#125919](https://github.com/openclaw/openclaw/pull/125919)
- Prevent large base64 attachments from exhausting Gateway memory [#126017](https://github.com/openclaw/openclaw/pull/126017)
- Recover queued deliveries in explicit multi-agent fleets [#126377](https://github.com/openclaw/openclaw/pull/126377)
- Stop route identifiers from being treated as delivery receipts [#126385](https://github.com/openclaw/openclaw/pull/126385)
- fix(gateway): keep conversation delivery within agent bindings [#126424](https://github.com/openclaw/openclaw/pull/126424)
- Unblock replies after recovery-owner release conflicts [#126507](https://github.com/openclaw/openclaw/pull/126507)
- Prevent Gateway readiness stalls during channel startup [#126555](https://github.com/openclaw/openclaw/pull/126555)
- Keep durable inbound messages admitted after pump release [#126590](https://github.com/openclaw/openclaw/pull/126590)
- fix(channels): retry timed-out ingress messages [#127090](https://github.com/openclaw/openclaw/pull/127090)
- fix(plugins): bind tool delivery to current turn [#127098](https://github.com/openclaw/openclaw/pull/127098)
- fix(channels): keep a queued message alive through a long turn instead of dead-lettering it [#127950](https://github.com/openclaw/openclaw/pull/127950)
- fix(channels): preserve gateway context for inbound turns [#127962](https://github.com/openclaw/openclaw/pull/127962)
- fix(cron): scheduled job results disappear after temporary network failures [#128184](https://github.com/openclaw/openclaw/pull/128184)
- fix(outbound): prevent remote gateway duplicate sends [#128202](https://github.com/openclaw/openclaw/pull/128202)
- fix(media): stop silently skipping attachments with opaque download URLs [#128220](https://github.com/openclaw/openclaw/pull/128220)
- fix(channels): preserve long presentation text [#130368](https://github.com/openclaw/openclaw/pull/130368)
- fix(auto-reply): clarify unaddressed ambient room events [#130901](https://github.com/openclaw/openclaw/pull/130901)
- fix(config): preserve channel account policy inheritance [#131250](https://github.com/openclaw/openclaw/pull/131250)
- fix: resume interrupted delivery settlement without duplicate notices [#131380](https://github.com/openclaw/openclaw/pull/131380)
- Recover undelivered message-tool replies with one guarded retry [#99536](https://github.com/openclaw/openclaw/pull/99536)
- fix(channels): bundled channels reject the documented responsePrefix override (#118148) [1f2e998](https://github.com/openclaw/openclaw/commit/1f2e998)
- fix(channels): accept context visibility settings (#117287) [d8e08e7](https://github.com/openclaw/openclaw/commit/d8e08e7)
- Keep active messages out of queue overflow drops [#103284](https://github.com/openclaw/openclaw/pull/103284)
- Split Unicode paragraph separators into message chunks [#103518](https://github.com/openclaw/openclaw/pull/103518)
- Restore trusted startup for official ClawHub plugins [#103836](https://github.com/openclaw/openclaw/pull/103836)
- Preserve messages when Codex steering cannot confirm adoption [#103916](https://github.com/openclaw/openclaw/pull/103916)
- Preserve attributed formatting in outbound messages [#104118](https://github.com/openclaw/openclaw/pull/104118)
- Make channel nack callbacks idempotent [#104919](https://github.com/openclaw/openclaw/pull/104919)
- Quarantine corrupt channel ingress rows [#105259](https://github.com/openclaw/openclaw/pull/105259)
- Preserve inherited Discord streaming settings during Doctor migration [#105636](https://github.com/openclaw/openclaw/pull/105636)
- Prevent duplicate generated-media delivery on the same route [#105717](https://github.com/openclaw/openclaw/pull/105717)
- Surface empty message-tool-only completions [#105765](https://github.com/openclaw/openclaw/pull/105765)
- Preserve who said what across group chat turns [#107025](https://github.com/openclaw/openclaw/pull/107025)
- Hide model fallback notices in shared conversations [#107209](https://github.com/openclaw/openclaw/pull/107209)
- Reduce unrelated fields in channel message tools [#107474](https://github.com/openclaw/openclaw/pull/107474)
- Preserve queued MEDIA attachments across retries [#108969](https://github.com/openclaw/openclaw/pull/108969)
- Honor rejected inbound conversation claims [#109857](https://github.com/openclaw/openclaw/pull/109857)
- Prevent route-cache collisions from selecting the wrong agent [#110001](https://github.com/openclaw/openclaw/pull/110001)
- Let Channel Setup recover after a timed-out start [#110146](https://github.com/openclaw/openclaw/pull/110146)
- Lock Channel Wizard answers while a step is running [#110163](https://github.com/openclaw/openclaw/pull/110163)
- Scope setup-wizard credentials to the selected account [#110969](https://github.com/openclaw/openclaw/pull/110969)
- Prevent duplicate agent-to-agent replies [#111012](https://github.com/openclaw/openclaw/pull/111012)
- fix(channels): preserve terminal ingress outcomes when stop abort races delivery return [#111347](https://github.com/openclaw/openclaw/pull/111347)
- Replace channel media placeholder bodies with structured facts [#111447](https://github.com/openclaw/openclaw/pull/111447)
- Make configure and channel setup behave consistently [#111720](https://github.com/openclaw/openclaw/pull/111720)
- Route inbound media through ordered attachment facts [#112276](https://github.com/openclaw/openclaw/pull/112276)
- Draft previews keep the newest update after transient send failures [#112370](https://github.com/openclaw/openclaw/pull/112370)
- Preserve unquoted media paths containing spaces [#112464](https://github.com/openclaw/openclaw/pull/112464)
- Make formatted replies readable on plain-text channels [#112926](https://github.com/openclaw/openclaw/pull/112926)
- Improve Markdown rendering on Teams and QQ [#113100](https://github.com/openclaw/openclaw/pull/113100)
- Run outbound hooks on normal routed channel replies [#113448](https://github.com/openclaw/openclaw/pull/113448)
- Route bundled native-command replies through one lifecycle [#113500](https://github.com/openclaw/openclaw/pull/113500)
- Restore opaque plugin conversation bindings [#113588](https://github.com/openclaw/openclaw/pull/113588)
- Preserve MIME types for streamed attachments [#113762](https://github.com/openclaw/openclaw/pull/113762)
- Run channel recovery checks when startup grace ends [#114275](https://github.com/openclaw/openclaw/pull/114275)
- Finish sibling channel teardowns before reporting stop failures [#114280](https://github.com/openclaw/openclaw/pull/114280)
- Prevent duplicate replies after rewritten commands [#114379](https://github.com/openclaw/openclaw/pull/114379)
- Align channel account selection and credential replacement [#114395](https://github.com/openclaw/openclaw/pull/114395)
- Prevent NO_REPLY tokens from leaking into delivered replies [#114500](https://github.com/openclaw/openclaw/pull/114500)
- Show an empty-reply fallback after explicit group mentions [#114531](https://github.com/openclaw/openclaw/pull/114531)
- Stop duplicate replies after delivered primary failures [#114628](https://github.com/openclaw/openclaw/pull/114628)
- Make channel status internally consistent during relink and restart [#114775](https://github.com/openclaw/openclaw/pull/114775)
- Limit no-reply notices to turns directed at the bot [#114799](https://github.com/openclaw/openclaw/pull/114799)
- Let user turns recover past scheduled-only reply hooks [#114836](https://github.com/openclaw/openclaw/pull/114836)
- Trim trailing whitespace from final reply chunks [#114973](https://github.com/openclaw/openclaw/pull/114973)
- Let crash-looping channels reach their give-up state [#114976](https://github.com/openclaw/openclaw/pull/114976)
- Keep delegated messages on the current channel account [#115358](https://github.com/openclaw/openclaw/pull/115358)
- Preserve CLI mid-turn text in durable channel replies [#115455](https://github.com/openclaw/openclaw/pull/115455)
- Recover stranded CJK replies in message-tool-only delivery [#115556](https://github.com/openclaw/openclaw/pull/115556)
- Mark durable webhook acceptance across six channels [#115586](https://github.com/openclaw/openclaw/pull/115586)
- Prevent duplicate CLI commentary delivery [#115596](https://github.com/openclaw/openclaw/pull/115596)
- Keep internal agent sessions out of message destinations [#115657](https://github.com/openclaw/openclaw/pull/115657)
- Honor configured default agents for authenticated auto-replies [#115724](https://github.com/openclaw/openclaw/pull/115724)
- Return delegated replies to the active direct conversation [#115756](https://github.com/openclaw/openclaw/pull/115756)
- Stop unhealthy channels from restarting forever [#116089](https://github.com/openclaw/openclaw/pull/116089)
- Preserve account selection for agent-hook delivery [#116095](https://github.com/openclaw/openclaw/pull/116095)
- Reject invalid hook delivery accounts before runs [#116264](https://github.com/openclaw/openclaw/pull/116264)
- Keep streamed commentary on one progress-draft line [#116272](https://github.com/openclaw/openclaw/pull/116272)
- Acknowledge explicit group mentions when mentions are optional [#116303](https://github.com/openclaw/openclaw/pull/116303)
- Show failed CLI command outcomes in channel progress [#116387](https://github.com/openclaw/openclaw/pull/116387)
- Keep intentional NO_REPLY completions silent across channels [#116548](https://github.com/openclaw/openclaw/pull/116548)
- Preserve outbound policy results across restart recovery [#116632](https://github.com/openclaw/openclaw/pull/116632)
- Preserve delivery behavior across four bundled channels [#116647](https://github.com/openclaw/openclaw/pull/116647)
- Keep recovered channel turns active after stale terminal events [#116777](https://github.com/openclaw/openclaw/pull/116777)
- Preserve Markdown formatting in replies with media attachments [#116786](https://github.com/openclaw/openclaw/pull/116786)
- Keep channel setup usable when one plugin fails [#116824](https://github.com/openclaw/openclaw/pull/116824)
- Preserve supplemental media and presentation details across channels [#116884](https://github.com/openclaw/openclaw/pull/116884)
- Preserve malformed bracket text in final replies [#116979](https://github.com/openclaw/openclaw/pull/116979)
- Preserve unmatched bracket tails in final replies [#116983](https://github.com/openclaw/openclaw/pull/116983)
- Preserve actionable commands in channel fallback menus [#116990](https://github.com/openclaw/openclaw/pull/116990)
- fix(messages): thread-reply deliveries are not marked as current-source replies [#117176](https://github.com/openclaw/openclaw/pull/117176)
- Keep channel progress previews consistent across queued turns [#117269](https://github.com/openclaw/openclaw/pull/117269)
- Show fresh channel probe failures in health output [#117410](https://github.com/openclaw/openclaw/pull/117410)
- Keep heartbeat commitments on the configured sender account [#117521](https://github.com/openclaw/openclaw/pull/117521)
- Preserve explicit empty delivery receipts without inventing IDs [#118126](https://github.com/openclaw/openclaw/pull/118126)
- Preserve authored outbound message whitespace [#118538](https://github.com/openclaw/openclaw/pull/118538)
- Preserve Slack and Mattermost thread participation expiry across restarts [#118630](https://github.com/openclaw/openclaw/pull/118630)
- Let manually restarted channels recover from temporary errors [#118728](https://github.com/openclaw/openclaw/pull/118728)
- Accept heartbeat settings for named external channel accounts [#118828](https://github.com/openclaw/openclaw/pull/118828)
- Accept mixed-case local file URLs on Windows [#121226](https://github.com/openclaw/openclaw/pull/121226)
- Resolve Windows home paths for custom usage footers [#121303](https://github.com/openclaw/openclaw/pull/121303)
- Preserve external thread routing on internal turns [#121321](https://github.com/openclaw/openclaw/pull/121321)
- Keep native plugin command selection bound through execution [#121544](https://github.com/openclaw/openclaw/pull/121544)
- Prevent successful exact sends from replaying after restart [#121587](https://github.com/openclaw/openclaw/pull/121587)
- Report best-effort agent delivery failures [#121824](https://github.com/openclaw/openclaw/pull/121824)
- Show channel warnings when Doctor leaves configuration unchanged [#121956](https://github.com/openclaw/openclaw/pull/121956)
- Surface partial channel-status failures [#122349](https://github.com/openclaw/openclaw/pull/122349)
- Clear false delivery-uncertainty notices after success [#122438](https://github.com/openclaw/openclaw/pull/122438)
- Honor configured terminal reaction hold timing [#122544](https://github.com/openclaw/openclaw/pull/122544)
- Report truthful per-target broadcast delivery outcomes [#122605](https://github.com/openclaw/openclaw/pull/122605)
- Preserve text when tagged TTS synthesis fails [#122608](https://github.com/openclaw/openclaw/pull/122608)
- Refresh Gateway health immediately after account removal [#122620](https://github.com/openclaw/openclaw/pull/122620)
- Keep Slack and Discord system events with their routed agent [#123316](https://github.com/openclaw/openclaw/pull/123316)
- Deliver terminal replies when policy and durable sessions differ [#123422](https://github.com/openclaw/openclaw/pull/123422)
- Keep channel messages working after manual restarts [#123885](https://github.com/openclaw/openclaw/pull/123885)
- Keep managed reply media downloadable and correctly owned [#124048](https://github.com/openclaw/openclaw/pull/124048)
- Stop undelivered ask_user prompts from capturing later replies [#124148](https://github.com/openclaw/openclaw/pull/124148)
- Clean up live thread bindings when channel managers stop [#124221](https://github.com/openclaw/openclaw/pull/124221)
- Preserve email addresses in plain-text replies [#124249](https://github.com/openclaw/openclaw/pull/124249)
- fix(outbound): prevent duplicate sends from proven-not-sent message-tool failures [#124310](https://github.com/openclaw/openclaw/pull/124310)
- Preserve channel setup after a status refresh failure [#124383](https://github.com/openclaw/openclaw/pull/124383)
- Reject invalid targeted channel setup requests [#124584](https://github.com/openclaw/openclaw/pull/124584)
- Surface unavailable channel state checkers [#124600](https://github.com/openclaw/openclaw/pull/124600)
- Run channel setup hooks only after saving configuration [#124736](https://github.com/openclaw/openclaw/pull/124736)
- Keep Signal and iMessage approvals typed across delivery [#124742](https://github.com/openclaw/openclaw/pull/124742)
- Store assistant delivery directives as typed transcript facts [#124793](https://github.com/openclaw/openclaw/pull/124793)
- Route targetless direct-message replies back to the sender [#124837](https://github.com/openclaw/openclaw/pull/124837)
- Bound image fetch headroom to the image size cap [#124838](https://github.com/openclaw/openclaw/pull/124838)
- Remove delivery markers from historical sessions [#124888](https://github.com/openclaw/openclaw/pull/124888)
- Honor explicit agent ownership in channels resolve [#125109](https://github.com/openclaw/openclaw/pull/125109)
- Preserve degraded Discord and Telegram delivery outcomes [#125152](https://github.com/openclaw/openclaw/pull/125152)
- Resume archived channel sessions on authorized new messages [#125163](https://github.com/openclaw/openclaw/pull/125163)
- Preserve correlation for targetless message replies [#125283](https://github.com/openclaw/openclaw/pull/125283)
- Validate every source in structured attachments [#125433](https://github.com/openclaw/openclaw/pull/125433)
- fix(auto-reply): restore channel-authorized /new and /reset on non-owner-enforced channels [#125618](https://github.com/openclaw/openclaw/pull/125618)
- Keep the main agent aware of isolated group conversations [#125667](https://github.com/openclaw/openclaw/pull/125667)
- fix(agents): restore deliveryStatus checks in plugin envelope signals [#125706](https://github.com/openclaw/openclaw/pull/125706)
- Return complete webhook errors and drain Gateway shutdown reliably [#125893](https://github.com/openclaw/openclaw/pull/125893)
- Make broadcast failures visible to scripts and operators [#125915](https://github.com/openclaw/openclaw/pull/125915)
- Enforce sender file-read policy for outbound attachments [#125950](https://github.com/openclaw/openclaw/pull/125950)
- fix(cron): persist outbound route only after successful delivery [#126145](https://github.com/openclaw/openclaw/pull/126145)
- Recover malformed channel ingress claims [#126176](https://github.com/openclaw/openclaw/pull/126176)
- Preserve one-time native replies across durable delivery [#126205](https://github.com/openclaw/openclaw/pull/126205)
- Show failures for queued replies after work starts [#126266](https://github.com/openclaw/openclaw/pull/126266)
- Settle pre-aborted reply delivery immediately [#126582](https://github.com/openclaw/openclaw/pull/126582)
- Stop Nostr and Buzz from reusing buses during shutdown [#126637](https://github.com/openclaw/openclaw/pull/126637)
- Restore message CLI sends for npm-installed channels [#126700](https://github.com/openclaw/openclaw/pull/126700)
- Retry queued deliveries during temporary channel adapter outages [#126800](https://github.com/openclaw/openclaw/pull/126800)
- fix(agents): heartbeat runs no longer block visible turns [#126853](https://github.com/openclaw/openclaw/pull/126853)
- fix(heartbeat): deliver exec completions with disabled cadence [#126895](https://github.com/openclaw/openclaw/pull/126895)
- fix(acp): recover terminal reply and surface run errors on reconnect reconcile [#126909](https://github.com/openclaw/openclaw/pull/126909)
- Preserve delivered channel replies when preview cleanup fails [#126922](https://github.com/openclaw/openclaw/pull/126922)
- Preserve the selected account for CLI-backed cron announcements [#126995](https://github.com/openclaw/openclaw/pull/126995)
- Recover repaired credential-file accounts without restarting siblings [#126999](https://github.com/openclaw/openclaw/pull/126999)
- Show a clear error when follow-up progress never becomes a final reply [#127070](https://github.com/openclaw/openclaw/pull/127070)
- fix(agents): preserve opaque session key casing [#127279](https://github.com/openclaw/openclaw/pull/127279)
- fix: stop retry storms after definitive channel rejections [#127353](https://github.com/openclaw/openclaw/pull/127353)
- fix(outbound): prevent media replay after ambiguous network failure [#127841](https://github.com/openclaw/openclaw/pull/127841)
- fix(channels): hold an ingress lane on its head, not on any retrying row [#127849](https://github.com/openclaw/openclaw/pull/127849)
- fix(gateway): unhealthy channels appear ready after clock rollback [#128222](https://github.com/openclaw/openclaw/pull/128222)
- fix: keep manually stopped idle channel accounts stopped [#128237](https://github.com/openclaw/openclaw/pull/128237)
- fix(outbound): prevent empty chunkers from silently dropping replies [#128288](https://github.com/openclaw/openclaw/pull/128288)
- fix(agents): streamed replies and generated media disappear when delivery fails [#128337](https://github.com/openclaw/openclaw/pull/128337)
- fix(agents): resolve terminal from admitted gateway [#128348](https://github.com/openclaw/openclaw/pull/128348)
- fix(tts): deliver voice-only replies when speech runtime is cold [#128394](https://github.com/openclaw/openclaw/pull/128394)
- fix(agents): close stuck reasoning previews when provider streams end [#128496](https://github.com/openclaw/openclaw/pull/128496)
- fix(plugin-sdk): preserve text after empty chunking [#128499](https://github.com/openclaw/openclaw/pull/128499)
- fix(reply): preserve streamed voice message order [#128558](https://github.com/openclaw/openclaw/pull/128558)
- fix: attachments fail when data URLs contain MIME parameters or wrapped base64 [#128823](https://github.com/openclaw/openclaw/pull/128823)
- fix(reply): rich replies disappear beside silent-response markers [#129082](https://github.com/openclaw/openclaw/pull/129082)
- fix(agents): preserve channel-owned messaging thread identity [#129095](https://github.com/openclaw/openclaw/pull/129095)
- fix(reply): prevent deduplicated follow-ups from losing threaded replies [#129123](https://github.com/openclaw/openclaw/pull/129123)
- fix(channels): attachment filenames disappear from model context [#129140](https://github.com/openclaw/openclaw/pull/129140)
- fix(outbound): preserve location-only replies in conversation history [#129197](https://github.com/openclaw/openclaw/pull/129197)
- fix(cli): unsuccessful message sends report success [#129202](https://github.com/openclaw/openclaw/pull/129202)
- fix(reply): keep attachments and actions when reply text was already sent [#129230](https://github.com/openclaw/openclaw/pull/129230)
- fix(reply): preserve location and video presentation in delivery identity [#129278](https://github.com/openclaw/openclaw/pull/129278)
- fix(agents): keep streamed code blocks within message limits [#129487](https://github.com/openclaw/openclaw/pull/129487)
- fix(channels): honor supported group history limits [#129710](https://github.com/openclaw/openclaw/pull/129710)
- fix(channels): drain large ingress backlogs without binding every pending id [#129717](https://github.com/openclaw/openclaw/pull/129717)
- fix(reply): preserve final answers after reasoning and commentary updates [#129893](https://github.com/openclaw/openclaw/pull/129893)
- fix(delivery): rearm queue timers across clock jumps [#129913](https://github.com/openclaw/openclaw/pull/129913)
- fix(channels): retry abandoned deliveries without penalizing Telegram restarts [#130077](https://github.com/openclaw/openclaw/pull/130077)
- fix(cli): failed message actions report success [#130281](https://github.com/openclaw/openclaw/pull/130281)
- fix: dedupe replies against their resolved delivery thread [#130510](https://github.com/openclaw/openclaw/pull/130510)
- fix: interrupt mode cannot stop active low-level channel replies [#130621](https://github.com/openclaw/openclaw/pull/130621)
- fix: preserve channel answers after unavailable approvals [#130624](https://github.com/openclaw/openclaw/pull/130624)
- fix(reply): resume follow-up work after stuck-session recovery [#130911](https://github.com/openclaw/openclaw/pull/130911)
- fix(auto-reply): preserve channel context in command prompts [#130958](https://github.com/openclaw/openclaw/pull/130958)
- refactor(channels): consolidate account logout cleanup [#130976](https://github.com/openclaw/openclaw/pull/130976)
- fix: deliver slash command replies during active runs [#131023](https://github.com/openclaw/openclaw/pull/131023)
- fix(auto-reply): bound fence reopen headers so chunks respect the limit [#131086](https://github.com/openclaw/openclaw/pull/131086)
- fix(media): an attached file's name never reaches the model context [#131216](https://github.com/openclaw/openclaw/pull/131216)
- fix(delivery): preserve retry budget when producer claims expire [#131614](https://github.com/openclaw/openclaw/pull/131614)
- fix(message): hydrate remote-only sandbox attachments via fs bridge [#131616](https://github.com/openclaw/openclaw/pull/131616)
- fix(channels): preserve ingress retry facts after shutdown [#131962](https://github.com/openclaw/openclaw/pull/131962)
- fix(codex): keep tool lifecycle out of channel progress [#132321](https://github.com/openclaw/openclaw/pull/132321)
- fix(codex): restore configured channel tool progress [#132664](https://github.com/openclaw/openclaw/pull/132664)
- fix(outbound): skip markers for empty HTML formatting elements [#133103](https://github.com/openclaw/openclaw/pull/133103)
- fix(media): decode file URLs at the native reply boundary [#133146](https://github.com/openclaw/openclaw/pull/133146)
- fix(outbound): deliver media through sendFormattedMedia-only adapters [#133168](https://github.com/openclaw/openclaw/pull/133168)
- fix: keep punctuation and bold formatting around leaked model tokens [#133287](https://github.com/openclaw/openclaw/pull/133287)
- Resolve response-prefix templates in abort replies [#45315](https://github.com/openclaw/openclaw/pull/45315)
- Align CJK and emoji Markdown tables by display width [#55596](https://github.com/openclaw/openclaw/pull/55596)
- Match derived agent names with Unicode-aware boundaries [#89864](https://github.com/openclaw/openclaw/pull/89864)
- Restart the gateway when channel login finds an unloaded plugin [#90779](https://github.com/openclaw/openclaw/pull/90779)
- Honor explicit Telegram and Discord preview streaming [#97671](https://github.com/openclaw/openclaw/pull/97671)
- fix: preserve restart delivery claims across queued cleanup [8b3f7e7](https://github.com/openclaw/openclaw/commit/8b3f7e7)
- Delay narrated progress drafts and remove the implicit title [#105607](https://github.com/openclaw/openclaw/pull/105607)
- Warn external plugins about legacy scalar streaming settings [#106796](https://github.com/openclaw/openclaw/pull/106796)
- Report failed legacy channel sends as failures [#109906](https://github.com/openclaw/openclaw/pull/109906)
- Keep configured channels authoritative in plugin send results [#110069](https://github.com/openclaw/openclaw/pull/110069)
- Preserve channel setup success when audit logging fails [#111504](https://github.com/openclaw/openclaw/pull/111504)
- Ignore blank optional locations on message sends [#112013](https://github.com/openclaw/openclaw/pull/112013)
- Keep replies working after config reloads [#112467](https://github.com/openclaw/openclaw/pull/112467)
- Recover queued outbound messages on the correct retry schedule [#113700](https://github.com/openclaw/openclaw/pull/113700)
- Honor channel opt-outs for explicit reply tags [#114268](https://github.com/openclaw/openclaw/pull/114268)
- Keep channel status ordering stable during parallel probes [#114362](https://github.com/openclaw/openclaw/pull/114362)
- Clean up Slack and Feishu after ingress startup failures [#115295](https://github.com/openclaw/openclaw/pull/115295)
- Keep message-tool-only heartbeat replies private [#115629](https://github.com/openclaw/openclaw/pull/115629)
- Deliver agent completion announcements to direct-message sessions [#115811](https://github.com/openclaw/openclaw/pull/115811)
- Preserve TTS answers when audio generation fails [#118690](https://github.com/openclaw/openclaw/pull/118690)
- Correct stale-plugin IDs in Doctor repair reports [#119202](https://github.com/openclaw/openclaw/pull/119202)
- Remove the inactive progress-render setting [#122927](https://github.com/openclaw/openclaw/pull/122927)
- Settle failed ingress claims for legacy channel lifecycles [#124016](https://github.com/openclaw/openclaw/pull/124016)
- Avoid empty follow-up queues on message redelivery [#124723](https://github.com/openclaw/openclaw/pull/124723)
- Expose outbound queue and batch preparation failures [#124756](https://github.com/openclaw/openclaw/pull/124756)
- Reject corrupt approval-reaction targets consistently [#124942](https://github.com/openclaw/openclaw/pull/124942)
- Coalesce overlapping channel typing starts [#127006](https://github.com/openclaw/openclaw/pull/127006)
- Clean up failed media staging artifacts [#127092](https://github.com/openclaw/openclaw/pull/127092)
- fix(gateway): clear stale credential warnings after channel plugin removal [#127503](https://github.com/openclaw/openclaw/pull/127503)
- fix(cron): restore automation failure alerts after clock rollback [#127731](https://github.com/openclaw/openclaw/pull/127731)
- fix(agents): preserve image attachment ownership in queued follow-ups [#128272](https://github.com/openclaw/openclaw/pull/128272)
- fix(outbound): blank media lists silently drop valid channel attachments [#128372](https://github.com/openclaw/openclaw/pull/128372)
- fix(gateway): removed channel plugins remain falsely healthy after reload [#128503](https://github.com/openclaw/openclaw/pull/128503)
- fix(reply): preserve distinct streamed location messages [#128846](https://github.com/openclaw/openclaw/pull/128846)
- fix(media): preserve correct filenames for transparent image attachments [#128902](https://github.com/openclaw/openclaw/pull/128902)
- fix(cron): preserve webhook delivery when the system clock jumps [#129050](https://github.com/openclaw/openclaw/pull/129050)
- fix(reply): preserve every mixed explicit and parsed attachment [#129159](https://github.com/openclaw/openclaw/pull/129159)
- fix(channels): keep title-only cards visible and media counts accurate [#129193](https://github.com/openclaw/openclaw/pull/129193)
- fix(reply): hide malformed reply directives from messages [#129367](https://github.com/openclaw/openclaw/pull/129367)
- fix(channels): honor supported account reply-threading policies [#129679](https://github.com/openclaw/openclaw/pull/129679)
- fix: preserve data URL attachment filename extensions [#130625](https://github.com/openclaw/openclaw/pull/130625)
- fix: preserve explicit MIME types on attachment actions [#130714](https://github.com/openclaw/openclaw/pull/130714)
- Allow zero to disable group chat history [#65359](https://github.com/openclaw/openclaw/pull/65359)

**Documentation**

- Document channel ingress and mention guarantees [#111069](https://github.com/openclaw/openclaw/pull/111069)
- Repair channel discovery and prevent documentation drift [#118106](https://github.com/openclaw/openclaw/pull/118106)
- docs(channels): scope implicitMentions overrides to the channels that read them (#119320) [834fc44](https://github.com/openclaw/openclaw/commit/834fc44)
- Repair Discord, Slack, and Google Chat configuration examples [#106188](https://github.com/openclaw/openclaw/pull/106188)
- Document durable-ingress replay guard layering [#109799](https://github.com/openclaw/openclaw/pull/109799)
- Correct heartbeat visibility configuration examples [#118827](https://github.com/openclaw/openclaw/pull/118827)
- Finish progress work-counter cleanup [#125011](https://github.com/openclaw/openclaw/pull/125011)

</details>

</Accordion>

<Accordion title="Telegram">

On rich-enabled [Telegram](/channels/telegram) accounts, agents can send native details, tables, checklists, math, maps, file references, locations, venues, and a compatible round video note. Large nested replies paginate within Telegram's limits, and rejected rich structures fall back to the complete plain-text answer instead of dropping the useful part.

Busy conversations hold together better too. Follow-ups stay ordered during active work, accepted updates can resume after a restart, abandoned delivery claims stop freezing the chat, and verified public poll activity returns to the chat or forum topic where it began. Anonymous polls remain display-only, and quoted text reaches the agent as attributed quotation rather than active instructions.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Send Telegram locations, venues, and round video notes [#105142](https://github.com/openclaw/openclaw/pull/105142)
- Emit native Telegram Bot API rich-message blocks [#107986](https://github.com/openclaw/openclaw/pull/107986)
- Make Telegram message handling durable across active turns and restarts [#108924](https://github.com/openclaw/openclaw/pull/108924)
- Mark durable Telegram webhook acceptance [#104407](https://github.com/openclaw/openclaw/pull/104407)
- Render Markdown lists natively in Telegram rich messages [#113158](https://github.com/openclaw/openclaw/pull/113158)
- Surface Telegram draft-stream failures in default logs [#111065](https://github.com/openclaw/openclaw/pull/111065)

**Bug fixes**

- Prevent duplicate Telegram replies in conversation context [#102469](https://github.com/openclaw/openclaw/pull/102469)
- Keep Telegram model selections through hot reloads and fallbacks [#103510](https://github.com/openclaw/openclaw/pull/103510)
- Prevent Telegram messages from being lost after restarts [#107288](https://github.com/openclaw/openclaw/pull/107288)
- Deliver Telegram rich-format guidance to every runtime [#108264](https://github.com/openclaw/openclaw/pull/108264)
- Clean up Telegram media captions and preserve retryable updates [#111855](https://github.com/openclaw/openclaw/pull/111855)
- Deliver Telegram replies when models add a location [#113347](https://github.com/openclaw/openclaw/pull/113347)
- Paginate Telegram rich messages by recursive transport limits [#117020](https://github.com/openclaw/openclaw/pull/117020)
- Preserve quoted-message attribution in Telegram agent input [#117021](https://github.com/openclaw/openclaw/pull/117021)
- Keep concurrent Telegram updates in the correct session [#117861](https://github.com/openclaw/openclaw/pull/117861)
- Prevent stalled Telegram responses from blocking groups [#118144](https://github.com/openclaw/openclaw/pull/118144)
- Recover directed Telegram turns after empty model replies [#118305](https://github.com/openclaw/openclaw/pull/118305)
- Keep configured Telegram commands visible under menu limits [#119717](https://github.com/openclaw/openclaw/pull/119717)
- Keep Telegram reactions and poll answers in their original topics [#121231](https://github.com/openclaw/openclaw/pull/121231)
- Keep Telegram dependencies in production Docker images [#125580](https://github.com/openclaw/openclaw/pull/125580)
- fix(telegram): make ask_user controls native and reliable [#130262](https://github.com/openclaw/openclaw/pull/130262)
- Route Telegram public poll votes to the originating agent session [#95830](https://github.com/openclaw/openclaw/pull/95830)
- Continue Telegram webhook cleanup after shutdown failures [#100998](https://github.com/openclaw/openclaw/pull/100998)
- Label the bot's own Telegram recap messages as self [#102507](https://github.com/openclaw/openclaw/pull/102507)
- Recover stalled Telegram media downloads without blocking later messages [#103020](https://github.com/openclaw/openclaw/pull/103020)
- Preserve active Telegram turns when new messages arrive [#103664](https://github.com/openclaw/openclaw/pull/103664)
- Harden durable Telegram replay adoption [#103695](https://github.com/openclaw/openclaw/pull/103695)
- Protect adopted Telegram turns from transport supersession [#103952](https://github.com/openclaw/openclaw/pull/103952)
- Keep newer Telegram requests ahead of stale turns [#103965](https://github.com/openclaw/openclaw/pull/103965)
- Prevent empty Telegram sends for scheduled summaries [#104111](https://github.com/openclaw/openclaw/pull/104111)
- Bound Telegram username lookup timeouts [#104289](https://github.com/openclaw/openclaw/pull/104289)
- Prevent unlisted Telegram API calls from stalling delivery [#104526](https://github.com/openclaw/openclaw/pull/104526)
- Keep streamed Telegram pages on word boundaries [#104608](https://github.com/openclaw/openclaw/pull/104608)
- Preserve authored file-style links in Telegram [#105911](https://github.com/openclaw/openclaw/pull/105911)
- Bound stalled Telegram diagnostic response reads [#106035](https://github.com/openclaw/openclaw/pull/106035)
- Report degraded Telegram inline controls [#107105](https://github.com/openclaw/openclaw/pull/107105)
- Stop Doctor repeating expired Telegram cache warnings [#108259](https://github.com/openclaw/openclaw/pull/108259)
- Keep Telegram tool progress visible beneath preambles [#108394](https://github.com/openclaw/openclaw/pull/108394)
- Preserve Telegram word boundaries in proactive sends [#108801](https://github.com/openclaw/openclaw/pull/108801)
- Preserve Telegram forward origins in debounced batches [#108985](https://github.com/openclaw/openclaw/pull/108985)
- Retry Telegram update-offset persistence safely [#110068](https://github.com/openclaw/openclaw/pull/110068)
- Recover mixed-case Telegram allowlists during upgrade [#110415](https://github.com/openclaw/openclaw/pull/110415)
- Prevent Telegram empty-poll CPU spinning [#111063](https://github.com/openclaw/openclaw/pull/111063)
- Fall back to links for Telegram Web Apps outside DMs [#111116](https://github.com/openclaw/openclaw/pull/111116)
- Keep Telegram message mutations in forum topics [#112794](https://github.com/openclaw/openclaw/pull/112794)
- Canonicalize Telegram General-topic conversations [#113063](https://github.com/openclaw/openclaw/pull/113063)
- Spool isolated Telegram updates before advancing their offset [#113368](https://github.com/openclaw/openclaw/pull/113368)
- Prevent Telegram dedupe collisions across bot identities [#113667](https://github.com/openclaw/openclaw/pull/113667)
- Honor disabled link previews on streamed Telegram replies [#114125](https://github.com/openclaw/openclaw/pull/114125)
- fix(telegram): keep long model names selectable [#114472](https://github.com/openclaw/openclaw/pull/114472)
- Restore progress for queued Telegram replies [#114590](https://github.com/openclaw/openclaw/pull/114590)
- Preserve unmentioned Telegram group text in canonical mention handling [#114591](https://github.com/openclaw/openclaw/pull/114591)
- Prevent unmodified Telegram replies from flashing before outbound hooks [#114822](https://github.com/openclaw/openclaw/pull/114822)
- Keep Telegram photo albums together in one agent turn [#115401](https://github.com/openclaw/openclaw/pull/115401)
- Keep Telegram DM replies working after gateway restarts [#115434](https://github.com/openclaw/openclaw/pull/115434)
- Prevent false Telegram empty-response fallbacks [#115588](https://github.com/openclaw/openclaw/pull/115588)
- Keep Telegram retry checks from dropping messages [#115613](https://github.com/openclaw/openclaw/pull/115613)
- Stop retrying Telegram updates for unreachable recipients [#115640](https://github.com/openclaw/openclaw/pull/115640)
- Keep Telegram reactions in their originating forum topic [#116380](https://github.com/openclaw/openclaw/pull/116380)
- Preserve Telegram callback action ownership [#116383](https://github.com/openclaw/openclaw/pull/116383)
- Keep Telegram typing active through long and steered tasks [#116721](https://github.com/openclaw/openclaw/pull/116721)
- Validate native settings commands and preserve Telegram outcomes [#116773](https://github.com/openclaw/openclaw/pull/116773)
- Preserve Telegram edit previews and conversation context [#116818](https://github.com/openclaw/openclaw/pull/116818)
- Preserve Telegram album captions, retries, and topic routing [#116827](https://github.com/openclaw/openclaw/pull/116827)
- Recover rejected Telegram photos and preserve media filenames [#116886](https://github.com/openclaw/openclaw/pull/116886)
- Keep valid formatted captions attached to Telegram media [#116892](https://github.com/openclaw/openclaw/pull/116892)
- Preserve Telegram polls and inbound formatting [#116898](https://github.com/openclaw/openclaw/pull/116898)
- Confirm Telegram polling before long polling [#116970](https://github.com/openclaw/openclaw/pull/116970)
- Let managed Telegram gateways exit promptly [#116978](https://github.com/openclaw/openclaw/pull/116978)
- Allow Telegram media captions to be cleared [#116984](https://github.com/openclaw/openclaw/pull/116984)
- Honor Telegram DM history limits end to end [#116985](https://github.com/openclaw/openclaw/pull/116985)
- Fix Telegram mutations for topic-qualified targets [#117001](https://github.com/openclaw/openclaw/pull/117001)
- Fall back to text when Telegram blocks voice messages [#117022](https://github.com/openclaw/openclaw/pull/117022)
- Keep Telegram thread-bound replies responsive as saved conversations grow [#117081](https://github.com/openclaw/openclaw/pull/117081)
- Honor Telegram group media ingest before download skips [#117537](https://github.com/openclaw/openclaw/pull/117537)
- Preserve Telegram partial replies when a run fails [#117603](https://github.com/openclaw/openclaw/pull/117603)
- Stop retrying permanent Telegram media lookup failures [#117798](https://github.com/openclaw/openclaw/pull/117798)
- Prevent duplicate Telegram inbound-delivery settlement [#117812](https://github.com/openclaw/openclaw/pull/117812)
- Preserve Telegram media in multipart delivery receipts [#117863](https://github.com/openclaw/openclaw/pull/117863)
- fix(telegram): keep Unicode table columns aligned [#117890](https://github.com/openclaw/openclaw/pull/117890)
- Preserve canonical Telegram question choices across button layouts [#118049](https://github.com/openclaw/openclaw/pull/118049)
- Reject retired Telegram button input with recovery guidance [#118112](https://github.com/openclaw/openclaw/pull/118112)
- Preserve Telegram pre-tool commentary [#118287](https://github.com/openclaw/openclaw/pull/118287)
- Prevent Telegram durable-ingress replay loops [#118357](https://github.com/openclaw/openclaw/pull/118357)
- Show the effective Telegram channel model in status [#118548](https://github.com/openclaw/openclaw/pull/118548)
- Preserve the rest of long Telegram replies after a rejected chunk [#119080](https://github.com/openclaw/openclaw/pull/119080)
- Reject Telegram webhook and health-route collisions [#119268](https://github.com/openclaw/openclaw/pull/119268)
- Show a fallback when Telegram slash-command finals fail [#119530](https://github.com/openclaw/openclaw/pull/119530)
- Restore per-account Telegram reply modes [#120527](https://github.com/openclaw/openclaw/pull/120527)
- Preserve visible Telegram draft recovery after provider failure [#120626](https://github.com/openclaw/openclaw/pull/120626)
- Reuse saved Telegram photos in quoted replies [#120647](https://github.com/openclaw/openclaw/pull/120647)
- Keep Telegram chats responsive after media timeouts [#120706](https://github.com/openclaw/openclaw/pull/120706)
- Keep Telegram message routing fast as session history grows [#120774](https://github.com/openclaw/openclaw/pull/120774)
- Honor Telegram polling cooldowns in the watchdog [#120841](https://github.com/openclaw/openclaw/pull/120841)
- Apply root Telegram group rules across accounts [#120880](https://github.com/openclaw/openclaw/pull/120880)
- Clear removed Telegram command-menu locales [#120885](https://github.com/openclaw/openclaw/pull/120885)
- Keep Telegram channel DM replies in their topic [#120916](https://github.com/openclaw/openclaw/pull/120916)
- Restore Telegram Doctor repairs on source-run hosts [#120954](https://github.com/openclaw/openclaw/pull/120954)
- Keep Telegram tool progress transient when drafts are unavailable [#121048](https://github.com/openclaw/openclaw/pull/121048)
- Validate Telegram command-menu language codes and repair locale state [#121098](https://github.com/openclaw/openclaw/pull/121098)
- Preserve Telegram channel-DM topic identity [#121117](https://github.com/openclaw/openclaw/pull/121117)
- Keep Telegram command menus in a stable canonical order [#121239](https://github.com/openclaw/openclaw/pull/121239)
- Keep disabled Telegram progress hidden in verbose mode [#121395](https://github.com/openclaw/openclaw/pull/121395)
- Ignore Telegram commands in disabled forum topics [#121411](https://github.com/openclaw/openclaw/pull/121411)
- Preserve finalized Telegram previews when late media delivery fails [#121903](https://github.com/openclaw/openclaw/pull/121903)
- Preserve Telegram reply context across batched messages [#121907](https://github.com/openclaw/openclaw/pull/121907)
- Keep Telegram draft and final-message fallback behavior aligned [#121990](https://github.com/openclaw/openclaw/pull/121990)
- Prevent spurious Telegram fallbacks after suppressed approvals [#122091](https://github.com/openclaw/openclaw/pull/122091)
- Expose Telegram live-location updates to plugin hooks [#122185](https://github.com/openclaw/openclaw/pull/122185)
- Safely retry Telegram sends proven not to have started [#122741](https://github.com/openclaw/openclaw/pull/122741)
- fix(telegram): requeue aborted ingress claims [#122864](https://github.com/openclaw/openclaw/pull/122864)
- Prevent false Telegram migration blockers on multi-agent startup [#122877](https://github.com/openclaw/openclaw/pull/122877)
- Start Telegram correctly with explicit multi-agent account bindings [#123029](https://github.com/openclaw/openclaw/pull/123029)
- fix(channels/turn): clear pending history on error paths [#123193](https://github.com/openclaw/openclaw/pull/123193)
- Preserve Telegram bare-URL query separators [#123230](https://github.com/openclaw/openclaw/pull/123230)
- Retry abandoned Telegram messages instead of dropping them [#123528](https://github.com/openclaw/openclaw/pull/123528)
- Keep canceled Telegram requests out of transport health [#124588](https://github.com/openclaw/openclaw/pull/124588)
- Keep Telegram targeted commands on the correct routing lane [#125195](https://github.com/openclaw/openclaw/pull/125195)
- Keep Telegram replies in the correct direct-message topic [#126207](https://github.com/openclaw/openclaw/pull/126207)
- Finalize streamed Telegram questions without duplicate fallbacks [#126248](https://github.com/openclaw/openclaw/pull/126248)
- Keep ambient Telegram room events silent [#126527](https://github.com/openclaw/openclaw/pull/126527)
- Prevent duplicate replies after terminal question delivery failures [#126603](https://github.com/openclaw/openclaw/pull/126603)
- Prevent duplicate Telegram replies after final tool sends [#126625](https://github.com/openclaw/openclaw/pull/126625)
- fix(telegram): resolve General topic session-init retry loop via forum-flag cache [#126656](https://github.com/openclaw/openclaw/pull/126656)
- Make common Telegram emoji reactions reliable [#126739](https://github.com/openclaw/openclaw/pull/126739)
- Keep Telegram direct-topic self-history isolated [#127050](https://github.com/openclaw/openclaw/pull/127050)
- fix(telegram): prevent duplicate replies after attachment delivery failures [#128181](https://github.com/openclaw/openclaw/pull/128181)
- fix(telegram): preserve inbound link destinations and labels [#128297](https://github.com/openclaw/openclaw/pull/128297)
- fix(telegram): show answered status on media-caption questions [#128526](https://github.com/openclaw/openclaw/pull/128526)
- fix(cron): deliver failure alerts outside failed message threads [#128610](https://github.com/openclaw/openclaw/pull/128610)
- fix(telegram): preserve delivered rich fallback reply chunks [#128622](https://github.com/openclaw/openclaw/pull/128622)
- fix(cron): script notifications reach the wrong agent or topic [#128856](https://github.com/openclaw/openclaw/pull/128856)
- fix(reply): preserve explicit routing through block coalescing [#129271](https://github.com/openclaw/openclaw/pull/129271)
- fix(telegram): preserve rich message chunk limits [#129292](https://github.com/openclaw/openclaw/pull/129292)
- fix(telegram): show errors when message-only agent runs fail [#129311](https://github.com/openclaw/openclaw/pull/129311)
- fix(telegram): scheduled reactions target the wrong message [#129932](https://github.com/openclaw/openclaw/pull/129932)
- fix(telegram): prevent truncation when editing rich messages [#130526](https://github.com/openclaw/openclaw/pull/130526)
- fix(telegram): prevent duplicate sends after delivery observer failures [#130643](https://github.com/openclaw/openclaw/pull/130643)
- fix(telegram): surface media failures in the agent-facing body [#130849](https://github.com/openclaw/openclaw/pull/130849)
- fix(telegram): keep Markdown lists inside details blocks [#131078](https://github.com/openclaw/openclaw/pull/131078)
- fix(bug): telegram session remains running ~15 minutes after successful terminal delivery on beta.3 [#132309](https://github.com/openclaw/openclaw/pull/132309)
- fix: preserve visible partial replies when provider turn fails [#132538](https://github.com/openclaw/openclaw/pull/132538)
- fix(telegram): preserve durable receipt in sendMessage action result [#133083](https://github.com/openclaw/openclaw/pull/133083)
- fix(telegram): follow configured model runtime [#133125](https://github.com/openclaw/openclaw/pull/133125)
- fix(markdown): preserve overlapping formatting in channel replies [#133161](https://github.com/openclaw/openclaw/pull/133161)
- Send Telegram final-mode TTS as one captioned voice note [#83988](https://github.com/openclaw/openclaw/pull/83988)
- Prevent false Telegram polling stalls after clock changes [#86541](https://github.com/openclaw/openclaw/pull/86541)
- Preserve Telegram delivery when rendered-empty text is rejected [#88810](https://github.com/openclaw/openclaw/pull/88810)
- Record automatic Telegram replies in the sent-message ledger [#92420](https://github.com/openclaw/openclaw/pull/92420)
- Verify Telegram messages land in the requested topic [#97361](https://github.com/openclaw/openclaw/pull/97361)
- Clean up split Telegram reasoning previews [#97828](https://github.com/openclaw/openclaw/pull/97828)
- fix(telegram): honor human delay for streamed replies (#69022) [15826de](https://github.com/openclaw/openclaw/commit/15826de)
- Keep Telegram DM topic labels valid at emoji boundaries [#101781](https://github.com/openclaw/openclaw/pull/101781)
- Release stale Telegram connections after cache eviction [#101783](https://github.com/openclaw/openclaw/pull/101783)
- Keep Telegram raw-update logs valid at emoji boundaries [#102567](https://github.com/openclaw/openclaw/pull/102567)
- Preserve Telegram delivery when HTML formatting overhead fills a chunk [#102999](https://github.com/openclaw/openclaw/pull/102999)
- Keep emoji intact in long Telegram model labels [#104037](https://github.com/openclaw/openclaw/pull/104037)
- Allow Telegram polls with up to 12 options [#104303](https://github.com/openclaw/openclaw/pull/104303)
- fix(telegram): break long HTML chunks on word boundaries, not mid-word [#104473](https://github.com/openclaw/openclaw/pull/104473)
- Keep Telegram approval buttons within the callback limit [#104942](https://github.com/openclaw/openclaw/pull/104942)
- Prevent Telegram legacy migration no-op loops [#108744](https://github.com/openclaw/openclaw/pull/108744)
- Release stalled Telegram lookup connections [#109007](https://github.com/openclaw/openclaw/pull/109007)
- Stop Telegram startup probes promptly when cancelled [#109604](https://github.com/openclaw/openclaw/pull/109604)
- fix(telegram): bound invalid allowFrom warn dedupe with the shared dedupe cache [#109646](https://github.com/openclaw/openclaw/pull/109646)
- Make capacity-limited Telegram state migration progress safely [#109679](https://github.com/openclaw/openclaw/pull/109679)
- Reject malformed Telegram table spans [#109962](https://github.com/openclaw/openclaw/pull/109962)
- Preserve Telegram Web App buttons in direct-chat actions [#111416](https://github.com/openclaw/openclaw/pull/111416)
- Accept valid emoji in Telegram forum topic names [#111443](https://github.com/openclaw/openclaw/pull/111443)
- Unify media kinds and fix Telegram reply image labels [#112063](https://github.com/openclaw/openclaw/pull/112063)
- Correct Telegram 401 recovery guidance [#112492](https://github.com/openclaw/openclaw/pull/112492)
- Render authored Telegram date and time tags correctly [#112911](https://github.com/openclaw/openclaw/pull/112911)
- Report finalized Telegram preview sends to plugins [#116214](https://github.com/openclaw/openclaw/pull/116214)
- Deduplicate Claude CLI tool progress in Telegram [#116350](https://github.com/openclaw/openclaw/pull/116350)
- Keep queued Telegram tool progress in one message [#116685](https://github.com/openclaw/openclaw/pull/116685)
- Explain invalid Telegram queue arguments instead of reporting a model failure [#116726](https://github.com/openclaw/openclaw/pull/116726)
- Correlate Telegram deliveries with the explicitly selected topic [#117229](https://github.com/openclaw/openclaw/pull/117229)
- Hide disabled Telegram send actions from discovery [#117241](https://github.com/openclaw/openclaw/pull/117241)
- Ignore Telegram commands addressed to other bots [#118024](https://github.com/openclaw/openclaw/pull/118024)
- Preserve Markdown tables in Telegram native-command replies [#118257](https://github.com/openclaw/openclaw/pull/118257)
- Classify Telegram media-size failures correctly [#120757](https://github.com/openclaw/openclaw/pull/120757)
- Clean up Telegram webhook resources after any startup failure [#120788](https://github.com/openclaw/openclaw/pull/120788)
- Acquire the Telegram polling queue before starting its worker [#120800](https://github.com/openclaw/openclaw/pull/120800)
- Prevent duplicate Telegram attachments in streamed replies [#121141](https://github.com/openclaw/openclaw/pull/121141)
- Preserve structured Telegram controls in outbound delivery [#121428](https://github.com/openclaw/openclaw/pull/121428)
- Preserve Telegram Direct Messages topics during writeback [#127010](https://github.com/openclaw/openclaw/pull/127010)
- fix(telegram): preserve exact inline callback action values [#127735](https://github.com/openclaw/openclaw/pull/127735)
- fix(telegram): route commentary through one frozen progress owner [#128259](https://github.com/openclaw/openclaw/pull/128259)
- fix(telegram): delete business callback messages through their owning account [#128358](https://github.com/openclaw/openclaw/pull/128358)
- fix(telegram): describe reaction emoji syntax [#129080](https://github.com/openclaw/openclaw/pull/129080)
- fix(telegram): deduplicate state migration targets [#129096](https://github.com/openclaw/openclaw/pull/129096)
- fix(telegram): preserve exact whitespace in selected reply quotes [#129254](https://github.com/openclaw/openclaw/pull/129254)
- fix(telegram): preserve sent replies when required pins fail [#129342](https://github.com/openclaw/openclaw/pull/129342)
- fix(telegram): allow polls lasting up to seven days [#129461](https://github.com/openclaw/openclaw/pull/129461)
- fix(cli): honor prefixed channel targets when creating threads [#129671](https://github.com/openclaw/openclaw/pull/129671)
- fix(telegram): show buttonless ask-user prompts [#130200](https://github.com/openclaw/openclaw/pull/130200)
- fix(telegram): history claims rejected voice attachments were delivered [#130399](https://github.com/openclaw/openclaw/pull/130399)
- fix(telegram): preserve literal backticks in inbound code [#130800](https://github.com/openclaw/openclaw/pull/130800)
- fix(telegram): preserve forum admission identity in audit [#131293](https://github.com/openclaw/openclaw/pull/131293)
- Clear Telegram generic callback buttons after use [#90169](https://github.com/openclaw/openclaw/pull/90169)
- fix(telegram): accept threadName for forum topic actions [#99505](https://github.com/openclaw/openclaw/pull/99505)

</details>

</Accordion>

<Accordion title="Discord">

[Discord](/channels/discord) now supports opt-in [Activities](/channels/discord-activities) that open configured OpenClaw widgets directly inside Discord. Voice agents can also see who is in the room, use different wake-name rules for one-on-one and group conversations, and optionally join only while a human is present. Activities require explicit channel configuration, a Discord client secret, and a public HTTPS route; occupied-room auto-join is a separate option and does not change the existing always-on default.

Message retries now reuse their identity to reduce duplicates, interaction replies settle in order, stale reply context is discarded, and repeated resume failures can recover without restarting all of OpenClaw. Forum-thread sends still remain uncertain when retrying them could produce a duplicate.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Narrate progress drafts and attach Discord activity receipts [#103463](https://github.com/openclaw/openclaw/pull/103463)
- Keep Discord voice agents aware of channel participants [#107004](https://github.com/openclaw/openclaw/pull/107004)
- Add opt-in Discord Activity widgets [#107442](https://github.com/openclaw/openclaw/pull/107442)
- Route Discord online arrivals to an agent [#107451](https://github.com/openclaw/openclaw/pull/107451)
- Adapt Discord voice wake names to room size [#108696](https://github.com/openclaw/openclaw/pull/108696)
- Support Discord bots without Message Content intent [#116962](https://github.com/openclaw/openclaw/pull/116962)
- Auto-join Discord voice rooms while occupied [#125974](https://github.com/openclaw/openclaw/pull/125974)
- Present canonical widgets through Discord Activities [#126294](https://github.com/openclaw/openclaw/pull/126294)
- Show background subagent progress in Discord [#95604](https://github.com/openclaw/openclaw/pull/95604)

**Bug fixes**

- Recover Discord after repeated Gateway resume failures [#103596](https://github.com/openclaw/openclaw/pull/103596)
- Prevent duplicate Discord messages during ambiguous retries [#103867](https://github.com/openclaw/openclaw/pull/103867)
- Prevent Discord replies from using unrelated stale context [#114716](https://github.com/openclaw/openclaw/pull/114716)
- Make Discord interaction responses retryable and race-safe [#117417](https://github.com/openclaw/openclaw/pull/117417)
- Make Discord voice sessions follow the latest lifecycle event [#122479](https://github.com/openclaw/openclaw/pull/122479)
- fix(discord): deliver embed-only and component-only messages [#128152](https://github.com/openclaw/openclaw/pull/128152)
- fix(discord): prevent voice replies from cutting off during playback [#130346](https://github.com/openclaw/openclaw/pull/130346)
- Keep Discord gateway restarts safe from late errors [#101617](https://github.com/openclaw/openclaw/pull/101617)
- Reset Discord progress drafts between queued turns [#102341](https://github.com/openclaw/openclaw/pull/102341)
- Stream Discord multipart uploads without eager buffering [#102972](https://github.com/openclaw/openclaw/pull/102972)
- Preserve Discord code formatting across reasoning chunks [#103166](https://github.com/openclaw/openclaw/pull/103166)
- Honor Discord parent-channel thread archive settings [#103413](https://github.com/openclaw/openclaw/pull/103413)
- Keep Discord thread persona names valid at emoji boundaries [#103543](https://github.com/openclaw/openclaw/pull/103543)
- Prevent silent Discord message loss during session conflicts [#103562](https://github.com/openclaw/openclaw/pull/103562)
- Stop stalled Discord directory lookups from hanging indefinitely [#104290](https://github.com/openclaw/openclaw/pull/104290)
- Refresh Discord model picker state after hot reloads [#104635](https://github.com/openclaw/openclaw/pull/104635)
- Retry Discord preview cleanup after transient failures [#104893](https://github.com/openclaw/openclaw/pull/104893)
- Omit invalid Discord component accent colors [#105387](https://github.com/openclaw/openclaw/pull/105387)
- Bound stalled Discord status response reads [#106036](https://github.com/openclaw/openclaw/pull/106036)
- Honor Discord command owners in voice conversations [#106155](https://github.com/openclaw/openclaw/pull/106155)
- Preserve Discord reply context when referenced messages are omitted [#106176](https://github.com/openclaw/openclaw/pull/106176)
- Keep Discord listener slots until work actually settles [#106398](https://github.com/openclaw/openclaw/pull/106398)
- Show only agent-authored status in default Discord progress drafts [#107338](https://github.com/openclaw/openclaw/pull/107338)
- Prevent Discord presence wake floods after reconnects [#107969](https://github.com/openclaw/openclaw/pull/107969)
- Limit Discord presence greetings to channel viewers [#108448](https://github.com/openclaw/openclaw/pull/108448)
- Deliver agent replies to named Discord channels [#108584](https://github.com/openclaw/openclaw/pull/108584)
- Preserve Discord forum targets for CLI-backed plugin tools [#108628](https://github.com/openclaw/openclaw/pull/108628)
- Discord Activities load correctly from packaged gateways [#108725](https://github.com/openclaw/openclaw/pull/108725)
- Open the newest Discord Activity when the launch ID is missing [#108817](https://github.com/openclaw/openclaw/pull/108817)
- Stop stalled Discord webhook sends from hanging indefinitely [#109076](https://github.com/openclaw/openclaw/pull/109076)
- Prevent Discord lifecycle listener buildup across restarts [#109108](https://github.com/openclaw/openclaw/pull/109108)
- Resolve Discord Activity launches in multi-widget channels [#109194](https://github.com/openclaw/openclaw/pull/109194)
- Keep long Discord code replies within message limits [#110148](https://github.com/openclaw/openclaw/pull/110148)
- Preserve Discord messages across dispatch crashes [#110274](https://github.com/openclaw/openclaw/pull/110274)
- Authorize Discord widgets by channel audience [#110522](https://github.com/openclaw/openclaw/pull/110522)
- Stop stalled Discord Activity token uploads from hanging [#110667](https://github.com/openclaw/openclaw/pull/110667)
- fix(discord): sustained gateway bursts stop growing memory [#110954](https://github.com/openclaw/openclaw/pull/110954)
- Close Discord voice-upload sockets after successful sends [#111269](https://github.com/openclaw/openclaw/pull/111269)
- Recover Discord Activity widgets from stalled Gateway responses [#111380](https://github.com/openclaw/openclaw/pull/111380)
- Keep Discord tool activity visible during verbose progress [#111947](https://github.com/openclaw/openclaw/pull/111947)
- Preserve Discord bold and Mattermost native tables [#113037](https://github.com/openclaw/openclaw/pull/113037)
- Migrate shipped Discord DM config before plugin convergence [#113280](https://github.com/openclaw/openclaw/pull/113280)
- Filter Discord pending history by sender visibility [#113407](https://github.com/openclaw/openclaw/pull/113407)
- Warn when Discord allowlists still permit every member [#113414](https://github.com/openclaw/openclaw/pull/113414)
- Preserve Discord attachment content types [#114460](https://github.com/openclaw/openclaw/pull/114460)
- Prevent Discord previews from exposing pre-hook replies [#114904](https://github.com/openclaw/openclaw/pull/114904)
- Keep Discord reasoning replies within message limits [#115092](https://github.com/openclaw/openclaw/pull/115092)
- Require requester identity for privileged Discord tool actions [#115260](https://github.com/openclaw/openclaw/pull/115260)
- Reject malformed UTF-8 in Discord API responses [#115918](https://github.com/openclaw/openclaw/pull/115918)
- Keep Discord activity receipts with adopted thread replies [#116119](https://github.com/openclaw/openclaw/pull/116119)
- Preserve Discord webhook timeout errors [#116155](https://github.com/openclaw/openclaw/pull/116155)
- Keep Discord forum media in one thread and preserve delivery receipts [#116750](https://github.com/openclaw/openclaw/pull/116750)
- Retry Discord webhooks and reactions only when safe [#116821](https://github.com/openclaw/openclaw/pull/116821)
- Clean up deleted Discord threads immediately [#116823](https://github.com/openclaw/openclaw/pull/116823)
- Prevent duplicate Discord voice-message fallbacks [#117127](https://github.com/openclaw/openclaw/pull/117127)
- Deliver long Discord thread starters in safe chunks [#117354](https://github.com/openclaw/openclaw/pull/117354)
- Discord queued-message cleanup continues after a settlement failure [#117524](https://github.com/openclaw/openclaw/pull/117524)
- Restore Discord workspace voice and thread attachments [#117767](https://github.com/openclaw/openclaw/pull/117767)
- Preserve accepted Discord replies after partial delivery failures [#118354](https://github.com/openclaw/openclaw/pull/118354)
- Show a private warning when Discord slash-command finals fail [#118545](https://github.com/openclaw/openclaw/pull/118545)
- Report warming Discord message indexes instead of false success [#118573](https://github.com/openclaw/openclaw/pull/118573)
- Preserve Discord reply privacy after interaction acknowledgments [#118611](https://github.com/openclaw/openclaw/pull/118611)
- Bound retained speech in Discord realtime voice [#119250](https://github.com/openclaw/openclaw/pull/119250)
- Preserve authored Discord component order [#119506](https://github.com/openclaw/openclaw/pull/119506)
- fix(discord): preserve MIME extension for component uploads [#119671](https://github.com/openclaw/openclaw/pull/119671)
- Reset Discord thread sessions across all routed agents [#120259](https://github.com/openclaw/openclaw/pull/120259)
- Surface failed Discord attachment downloads [#120269](https://github.com/openclaw/openclaw/pull/120269)
- Make Discord progress drafts an explicit opt-in [#120376](https://github.com/openclaw/openclaw/pull/120376)
- Deduplicate Discord directory users across servers [#120797](https://github.com/openclaw/openclaw/pull/120797)
- Keep multi-part Discord forum replies in one thread [#120857](https://github.com/openclaw/openclaw/pull/120857)
- Preserve repeated Discord interactive actions [#121155](https://github.com/openclaw/openclaw/pull/121155)
- Keep Discord forum reply batches in one thread [#121165](https://github.com/openclaw/openclaw/pull/121165)
- Unblock Discord message lanes after retry exhaustion and cancellation [#122878](https://github.com/openclaw/openclaw/pull/122878)
- Keep overlapping Discord voice turns with the right speaker [#123243](https://github.com/openclaw/openclaw/pull/123243)
- fix(discord): move the websocket handshake deadline into the shared gateway client options [#123414](https://github.com/openclaw/openclaw/pull/123414)
- Stop Discord voice replies after leaving a session [#124030](https://github.com/openclaw/openclaw/pull/124030)
- Keep stable Discord DM configs upgradeable [#125359](https://github.com/openclaw/openclaw/pull/125359)
- Clean streamed Discord speech and report real fallbacks [#125686](https://github.com/openclaw/openclaw/pull/125686)
- Route Discord polls through canonical delivery [#126250](https://github.com/openclaw/openclaw/pull/126250)
- Preserve text from every Discord message embed [#126752](https://github.com/openclaw/openclaw/pull/126752)
- fix(discord): resolve configured default account for presence actions [#127748](https://github.com/openclaw/openclaw/pull/127748)
- fix(discord): revalidate delivery authority per send [#128357](https://github.com/openclaw/openclaw/pull/128357)
- fix(discord): honor explicit component attachment filenames [#128401](https://github.com/openclaw/openclaw/pull/128401)
- fix(discord): parse stringified message components [#128498](https://github.com/openclaw/openclaw/pull/128498)
- fix(discord): a failing slash command leaves the user watching a spinner that never resolves [#128630](https://github.com/openclaw/openclaw/pull/128630)
- fix(discord): super reactions disappear when ordinary reactions already exist [#128649](https://github.com/openclaw/openclaw/pull/128649)
- fix(discord): keep forum attachments and receipts in their first thread [#128765](https://github.com/openclaw/openclaw/pull/128765)
- fix(discord): preserve per-button reusable settings [#129068](https://github.com/openclaw/openclaw/pull/129068)
- fix(discord): video captions disappear from delivery receipts [#129134](https://github.com/openclaw/openclaw/pull/129134)
- refactor(discord): centralize voice resource lifecycle [#130415](https://github.com/openclaw/openclaw/pull/130415)
- fix(discord): avoid empty warning after successful steer [#131006](https://github.com/openclaw/openclaw/pull/131006)
- fix(transcripts): stop reporting replaced captures as active [#131344](https://github.com/openclaw/openclaw/pull/131344)
- fix(discord): retire voice sessions after realtime provider closure [#131548](https://github.com/openclaw/openclaw/pull/131548)
- Hide failed tool progress from Discord drafts [#92517](https://github.com/openclaw/openclaw/pull/92517)
- fix(discord): upload-file silently drops a caption (#124255) [60136ec](https://github.com/openclaw/openclaw/commit/60136ec)
- fix(discord): upload-file with a base64 buffer fails without pointing at send (#123748) [b9b6ca4](https://github.com/openclaw/openclaw/commit/b9b6ca4)
- Preserve Discord video captions for encoded filenames [#101815](https://github.com/openclaw/openclaw/pull/101815)
- Bound Discord voice-message uploads with route-specific timeouts [#102863](https://github.com/openclaw/openclaw/pull/102863)
- Honor Discord forum archive defaults for implicit threads [#103033](https://github.com/openclaw/openclaw/pull/103033)
- Bound Discord PluralKit lookup delays [#104121](https://github.com/openclaw/openclaw/pull/104121)
- Keep Discord voice failure diagnostics bounded and readable [#104230](https://github.com/openclaw/openclaw/pull/104230)
- fix(discord): add timeout to guarded gateway metadata fetches [#104580](https://github.com/openclaw/openclaw/pull/104580)
- Preserve emoji in Discord voice transcripts [#104896](https://github.com/openclaw/openclaw/pull/104896)
- Keep Discord slash commands deployable at the 100-command cap [#105280](https://github.com/openclaw/openclaw/pull/105280)
- Reject unsupported Discord thread archive durations early [#107610](https://github.com/openclaw/openclaw/pull/107610)
- Preserve complete emoji in Discord voice participant labels [#108278](https://github.com/openclaw/openclaw/pull/108278)
- Prevent redundant Discord command deploys across Gateway processes [#108381](https://github.com/openclaw/openclaw/pull/108381)
- Stop Discord typing flashes for silently handled turns [#108449](https://github.com/openclaw/openclaw/pull/108449)
- Stop Discord READY retry waits immediately on abort [#108561](https://github.com/openclaw/openclaw/pull/108561)
- Parse Discord forum-thread widget targets [#108603](https://github.com/openclaw/openclaw/pull/108603)
- Keep Unicode model-picker buckets valid in Discord [#109514](https://github.com/openclaw/openclaw/pull/109514)
- Release failed Discord Activity OAuth responses [#109869](https://github.com/openclaw/openclaw/pull/109869)
- Stop Discord rate-limit retries when work is canceled [#109913](https://github.com/openclaw/openclaw/pull/109913)
- Skip PluralKit lookup for ordinary Discord messages [#111617](https://github.com/openclaw/openclaw/pull/111617)
- Reject malformed PluralKit message envelopes [#111712](https://github.com/openclaw/openclaw/pull/111712)
- Reject malformed UTF-8 in Discord status probes [#111734](https://github.com/openclaw/openclaw/pull/111734)
- Preserve Discord bot mentions when hydration fails [#111860](https://github.com/openclaw/openclaw/pull/111860)
- Preserve Discord component waiter message ownership [#117492](https://github.com/openclaw/openclaw/pull/117492)
- Clarify empty Discord message searches [#118195](https://github.com/openclaw/openclaw/pull/118195)
- Explain Discord form-opening failures with a private recovery message [#119657](https://github.com/openclaw/openclaw/pull/119657)
- fix(agents): keep tool args when CLI sends input on the start block [#120737](https://github.com/openclaw/openclaw/pull/120737)
- Remove only the bot's own Discord reactions [#120785](https://github.com/openclaw/openclaw/pull/120785)
- fix(discord): malformed gateway HELLO frame kills the bot's socket listener [#121468](https://github.com/openclaw/openclaw/pull/121468)
- Warn when Discord persona delivery falls back [#124650](https://github.com/openclaw/openclaw/pull/124650)
- Keep Discord progress drafts after error replies [#125140](https://github.com/openclaw/openclaw/pull/125140)
- Preserve Discord reply context for media-only messages [#126204](https://github.com/openclaw/openclaw/pull/126204)
- fix(discord): surface failed voice notes after text fallback [#127876](https://github.com/openclaw/openclaw/pull/127876)
- fix(discord): restore question receipts after rejected acknowledgements [#128293](https://github.com/openclaw/openclaw/pull/128293)
- fix(discord): refresh stale starter messages in active threads [#128404](https://github.com/openclaw/openclaw/pull/128404)
- fix(discord): classify announcement threads consistently [#128568](https://github.com/openclaw/openclaw/pull/128568)
- fix(discord): report the messages actually delivered [#128575](https://github.com/openclaw/openclaw/pull/128575)
- Cache unavailable Discord thread starters [#128653](https://github.com/openclaw/openclaw/pull/128653)
- fix(discord): honor explicit names for new forum posts [#129294](https://github.com/openclaw/openclaw/pull/129294)
- fix(discord): prevent accidental mentions inside unfinished code [#129338](https://github.com/openclaw/openclaw/pull/129338)
- fix(discord): honor silent sticker and thread-reply delivery [#129479](https://github.com/openclaw/openclaw/pull/129479)
- fix(discord): keep component attachment names through classic downgrades [#129823](https://github.com/openclaw/openclaw/pull/129823)
- fix(discord): preserve sticker delivery receipts [#129872](https://github.com/openclaw/openclaw/pull/129872)
- fix(discord): retry failed draft preview cleanup [#130006](https://github.com/openclaw/openclaw/pull/130006)
- fix(discord): remove late previews after transient delete failures [#130392](https://github.com/openclaw/openclaw/pull/130392)
- fix(discord): keep mention labels literal in text substitution [#130778](https://github.com/openclaw/openclaw/pull/130778)

**Documentation**

- Correct the Fly.io Discord channel example [#102129](https://github.com/openclaw/openclaw/pull/102129)
- Correct Discord channel keys in multi-agent examples [#106201](https://github.com/openclaw/openclaw/pull/106201)
- Document Discord allowlists and ambient-room prerequisites [#113692](https://github.com/openclaw/openclaw/pull/113692)
- Remove retired Discord subagent progress runtime [#117802](https://github.com/openclaw/openclaw/pull/117802)
- Remove retired Discord config keys from documentation [#118216](https://github.com/openclaw/openclaw/pull/118216)

</details>

</Accordion>

<Accordion title="Slack">

[Slack](/channels/slack) progress now stays in one conversation from the first status through the final answer, keeping the running commentary, work steps, and answer inside one streamed message unless an operator chooses the more compact alternative. Charts and tables can render natively too, with readable text preserved when Slack cannot use the native form.

One organization-installed app can also serve the Enterprise Grid workspaces Slack grants it, with messages, actions, approvals, and proactive delivery bound to the right workspace. Destinations outside the current conversation require an explicit workspace, requests without verified workspace identity are rejected, and relay mode plus org-wide surfaces remain unsupported.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Support Slack Enterprise Grid org-wide installs [#102372](https://github.com/openclaw/openclaw/pull/102372)
- Add portable charts with native Slack rendering [#102635](https://github.com/openclaw/openclaw/pull/102635)
- Add portable table presentation blocks [#103583](https://github.com/openclaw/openclaw/pull/103583)
- Add Slack Agent View support with Assistant View compatibility [#103895](https://github.com/openclaw/openclaw/pull/103895)
- Harden Slack native chart and table delivery [#104539](https://github.com/openclaw/openclaw/pull/104539)
- Add opt-in Slack presence greetings [#108510](https://github.com/openclaw/openclaw/pull/108510)
- Slack progress drafts use shared live status and fresh final replies [#109336](https://github.com/openclaw/openclaw/pull/109336)
- Add opt-in Slack user identity [#109837](https://github.com/openclaw/openclaw/pull/109837)
- Turn Slack progress updates into the final reply [#119480](https://github.com/openclaw/openclaw/pull/119480)
- Add workspace-scoped Slack Grid approvals [#120942](https://github.com/openclaw/openclaw/pull/120942)
- Add workspace-scoped Slack Grid reaction and pin listeners [#120944](https://github.com/openclaw/openclaw/pull/120944)
- Route Slack Enterprise Grid actions and events by workspace [#121014](https://github.com/openclaw/openclaw/pull/121014)
- Add automatic workspace-safe Slack Enterprise Grid support [#121373](https://github.com/openclaw/openclaw/pull/121373)
- Make live Slack session cards the default [#122552](https://github.com/openclaw/openclaw/pull/122552)
- Unify Slack progress into one streamed message [#122976](https://github.com/openclaw/openclaw/pull/122976)
- Add compact commentary-only Slack progress [#126480](https://github.com/openclaw/openclaw/pull/126480)
- Accept spoken mentions in Slack audio clips [#103416](https://github.com/openclaw/openclaw/pull/103416)
- Turn Slack progress drafts into the final reply [#119376](https://github.com/openclaw/openclaw/pull/119376)
- fix(slack): allow group DMs to be opened from the message tool [#132928](https://github.com/openclaw/openclaw/pull/132928)
- Log Slack typing reaction failures [#103303](https://github.com/openclaw/openclaw/pull/103303)

**Bug fixes**

- Prevent message reads from falling back to the wrong conversation [#108637](https://github.com/openclaw/openclaw/pull/108637)
- Preserve repeated Slack events and retry transient failures [#116384](https://github.com/openclaw/openclaw/pull/116384)
- Preserve Slack thread reads, edit formatting, and complete replies [#116915](https://github.com/openclaw/openclaw/pull/116915)
- Recover Slack identity after transient startup failures [#117253](https://github.com/openclaw/openclaw/pull/117253)
- Isolate Slack interactive bindings to the correct conversation [#118662](https://github.com/openclaw/openclaw/pull/118662)
- Route Slack Enterprise Grid messages by workspace [#120087](https://github.com/openclaw/openclaw/pull/120087)
- Accept organization-wide Slack user IDs [#122934](https://github.com/openclaw/openclaw/pull/122934)
- Keep Slack multi-party DMs on one conversation session [#102811](https://github.com/openclaw/openclaw/pull/102811)
- Preserve Slack IDs at API boundaries [#103214](https://github.com/openclaw/openclaw/pull/103214)
- Stop stalled Slack file uploads safely [#103442](https://github.com/openclaw/openclaw/pull/103442)
- Preserve unrelated Slack action rows after interactions [#103445](https://github.com/openclaw/openclaw/pull/103445)
- Use read-scoped Slack lookups for conversation metadata [#103468](https://github.com/openclaw/openclaw/pull/103468)
- Keep malformed Slack delivery signatures from interrupting reconciliation [#105492](https://github.com/openclaw/openclaw/pull/105492)
- Report degraded Slack health when bot identity is missing [#105556](https://github.com/openclaw/openclaw/pull/105556)
- Log structured warnings for disabled Slack channels [#105790](https://github.com/openclaw/openclaw/pull/105790)
- Bound stalled Slack startup identity checks [#105893](https://github.com/openclaw/openclaw/pull/105893)
- Bound Slack user-name cache growth [#105978](https://github.com/openclaw/openclaw/pull/105978)
- Bound Slack directory and allowlist lookups [#106643](https://github.com/openclaw/openclaw/pull/106643)
- Bound Slack read actions when the API stalls [#107103](https://github.com/openclaw/openclaw/pull/107103)
- Preserve queued Slack replies [#107820](https://github.com/openclaw/openclaw/pull/107820)
- Keep Slack health checks inside their deadline [#107835](https://github.com/openclaw/openclaw/pull/107835)
- Make Slack event admission durable across Bolt and relay [#109910](https://github.com/openclaw/openclaw/pull/109910)
- Release unread Slack ownership-check responses [#111231](https://github.com/openclaw/openclaw/pull/111231)
- Prevent exposed Markdown emphasis markers in Slack CJK text [#111575](https://github.com/openclaw/openclaw/pull/111575)
- Preserve native Slack tables through outbound handoff [#111955](https://github.com/openclaw/openclaw/pull/111955)
- Restore Slack thread context for legacy session keys [#114009](https://github.com/openclaw/openclaw/pull/114009)
- Preserve Slack attachment type and size for agents [#114502](https://github.com/openclaw/openclaw/pull/114502)
- fix(slack): dispatch independently routed threads concurrently [#114552](https://github.com/openclaw/openclaw/pull/114552)
- Bound stalled Slack read-only API calls [#115018](https://github.com/openclaw/openclaw/pull/115018)
- Prevent long Slack edits from failing [#115027](https://github.com/openclaw/openclaw/pull/115027)
- Bound Slack response_url body inspection [#115093](https://github.com/openclaw/openclaw/pull/115093)
- Keep Slack previews with custom identity [#115114](https://github.com/openclaw/openclaw/pull/115114)
- Preserve pasted Slack tables in inbound messages [#115163](https://github.com/openclaw/openclaw/pull/115163)
- Deduplicate same-post Slack message and mention events [#115302](https://github.com/openclaw/openclaw/pull/115302)
- Prevent duplicate Slack group-DM mentions [#115468](https://github.com/openclaw/openclaw/pull/115468)
- Prevent duplicate Slack group-DM mention replies [#115528](https://github.com/openclaw/openclaw/pull/115528)
- Recover Slack replies during Gateway startup replay [#115991](https://github.com/openclaw/openclaw/pull/115991)
- Explain Slack channel-allowlist denials privately [#116618](https://github.com/openclaw/openclaw/pull/116618)
- Preserve context in Slack group-DM thread follow-ups [#116660](https://github.com/openclaw/openclaw/pull/116660)
- Recover Slack identity after transient startup authentication failures [#117060](https://github.com/openclaw/openclaw/pull/117060)
- Retry Slack thread lookups instead of silently dropping messages [#117135](https://github.com/openclaw/openclaw/pull/117135)
- Prevent stalled Slack presence checks from blocking shutdown [#117478](https://github.com/openclaw/openclaw/pull/117478)
- Restore Slack workspace-relative attachments [#117728](https://github.com/openclaw/openclaw/pull/117728)
- Preserve complete Slack native-data fallbacks [#117809](https://github.com/openclaw/openclaw/pull/117809)
- Deliver Slack modal submissions and closures to agents [#118123](https://github.com/openclaw/openclaw/pull/118123)
- Finalize the Slack question card that was actually delivered [#118450](https://github.com/openclaw/openclaw/pull/118450)
- Clean up partially started Slack streams after fallback [#118617](https://github.com/openclaw/openclaw/pull/118617)
- Restore GovSlack media with isolated trust boundaries [#118695](https://github.com/openclaw/openclaw/pull/118695)
- Authorize Slack reads before applying limits [#118736](https://github.com/openclaw/openclaw/pull/118736)
- Render Slack progress Markdown without stray backslashes [#119373](https://github.com/openclaw/openclaw/pull/119373)
- Add file extensions to unnamed Slack uploads [#119399](https://github.com/openclaw/openclaw/pull/119399)
- Keep Slack replies below newer human messages [#119832](https://github.com/openclaw/openclaw/pull/119832)
- Isolate Slack thread caches and persist channel renames safely [#120022](https://github.com/openclaw/openclaw/pull/120022)
- Keep Slack turns running when a Codex plugin is disabled [#120312](https://github.com/openclaw/openclaw/pull/120312)
- Prevent Slack directory pagination loops [#120445](https://github.com/openclaw/openclaw/pull/120445)
- Stop Slack authorization from hanging on cursor loops [#120686](https://github.com/openclaw/openclaw/pull/120686)
- Enable team-scoped Slack exec approvals for Enterprise Grid [#120874](https://github.com/openclaw/openclaw/pull/120874)
- Tell agents when Slack forwarded images are unavailable [#122108](https://github.com/openclaw/openclaw/pull/122108)
- Retry Slack member events after transient authorization lookups [#122356](https://github.com/openclaw/openclaw/pull/122356)
- Deliver Slack reaction events to thread-scoped turns [#122363](https://github.com/openclaw/openclaw/pull/122363)
- Prevent duplicate Slack Socket Mode connections [#122624](https://github.com/openclaw/openclaw/pull/122624)
- Preserve original image bytes for forced Slack uploads [#122667](https://github.com/openclaw/openclaw/pull/122667)
- Stop repeated Slack outage notices in active conversations [#122782](https://github.com/openclaw/openclaw/pull/122782)
- Prevent Slack progress cards from remaining stuck on Working [#122816](https://github.com/openclaw/openclaw/pull/122816)
- Apply updated global settings to new Slack messages [#123373](https://github.com/openclaw/openclaw/pull/123373)
- Preserve Slack dispatch custody for structured messages [#123710](https://github.com/openclaw/openclaw/pull/123710)
- Remove tool-call receipts from finished Slack progress cards [#123851](https://github.com/openclaw/openclaw/pull/123851)
- Restore bot message delivery on Slack Enterprise Grid [#125009](https://github.com/openclaw/openclaw/pull/125009)
- Require confirmed Slack message identity for delivery success [#125762](https://github.com/openclaw/openclaw/pull/125762)
- fix(slack): preserve long legacy interactive text [#127994](https://github.com/openclaw/openclaw/pull/127994)
- fix(slack): keep failed message retries in their original thread [#128182](https://github.com/openclaw/openclaw/pull/128182)
- fix(slack): unify channel account readiness [#128322](https://github.com/openclaw/openclaw/pull/128322)
- fix(slack): prevent long message edits from silently losing text [#128613](https://github.com/openclaw/openclaw/pull/128613)
- fix(slack): keep partial preview stable across reasoning turns [#128626](https://github.com/openclaw/openclaw/pull/128626)
- fix(slack): keep edited and deleted messages in their original threads [#128768](https://github.com/openclaw/openclaw/pull/128768)
- fix(slack): reject file downloads outside requested conversation [#128903](https://github.com/openclaw/openclaw/pull/128903)
- fix(slack): wake yielded parents after subagent completion [#129023](https://github.com/openclaw/openclaw/pull/129023)
- fix(slack): prevent duplicate files across direct and forwarded attachments [#129065](https://github.com/openclaw/openclaw/pull/129065)
- fix(slack): explicit replies land in the requested thread [#129069](https://github.com/openclaw/openclaw/pull/129069)
- fix(slack): prevent duplicate question buttons and extra messages [#129445](https://github.com/openclaw/openclaw/pull/129445)
- fix(slack): stop giving HTTP onboarding an invalid Socket manifest [#130234](https://github.com/openclaw/openclaw/pull/130234)
- fix(slack): preserve user names in rich-text mentions [#130816](https://github.com/openclaw/openclaw/pull/130816)
- fix(slack): record reasons for failed and omitted attachments [#130857](https://github.com/openclaw/openclaw/pull/130857)
- fix(slack): preserve table formatting in edits and previews [#130979](https://github.com/openclaw/openclaw/pull/130979)
- fix(slack): stop leaking consumed media into card and text sends [#131586](https://github.com/openclaw/openclaw/pull/131586)
- fix(slack): mark partially unavailable thread files [#131896](https://github.com/openclaw/openclaw/pull/131896)
- Prevent duplicate Slack reply controls [#101474](https://github.com/openclaw/openclaw/pull/101474)
- Show the active Slack command in App Home [#102340](https://github.com/openclaw/openclaw/pull/102340)
- Correct Slack reply metadata without breaking standalone message threading [#102905](https://github.com/openclaw/openclaw/pull/102905)
- Separate Slack commentary from tool progress [#103995](https://github.com/openclaw/openclaw/pull/103995)
- Preserve canonical Slack block delivery receipts [#104563](https://github.com/openclaw/openclaw/pull/104563)
- Prefer configured Slack slash commands [#104736](https://github.com/openclaw/openclaw/pull/104736)
- Hide misleading Slack typing indicators for room events [#105813](https://github.com/openclaw/openclaw/pull/105813)
- Enforce the Slack upload timeout across transport phases [#106496](https://github.com/openclaw/openclaw/pull/106496)
- Use the default Slack forwarder when the environment override is blank [#110675](https://github.com/openclaw/openclaw/pull/110675)
- Prevent Slack directory pagination from hanging [#115056](https://github.com/openclaw/openclaw/pull/115056)
- Keep Slack outbound hooks ahead of previews [#115357](https://github.com/openclaw/openclaw/pull/115357)
- Stop false Slack message-drop warnings in doctor [#115563](https://github.com/openclaw/openclaw/pull/115563)
- Keep configured Slack slash commands consistent in App Home [#118735](https://github.com/openclaw/openclaw/pull/118735)
- Preserve captions on Slack file uploads [#121047](https://github.com/openclaw/openclaw/pull/121047)
- Keep joined Slack threads active beyond 24 hours [#121708](https://github.com/openclaw/openclaw/pull/121708)
- fix(slack): strip Exec failed traces from streaming replies [#122827](https://github.com/openclaw/openclaw/pull/122827)
- Keep Slack thread replies on the routed agent [#123202](https://github.com/openclaw/openclaw/pull/123202)
- Keep cached Slack identity and allowlists live [#123403](https://github.com/openclaw/openclaw/pull/123403)
- Remove Slack's transport-level NO_REPLY special case [#124561](https://github.com/openclaw/openclaw/pull/124561)
- Reduce duplicate text in Slack native task cards [#125168](https://github.com/openclaw/openclaw/pull/125168)
- Remove stale Slack progress after silent turns [#125494](https://github.com/openclaw/openclaw/pull/125494)
- Prevent duplicate Slack content after partial delivery failures [#127130](https://github.com/openclaw/openclaw/pull/127130)
- fix(slack): keep private menu replies in their original thread [#128341](https://github.com/openclaw/openclaw/pull/128341)
- fix(slack): honor HTTP setup credentials [#128659](https://github.com/openclaw/openclaw/pull/128659)
- fix(slack): multipart receipts misclassify overflow text as media [#129089](https://github.com/openclaw/openclaw/pull/129089)
- fix(slack): retain unavailable attachments alongside downloads [#129708](https://github.com/openclaw/openclaw/pull/129708)
- fix(slack): retry stale draft cleanup [#129819](https://github.com/openclaw/openclaw/pull/129819)
- fix(slack): retain all multipart action send receipts [#130606](https://github.com/openclaw/openclaw/pull/130606)

**Documentation**

- Explain Slack group DM bot membership requirements [#101944](https://github.com/openclaw/openclaw/pull/101944)
- Correct Slack channel configuration examples [#103491](https://github.com/openclaw/openclaw/pull/103491)
- Correct Slack Socket Mode tuning and cleanup guidance [#119328](https://github.com/openclaw/openclaw/pull/119328)
- docs(slack): use canonical postAs key [#128448](https://github.com/openclaw/openclaw/pull/128448)

</details>

</Accordion>

<Accordion title="WhatsApp">

[WhatsApp](/channels/whatsapp) can now list groups from the linked account without making someone hunt through logs or invite links, and it avoids opening a competing connection while OpenClaw already owns that account. If OpenClaw restarts after accepting an incoming message, the pending work can continue without later events jumping ahead, while multipart replies keep the parts and receipts that actually succeeded instead of replaying the entire response after one part fails.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Bug fixes**

- Discover WhatsApp groups from the linked account [#109886](https://github.com/openclaw/openclaw/pull/109886)
- Preserve WhatsApp inbound messages across restarts [#110418](https://github.com/openclaw/openclaw/pull/110418)
- Keep WhatsApp delivery results and receipts consistent [#118114](https://github.com/openclaw/openclaw/pull/118114)
- Keep pre-connect WhatsApp messages replayable [#104450](https://github.com/openclaw/openclaw/pull/104450)
- Preserve the underlying WhatsApp disconnect error [#105399](https://github.com/openclaw/openclaw/pull/105399)
- Honor plural media selection in WhatsApp payloads [#105576](https://github.com/openclaw/openclaw/pull/105576)
- Harden WhatsApp media sending with shared media helpers [#107017](https://github.com/openclaw/openclaw/pull/107017)
- Migrate legacy default-channel allowlists without channel config [#108453](https://github.com/openclaw/openclaw/pull/108453)
- Prevent WhatsApp shutdown from hanging on pre-aborted stops [#109903](https://github.com/openclaw/openclaw/pull/109903)
- Honor WhatsApp text mentions alongside member tags [#110412](https://github.com/openclaw/openclaw/pull/110412)
- Preserve active WhatsApp connections across runtime reloads [#110762](https://github.com/openclaw/openclaw/pull/110762)
- Render CommonMark correctly in WhatsApp messages [#113010](https://github.com/openclaw/openclaw/pull/113010)
- Preserve actionable WhatsApp remote-logout status [#114445](https://github.com/openclaw/openclaw/pull/114445)
- Stop identical WhatsApp replies from suppressing other chats [#115574](https://github.com/openclaw/openclaw/pull/115574)
- Send filename-only WhatsApp media in its native format [#115725](https://github.com/openclaw/openclaw/pull/115725)
- Preserve queued WhatsApp messages until delivery [#116179](https://github.com/openclaw/openclaw/pull/116179)
- Send WhatsApp messages when typing presence fails [#116739](https://github.com/openclaw/openclaw/pull/116739)
- Preserve WhatsApp selections and native media types [#116816](https://github.com/openclaw/openclaw/pull/116816)
- Restore WhatsApp interactive mentions, polls, video notes, and quoted media [#116901](https://github.com/openclaw/openclaw/pull/116901)
- Preserve WhatsApp message envelope behavior [#116989](https://github.com/openclaw/openclaw/pull/116989)
- Prevent duplicate WhatsApp replies after accepted delivery [#117198](https://github.com/openclaw/openclaw/pull/117198)
- Prevent WhatsApp self echoes from triggering duplicate work [#117228](https://github.com/openclaw/openclaw/pull/117228)
- Preserve WhatsApp group participant metadata [#117234](https://github.com/openclaw/openclaw/pull/117234)
- Keep WhatsApp attachment-failure logs safely redacted [#117939](https://github.com/openclaw/openclaw/pull/117939)
- Stop WhatsApp reconnecting after retry exhaustion [#118659](https://github.com/openclaw/openclaw/pull/118659)
- Keep typing visible during long active turns [#120337](https://github.com/openclaw/openclaw/pull/120337)
- Stop WhatsApp from dropping distinct messages with repeated text [#122785](https://github.com/openclaw/openclaw/pull/122785)
- Reload WhatsApp runtime code after plugin replacement [#126867](https://github.com/openclaw/openclaw/pull/126867)
- fix(whatsapp): preserve filenames and media types for attachment uploads [#128186](https://github.com/openclaw/openclaw/pull/128186)
- fix(whatsapp): preserve text when Markdown formatting returns no chunks [#129275](https://github.com/openclaw/openclaw/pull/129275)
- fix(whatsapp): retain unmatched attachments across captioned replacement [#131672](https://github.com/openclaw/openclaw/pull/131672)
- Keep WhatsApp echo diagnostics valid around emoji boundaries [#102603](https://github.com/openclaw/openclaw/pull/102603)
- Report WhatsApp logout no-ops accurately [#105929](https://github.com/openclaw/openclaw/pull/105929)
- Prevent WhatsApp doctor checks from hanging [#109243](https://github.com/openclaw/openclaw/pull/109243)
- Restore WhatsApp group reactions for LID-only senders [#110053](https://github.com/openclaw/openclaw/pull/110053)
- Prevent concurrent WhatsApp source-account startup failures [#111094](https://github.com/openclaw/openclaw/pull/111094)
- Restore WhatsApp reactions in the current conversation [#113178](https://github.com/openclaw/openclaw/pull/113178)
- Preserve WhatsApp reply references when quoted text is unavailable [#115517](https://github.com/openclaw/openclaw/pull/115517)
- Keep WhatsApp QR login available to grammar-constrained models [#115656](https://github.com/openclaw/openclaw/pull/115656)
- Render quoted WhatsApp self-chat replies across PN and LID aliases [#116814](https://github.com/openclaw/openclaw/pull/116814)
- Restore WhatsApp reactions for self-authored messages [#117697](https://github.com/openclaw/openclaw/pull/117697)
- Clear and migrate every WhatsApp credential class safely [#118610](https://github.com/openclaw/openclaw/pull/118610)
- Honor disabled WhatsApp self-chat without affecting groups [#118711](https://github.com/openclaw/openclaw/pull/118711)
- Confirm before logging out WhatsApp accounts [#122437](https://github.com/openclaw/openclaw/pull/122437)
- fix(whatsapp): prevent stale group mentions after membership changes [#128283](https://github.com/openclaw/openclaw/pull/128283)
- fix(whatsapp): avoid mentions inside unterminated inline code [#129281](https://github.com/openclaw/openclaw/pull/129281)
- Report WhatsApp native replies to sent-message hooks [#97728](https://github.com/openclaw/openclaw/pull/97728)

**Documentation**

- Clarify WhatsApp typing cleanup timing [50cc620](https://github.com/openclaw/openclaw/commit/50cc620)
- Document how to inspect and verify wacli messages [#116410](https://github.com/openclaw/openclaw/pull/116410)
- docs(whatsapp): document the canonical ack reaction keys [#118161](https://github.com/openclaw/openclaw/pull/118161)

</details>

</Accordion>

<Accordion title="Signal">

[Signal](/channels/signal) replies now keep their native quote block through ordinary, chunked, media, and durable delivery when quoting is enabled. Messages received just before a crash can resume from local storage, and a failed recipient is reported instead of disappearing into a false success. Group sends remain conservative after any member receives the message, so one failed recipient does not cause the whole reply to be repeated to everyone else.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Bug fixes**

- Preserve native quoted replies in Signal [#105347](https://github.com/openclaw/openclaw/pull/105347)
- Retry Signal messages after transient session conflicts [#103218](https://github.com/openclaw/openclaw/pull/103218)
- Preserve accepted Signal messages during monitor shutdown [#103967](https://github.com/openclaw/openclaw/pull/103967)
- Stop stalled Signal responses from hanging operations [#104122](https://github.com/openclaw/openclaw/pull/104122)
- Preserve Signal daemon diagnostics across output chunks [#104152](https://github.com/openclaw/openclaw/pull/104152)
- Preserve Signal username targets during routing and sends [#107365](https://github.com/openclaw/openclaw/pull/107365)
- Reconnect Signal after a stalled container handshake [#107386](https://github.com/openclaw/openclaw/pull/107386)
- Keep Signal controls responsive during active runs [#107422](https://github.com/openclaw/openclaw/pull/107422)
- Bound slow Signal REST responses by the request timeout [#109047](https://github.com/openclaw/openclaw/pull/109047)
- Recover Signal messages after receive-to-dispatch crashes [#109907](https://github.com/openclaw/openclaw/pull/109907)
- Preserve line breaks in debounced Signal messages [#110090](https://github.com/openclaw/openclaw/pull/110090)
- Preserve Signal reverse-proxy path prefixes [#110495](https://github.com/openclaw/openclaw/pull/110495)
- Keep Signal retries owned during shutdown [#110629](https://github.com/openclaw/openclaw/pull/110629)
- Preserve Signal ingress handoff and named-account channel settings [#111449](https://github.com/openclaw/openclaw/pull/111449)
- Surface failed Signal recipient deliveries [#111960](https://github.com/openclaw/openclaw/pull/111960)
- Reject malformed Signal attachments before saving [#114883](https://github.com/openclaw/openclaw/pull/114883)
- Preserve original filenames for Signal attachments [#115107](https://github.com/openclaw/openclaw/pull/115107)
- Fix Signal account health, reaction ownership, and skipped-message history [#116914](https://github.com/openclaw/openclaw/pull/116914)
- Prevent duplicate Signal quoted messages after ambiguous failures [#117134](https://github.com/openclaw/openclaw/pull/117134)
- Deliver authorized workspace attachments through Signal [#117895](https://github.com/openclaw/openclaw/pull/117895)
- Prevent duplicate Signal processing across sender aliases [#118970](https://github.com/openclaw/openclaw/pull/118970)
- Preserve accepted Signal messages during shutdown [#118975](https://github.com/openclaw/openclaw/pull/118975)
- Preserve Signal prompts after a later reply chunk fails [#126160](https://github.com/openclaw/openclaw/pull/126160)
- fix(signal): preserve messages redelivered behind a busy lane [#128093](https://github.com/openclaw/openclaw/pull/128093)
- fix(signal): replay approval reactions after transient Gateway failures [#130134](https://github.com/openclaw/openclaw/pull/130134)
- Make Signal group mentions reliably wake the bot [#96738](https://github.com/openclaw/openclaw/pull/96738)
- Clean up and unblock Signal CLI release installs [#103339](https://github.com/openclaw/openclaw/pull/103339)
- Reject unsupported Signal message actions early [#104788](https://github.com/openclaw/openclaw/pull/104788)
- Release failed Signal CLI download connections promptly [#109442](https://github.com/openclaw/openclaw/pull/109442)
- Handle malformed Signal CLI release metadata cleanly [#110824](https://github.com/openclaw/openclaw/pull/110824)
- Keep Signal reactions on the routed target [#112607](https://github.com/openclaw/openclaw/pull/112607)
- Keep multiline Signal previews on one log line [#114881](https://github.com/openclaw/openclaw/pull/114881)
- Validate and normalize Signal accounts during noninteractive setup [#118932](https://github.com/openclaw/openclaw/pull/118932)
- fix(signal): report managed daemon port collisions before startup [#124015](https://github.com/openclaw/openclaw/pull/124015)
- Keep Signal pairing across UUID and phone aliases [#78022](https://github.com/openclaw/openclaw/pull/78022)

**Documentation**

- Document Signal non-interactive setup flags [#102114](https://github.com/openclaw/openclaw/pull/102114)

</details>

</Accordion>

<Accordion title="iMessage and BlueBubbles">

[iMessage](/channels/imessage) is now an official installable plugin that carries existing configuration and state through the move out of core. Eligible approval requests can use native Messages polls, while older bridges, SMS, and failed poll sends keep the existing text, reaction, or command fallback.

Remote Mac setups also keep attachments with the correct existing chat and can use supported remote paths and actions without sharing a filesystem with the machine running OpenClaw, while incoming messages already stored before a crash can replay. New setups still need the plugin and `imsg` on a signed-in Mac, and this remains separate from the iOS and macOS OpenClaw chat apps.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add native iMessage approval polls [#112714](https://github.com/openclaw/openclaw/pull/112714)
- Move iMessage from core to an official plugin [#117101](https://github.com/openclaw/openclaw/pull/117101)
- Style iMessage approval details consistently in poll mode [#116221](https://github.com/openclaw/openclaw/pull/116221)

**Bug fixes**

- Preserve iMessage delivery across Gateway crashes [#110409](https://github.com/openclaw/openclaw/pull/110409)
- iMessage attachments reach the correct existing chat [#115006](https://github.com/openclaw/openclaw/pull/115006)
- Preserve iMessage transport, failures, and voice intent [#116889](https://github.com/openclaw/openclaw/pull/116889)
- Preserve fenced role keys in iMessage replies [#117159](https://github.com/openclaw/openclaw/pull/117159)
- Rewind iMessage cursor after chat database replacement [#117788](https://github.com/openclaw/openclaw/pull/117788)
- Make SSH-backed iMessage sends and actions reliable [#121038](https://github.com/openclaw/openclaw/pull/121038)
- Repair anchorless iMessage routing from authoritative history [#104218](https://github.com/openclaw/openclaw/pull/104218)
- Preserve split iMessage permission diagnostics [#107393](https://github.com/openclaw/openclaw/pull/107393)
- Keep iMessage actions in the current conversation [#107773](https://github.com/openclaw/openclaw/pull/107773)
- Keep fast-mode progress out of iMessage chat history [#110052](https://github.com/openclaw/openclaw/pull/110052)
- Prevent duplicate iMessages after delayed fallback sends [#110853](https://github.com/openclaw/openclaw/pull/110853)
- Correct iMessage outbound Markdown formatting [#113138](https://github.com/openclaw/openclaw/pull/113138)
- Show complete iMessage poll selections to agents [#114714](https://github.com/openclaw/openclaw/pull/114714)
- Preserve original filenames for iMessage attachments [#117197](https://github.com/openclaw/openclaw/pull/117197)
- Preserve iMessage attachment names and accepted delivery receipts [#117238](https://github.com/openclaw/openclaw/pull/117238)
- Preserve iMessage delivery receipts and outcomes [#117282](https://github.com/openclaw/openclaw/pull/117282)
- Start explicitly enabled iMessage accounts [#118944](https://github.com/openclaw/openclaw/pull/118944)
- Deduplicate only truly shared iMessage watchers [#118974](https://github.com/openclaw/openclaw/pull/118974)
- fix(imessage): reject malformed base64 attachment buffers [#120216](https://github.com/openclaw/openclaw/pull/120216)
- Stop iMessage echo guards from dropping real replies [#120260](https://github.com/openclaw/openclaw/pull/120260)
- Preserve iMessage attachment and voice-message identities [#120739](https://github.com/openclaw/openclaw/pull/120739)
- Preserve retry-safe iMessage no-send results [#122672](https://github.com/openclaw/openclaw/pull/122672)
- Keep automatic iMessage replies on the inbound SMS route [#125633](https://github.com/openclaw/openclaw/pull/125633)
- Reject ambiguous iMessage recipients [#126564](https://github.com/openclaw/openclaw/pull/126564)
- fix(imessage): stop self-chat dedupe from tripping loop limiter [#126856](https://github.com/openclaw/openclaw/pull/126856)
- fix(imessage): prevent ordinary quoted messages from disappearing [#129450](https://github.com/openclaw/openclaw/pull/129450)
- fix(imessage): preserve original message context in threaded replies [#129917](https://github.com/openclaw/openclaw/pull/129917)
- fix(imessage): replay approval reactions after transient Gateway failures [#130893](https://github.com/openclaw/openclaw/pull/130893)
- Remove internal tool traces from iMessage replies [#101430](https://github.com/openclaw/openclaw/pull/101430)
- Keep iMessage CLI error tails valid Unicode [#102626](https://github.com/openclaw/openclaw/pull/102626)
- Let iMessage shutdown finish promptly after its helper closes [#108909](https://github.com/openclaw/openclaw/pull/108909)
- Detect iMessage remote wrappers when HOME is blank [#111715](https://github.com/openclaw/openclaw/pull/111715)
- Explain unsupported iMessage private-status probes [#115526](https://github.com/openclaw/openclaw/pull/115526)
- Preserve iMessage TTS fallback when CAF staging fails [#126378](https://github.com/openclaw/openclaw/pull/126378)
- fix(imessage): preserve dunder reference links [#130547](https://github.com/openclaw/openclaw/pull/130547)
- fix(imessage): preserve non-Homebrew imsg during setup [#131429](https://github.com/openclaw/openclaw/pull/131429)

**Documentation**

- Remove retired OpenClaw iMessage split-send coalescing [#108436](https://github.com/openclaw/openclaw/pull/108436)
- Align iMessage recovery docs with durable SQLite ingress [#111002](https://github.com/openclaw/openclaw/pull/111002)

</details>

</Accordion>

<Accordion title="Feishu and Lark">

In [Feishu](/channels/feishu), an agent can resend a sticker previously received by that bot account and, when an operator adds labels, find the right sticker by keyword. Accepted Feishu messages and comments can also resume after a restart, streaming cards keep the latest accepted version, and unsupported image formats remain available as file attachments instead of being discarded. Sticker actions and labels are opt-in and do not retroactively organize an existing collection; the sticker and comment work is specifically verified for Feishu rather than every Lark path.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- feat(feishu): let agents resend received stickers [#130374](https://github.com/openclaw/openclaw/pull/130374)
- feat(feishu): find received stickers by configured keywords [#130498](https://github.com/openclaw/openclaw/pull/130498)
- Move Feishu replay protection onto core dedupe [#104384](https://github.com/openclaw/openclaw/pull/104384)
- Opt-in Feishu bot-to-bot conversations [#89783](https://github.com/openclaw/openclaw/pull/89783)
- Add opt-in Feishu VC meeting invite auto-join [#92340](https://github.com/openclaw/openclaw/pull/92340)

**Bug fixes**

- Prevent duplicate Feishu streaming-card snapshots [#103915](https://github.com/openclaw/openclaw/pull/103915)
- Preserve Feishu inbound messages across restarts [#110864](https://github.com/openclaw/openclaw/pull/110864)
- Make Feishu delivery and media handling truthful [#117023](https://github.com/openclaw/openclaw/pull/117023)
- Keep Feishu native cards in topic threads [#102804](https://github.com/openclaw/openclaw/pull/102804)
- Honor configured timeouts for Feishu streaming cards [#102948](https://github.com/openclaw/openclaw/pull/102948)
- Bound the Feishu sender-name cache [#103513](https://github.com/openclaw/openclaw/pull/103513)
- Restore Feishu WebSocket liveness detection [#103763](https://github.com/openclaw/openclaw/pull/103763)
- Harden Feishu document image and Markdown handling [#104663](https://github.com/openclaw/openclaw/pull/104663)
- Render Feishu group policy safely in Form mode [#107336](https://github.com/openclaw/openclaw/pull/107336)
- Deliver Feishu direct-message replies through the conversation [#109637](https://github.com/openclaw/openclaw/pull/109637)
- Keep Lark Drive comment mentions working through identity outages [#112807](https://github.com/openclaw/openclaw/pull/112807)
- Settle Feishu delivery hooks after native finalization [#113152](https://github.com/openclaw/openclaw/pull/113152)
- Restore readable content from forwarded Feishu cards [#115136](https://github.com/openclaw/openclaw/pull/115136)
- Feishu group card buttons pass mention gating [#116105](https://github.com/openclaw/openclaw/pull/116105)
- Preserve Feishu message creation times [#116156](https://github.com/openclaw/openclaw/pull/116156)
- Preserve complete Feishu reaction context [#116918](https://github.com/openclaw/openclaw/pull/116918)
- Prevent duplicate Feishu replies for multipart attachments [#117196](https://github.com/openclaw/openclaw/pull/117196)
- Preserve Feishu outbound delivery progress and reply targets [#117223](https://github.com/openclaw/openclaw/pull/117223)
- Preserve ports and paths for custom Feishu API domains [#117278](https://github.com/openclaw/openclaw/pull/117278)
- fix(feishu): route rich-post edits through the correct SDK method [#117414](https://github.com/openclaw/openclaw/pull/117414)
- Deliver approved workspace attachments through Feishu [#117778](https://github.com/openclaw/openclaw/pull/117778)
- fix(feishu): stop repeated doc child pagination [#121124](https://github.com/openclaw/openclaw/pull/121124)
- fix(feishu): promote send attachment aliases instead of silent drop [#125664](https://github.com/openclaw/openclaw/pull/125664)
- fix(feishu): preserve all accepted voice fallback content [#128130](https://github.com/openclaw/openclaw/pull/128130)
- fix(feishu): report delivered replies when message receipts are missing [#128213](https://github.com/openclaw/openclaw/pull/128213)
- fix(feishu): prevent blank duplicate replies when card receipts are absent [#128274](https://github.com/openclaw/openclaw/pull/128274)
- fix(feishu): preserve captions when apparent voice media is a file [#128771](https://github.com/openclaw/openclaw/pull/128771)
- fix(feishu): deliver presentations in document comments [#129843](https://github.com/openclaw/openclaw/pull/129843)
- fix(feishu): deliver long message-tool replies with configured rendering [#129902](https://github.com/openclaw/openclaw/pull/129902)
- fix(feishu): preserve unavailable controls in message cards [#130641](https://github.com/openclaw/openclaw/pull/130641)
- fix(feishu): mark server-transcribed audio so core skips duplicate ASR [#130953](https://github.com/openclaw/openclaw/pull/130953)
- fix(feishu): split oversized Markdown cards without losing content or receipts [#131106](https://github.com/openclaw/openclaw/pull/131106)
- fix(feishu): include thread_id in inbound debounce key when root_id is absent [#131183](https://github.com/openclaw/openclaw/pull/131183)
- Route Feishu SDK traffic through configured proxies [#86386](https://github.com/openclaw/openclaw/pull/86386)
- Restore Feishu file and image attachment delivery [#95514](https://github.com/openclaw/openclaw/pull/95514)
- Prevent Feishu media fallback references from leaking [#98251](https://github.com/openclaw/openclaw/pull/98251)
- Keep Feishu media replies from disappearing [#98320](https://github.com/openclaw/openclaw/pull/98320)
- Preserve intended line breaks in Feishu Markdown posts [#99394](https://github.com/openclaw/openclaw/pull/99394)
- Report unexpected Feishu identity recovery failures [#102185](https://github.com/openclaw/openclaw/pull/102185)
- Preserve one readable text reply with Feishu Auto-TTS voice notes [#103781](https://github.com/openclaw/openclaw/pull/103781)
- Bound stalled Feishu app-registration requests [#105549](https://github.com/openclaw/openclaw/pull/105549)
- Stop stalled Feishu media downloads from hanging messages [#106541](https://github.com/openclaw/openclaw/pull/106541)
- Add privacy-safe Feishu message parse diagnostics [#107947](https://github.com/openclaw/openclaw/pull/107947)
- Stop Feishu comment retries when an account stops [#108408](https://github.com/openclaw/openclaw/pull/108408)
- Cache inaccessible Feishu sender-name lookups [#111700](https://github.com/openclaw/openclaw/pull/111700)
- Inspect canonical Feishu doctor transcripts [#115148](https://github.com/openclaw/openclaw/pull/115148)
- Keep intentional Feishu NO_REPLY turns silent [#115530](https://github.com/openclaw/openclaw/pull/115530)
- Preserve valid empty Feishu inbound messages [#115583](https://github.com/openclaw/openclaw/pull/115583)
- Close rejected Feishu streaming-card connections promptly [#117312](https://github.com/openclaw/openclaw/pull/117312)
- Use real Feishu message IDs for reaction topic hydration [#117685](https://github.com/openclaw/openclaw/pull/117685)
- Keep disabled Feishu accounts out of model-tool routing [#126412](https://github.com/openclaw/openclaw/pull/126412)
- fix(feishu): preserve accepted document-comment delivery identity [#128284](https://github.com/openclaw/openclaw/pull/128284)
- fix(feishu): preserve attachments in document comment replies [#129259](https://github.com/openclaw/openclaw/pull/129259)
- fix(feishu): deliver rich-post attachments in order without duplicate downloads [#129472](https://github.com/openclaw/openclaw/pull/129472)
- fix(feishu): deliver attachment aliases in thread replies [#130023](https://github.com/openclaw/openclaw/pull/130023)
- fix(feishu): preserve commands in select fallback cards [#130515](https://github.com/openclaw/openclaw/pull/130515)

</details>

</Accordion>

<Accordion title="Mattermost">

[Mattermost](/channels/mattermost) can now read bounded, paginated history from channels the bot can already access once an operator enables the feature. Integrations that rewrite or cancel replies now complete that work before delivery, preventing an early preview from exposing content that the hook removes or changes. Completed sends also keep the real Mattermost post identity across previews, actions, media, and durable paths.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add guarded Mattermost channel-history reads [#110875](https://github.com/openclaw/openclaw/pull/110875)
- Add opt-in Mattermost DM threading by chat type [#98111](https://github.com/openclaw/openclaw/pull/98111)
- Restart only the changed Mattermost account on reload [#99312](https://github.com/openclaw/openclaw/pull/99312)

**Bug fixes**

- Prevent Mattermost hooks from leaking pre-rewrite previews [#114968](https://github.com/openclaw/openclaw/pull/114968)
- Preserve Mattermost outbound delivery settlement [#116142](https://github.com/openclaw/openclaw/pull/116142)
- Add deadlines to Mattermost REST requests [#102027](https://github.com/openclaw/openclaw/pull/102027)
- Send Mattermost text with blank attachment placeholders [#108281](https://github.com/openclaw/openclaw/pull/108281)
- Keep Mattermost reactions in the selected conversation [#108634](https://github.com/openclaw/openclaw/pull/108634)
- Preserve finalized Mattermost replies after tool warnings [#109555](https://github.com/openclaw/openclaw/pull/109555)
- Preserve received Mattermost posts across restarts [#110386](https://github.com/openclaw/openclaw/pull/110386)
- Preserve policy-safe Mattermost group history [#115773](https://github.com/openclaw/openclaw/pull/115773)
- Honor configured timezones in Mattermost message envelopes [#116145](https://github.com/openclaw/openclaw/pull/116145)
- Keep Mattermost messages isolated by sender [#124531](https://github.com/openclaw/openclaw/pull/124531)
- fix(mattermost): anchor bot mention matching on username boundaries [#129555](https://github.com/openclaw/openclaw/pull/129555)
- fix(mattermost): keep server file name when the download fails [#129556](https://github.com/openclaw/openclaw/pull/129556)
- fix(mattermost): normal replies silently drop buttons and presentation [#129579](https://github.com/openclaw/openclaw/pull/129579)
- Preserve Mattermost block-streamed text and tool posts [#87449](https://github.com/openclaw/openclaw/pull/87449)
- Keep Mattermost private-channel threads in one conversation [#96645](https://github.com/openclaw/openclaw/pull/96645)
- Accept Mattermost command-text modes and repair CI [2c95bd2](https://github.com/openclaw/openclaw/commit/2c95bd2)
- Keep emoji intact in Mattermost debug previews [#101630](https://github.com/openclaw/openclaw/pull/101630)
- Bound Mattermost lookup caches [#101740](https://github.com/openclaw/openclaw/pull/101740)
- Keep Mattermost slash-command diagnostics Unicode-safe [#102607](https://github.com/openclaw/openclaw/pull/102607)
- Bound Mattermost opaque-target cache growth [#103258](https://github.com/openclaw/openclaw/pull/103258)
- Stop stalled Mattermost attachments from blocking messages [#104575](https://github.com/openclaw/openclaw/pull/104575)
- Honor configured Mattermost callback bypass paths [#104618](https://github.com/openclaw/openclaw/pull/104618)
- Preserve Mattermost private-conversation origins [#115726](https://github.com/openclaw/openclaw/pull/115726)
- Prevent Mattermost messages from reaching the wrong team's channel [#118622](https://github.com/openclaw/openclaw/pull/118622)
- Preserve file extensions for unnamed Mattermost uploads [#119535](https://github.com/openclaw/openclaw/pull/119535)
- fix(mattermost): agent media replies silently drop the attachment when upload fails [#125338](https://github.com/openclaw/openclaw/pull/125338)
- fix(mattermost): react action rejects raw emoji glyphs [#125370](https://github.com/openclaw/openclaw/pull/125370)
- fix(mattermost): surface websocket authentication failures with backoff [#129501](https://github.com/openclaw/openclaw/pull/129501)
- Reject unsafe Mattermost API path segments [#98390](https://github.com/openclaw/openclaw/pull/98390)

</details>

</Accordion>

<Accordion title="Matrix">

[Matrix](/channels/matrix) replies can now use native spoilers, underline, tables, and up to 100 discoverable room or personal custom emotes. More importantly, an encrypted room now fails visibly when encryption is unavailable instead of quietly falling back to plaintext text, attachments, filenames, or media metadata. Large tables can still choose their own readable formatting fallback without weakening the room's confidentiality boundary.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add native Matrix spoilers, underline, and tables [#113199](https://github.com/openclaw/openclaw/pull/113199)
- Matrix custom emote discovery and cached Discord emoji lists [#128518](https://github.com/openclaw/openclaw/pull/128518)
- Move Matrix replay protection to the shared dedupe system [#104391](https://github.com/openclaw/openclaw/pull/104391)
- Add safer Matrix recovery-key input and split E2EE QA ownership [#107828](https://github.com/openclaw/openclaw/pull/107828)

**Bug fixes**

- Migrate Matrix dedupe state without rescanning old databases [#113487](https://github.com/openclaw/openclaw/pull/113487)
- Block plaintext Matrix sends to encrypted rooms [#118609](https://github.com/openclaw/openclaw/pull/118609)
- Stop Matrix startup identity retries during shutdown [#110115](https://github.com/openclaw/openclaw/pull/110115)
- Preserve Matrix thread pagination tokens [#111243](https://github.com/openclaw/openclaw/pull/111243)
- Preserve Matrix encryption keys during legacy snapshot upgrades [#112919](https://github.com/openclaw/openclaw/pull/112919)
- Skip historical Matrix roots on settled restarts [#113489](https://github.com/openclaw/openclaw/pull/113489)
- Render Matrix history and collapse streamed edits [#115014](https://github.com/openclaw/openclaw/pull/115014)
- Hide Matrix drafts when outbound hooks can modify replies [#115240](https://github.com/openclaw/openclaw/pull/115240)
- Prevent private reasoning from reaching Matrix rooms [#115553](https://github.com/openclaw/openclaw/pull/115553)
- Report Matrix automatic reply delivery settlement [#116271](https://github.com/openclaw/openclaw/pull/116271)
- Preserve Matrix thread and session ownership [#116802](https://github.com/openclaw/openclaw/pull/116802)
- Fix Matrix audio durations, reaction paging, and member names [#116890](https://github.com/openclaw/openclaw/pull/116890)
- Recover Matrix durable sends after lost success responses [#117008](https://github.com/openclaw/openclaw/pull/117008)
- Reply to valid plain-text Matrix mentions [#117764](https://github.com/openclaw/openclaw/pull/117764)
- Preserve complete Matrix multipart delivery receipts [#118128](https://github.com/openclaw/openclaw/pull/118128)
- Preserve indented Matrix code without sending mentions [#118497](https://github.com/openclaw/openclaw/pull/118497)
- Make Matrix encrypted-client shutdown deterministic [#119570](https://github.com/openclaw/openclaw/pull/119570)
- Isolate shared Matrix clients across accounts [#119667](https://github.com/openclaw/openclaw/pull/119667)
- Preserve Matrix delivery identity across attachment fanout [#121006](https://github.com/openclaw/openclaw/pull/121006)
- Keep Matrix streamed replies visible when replacement fails [#122850](https://github.com/openclaw/openclaw/pull/122850)
- fix(matrix): guard malformed poll answers instead of throwing TypeError [#123231](https://github.com/openclaw/openclaw/pull/123231)
- Accept suffixless Matrix Room v12 IDs [#123931](https://github.com/openclaw/openclaw/pull/123931)
- Recover Matrix providers after disconnected sync restarts [#125362](https://github.com/openclaw/openclaw/pull/125362)
- Restore Matrix retries after late operations finish [#126712](https://github.com/openclaw/openclaw/pull/126712)
- fix(matrix): prevent poll history from hanging on repeated cursors [#128214](https://github.com/openclaw/openclaw/pull/128214)
- fix(matrix): preserve escaped characters, links, and image labels [#128382](https://github.com/openclaw/openclaw/pull/128382)
- fix(matrix): send fallback media when attachment list is blank [#128479](https://github.com/openclaw/openclaw/pull/128479)
- fix(matrix): show edited messages in replies and thread context [#128763](https://github.com/openclaw/openclaw/pull/128763)
- fix(matrix): let follow-ups steer active turns [#128907](https://github.com/openclaw/openclaw/pull/128907)
- fix(matrix): preserve explicit replies when threading is disabled [#129415](https://github.com/openclaw/openclaw/pull/129415)
- fix(matrix): preserve approval reactions after Gateway failures [#129879](https://github.com/openclaw/openclaw/pull/129879)
- fix(matrix): preserve attachment markers in room history [#130123](https://github.com/openclaw/openclaw/pull/130123)
- fix(matrix): automatic replies lose native table formatting [#130820](https://github.com/openclaw/openclaw/pull/130820)
- fix(sessions): preserve distinct rooms during canonical updates [#132242](https://github.com/openclaw/openclaw/pull/132242)
- Preserve Matrix reverse-proxy homeserver paths [#93516](https://github.com/openclaw/openclaw/pull/93516)
- Recover Matrix messages when decryption keys arrive late [#94416](https://github.com/openclaw/openclaw/pull/94416)
- Keep truncated Matrix text UTF-16 safe [#102395](https://github.com/openclaw/openclaw/pull/102395)
- Parse mixed-case Matrix JSON response types correctly [#105470](https://github.com/openclaw/openclaw/pull/105470)
- Preserve valid UTF-8 in Matrix bootstrap diagnostics [#105475](https://github.com/openclaw/openclaw/pull/105475)
- Restore Matrix draft previews for queued followups [#108094](https://github.com/openclaw/openclaw/pull/108094)
- Reject oversized piped Matrix recovery keys [#108120](https://github.com/openclaw/openclaw/pull/108120)
- Preserve Matrix redirects when response cleanup fails [#111105](https://github.com/openclaw/openclaw/pull/111105)
- Accept the documented automatic Matrix approval mode [#115676](https://github.com/openclaw/openclaw/pull/115676)
- Surface Matrix typing refresh failures after delivery [#117059](https://github.com/openclaw/openclaw/pull/117059)
- Ignore invalid Matrix environment account escapes [#120428](https://github.com/openclaw/openclaw/pull/120428)
- Let Matrix send media when mediaMaxMb is zero or negative [#120466](https://github.com/openclaw/openclaw/pull/120466)
- Authenticate Matrix channel probes before reporting success [#123766](https://github.com/openclaw/openclaw/pull/123766)
- Preserve Matrix thread activity through clean shutdown [#125039](https://github.com/openclaw/openclaw/pull/125039)
- fix(matrix): await persistence shutdown [#129605](https://github.com/openclaw/openclaw/pull/129605)
- fix(matrix): preserve encrypted attachments with blank media URLs [#129739](https://github.com/openclaw/openclaw/pull/129739)
- fix(matrix): accept env SecretRefs with shared default aliases [#132352](https://github.com/openclaw/openclaw/pull/132352)

</details>

</Accordion>

<Accordion title="Microsoft Teams">

Configured [Microsoft Teams](/channels/msteams) approvers can approve or deny eligible exec and plugin requests from a native Adaptive Card in the chat or channel thread where the request began, then see the recorded outcome on that same card. Quoted replies, attachments, streaming results, and duplicate handling also stay bound to the originating conversation. The cards cover configured exec and plugin requests only and require valid authentication, permissions, tenant authorization, and routing.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- feat(msteams): native Adaptive Card approve/deny for exec and plugin approvals [#129997](https://github.com/openclaw/openclaw/pull/129997)

**Bug fixes**

- fix(channels): degrade unavailable credential files [#127539](https://github.com/openclaw/openclaw/pull/127539)
- Restore quoted message context in Microsoft Teams replies [#101856](https://github.com/openclaw/openclaw/pull/101856)
- Preserve Teams stream chunks after whitespace collapse [#102357](https://github.com/openclaw/openclaw/pull/102357)
- Recognize mixed-case Microsoft Teams attachments [#102431](https://github.com/openclaw/openclaw/pull/102431)
- Bound stalled Microsoft Teams file-consent uploads [#104120](https://github.com/openclaw/openclaw/pull/104120)
- Bound MS Teams SharePoint file sends and fail closed on sharing errors [#104288](https://github.com/openclaw/openclaw/pull/104288)
- Bound Microsoft Teams token acquisition to a deadline [#106386](https://github.com/openclaw/openclaw/pull/106386)
- Ignore blank Microsoft Teams certificate paths [#109112](https://github.com/openclaw/openclaw/pull/109112)
- Preserve Microsoft Teams activities before acknowledgement [#110357](https://github.com/openclaw/openclaw/pull/110357)
- Preserve same-named Teams SharePoint uploads [#113560](https://github.com/openclaw/openclaw/pull/113560)
- Prevent Microsoft Teams previews from bypassing outbound hooks [#115551](https://github.com/openclaw/openclaw/pull/115551)
- Prevent duplicate long replies after Teams streaming failures [#115669](https://github.com/openclaw/openclaw/pull/115669)
- Restore Microsoft Teams conversation allowlists [#115746](https://github.com/openclaw/openclaw/pull/115746)
- Prevent duplicate Microsoft Teams final replies [#116398](https://github.com/openclaw/openclaw/pull/116398)
- Preserve acknowledged Microsoft Teams stream settlement [#116515](https://github.com/openclaw/openclaw/pull/116515)
- Keep Microsoft Teams cards and polls in channel threads [#117516](https://github.com/openclaw/openclaw/pull/117516)
- Deliver approved workspace attachments in Microsoft Teams [#117776](https://github.com/openclaw/openclaw/pull/117776)
- Release channel delivery resources reliably [#117855](https://github.com/openclaw/openclaw/pull/117855)
- Honor Teams channel limits for inbound attachments [#122315](https://github.com/openclaw/openclaw/pull/122315)
- Preserve distinct choices in Microsoft Teams poll votes [#123070](https://github.com/openclaw/openclaw/pull/123070)
- Avoid duplicate Teams replies after uncertain delivery failures [#125127](https://github.com/openclaw/openclaw/pull/125127)
- Preserve Microsoft Teams reply context after durable replay [#126169](https://github.com/openclaw/openclaw/pull/126169)
- fix(msteams): restore missing channel thread context [#128901](https://github.com/openclaw/openclaw/pull/128901)
- fix(msteams): retain legacy stores until migrations prove survivors [#131284](https://github.com/openclaw/openclaw/pull/131284)
- Recover Microsoft Teams channel and group-chat files safely [#90738](https://github.com/openclaw/openclaw/pull/90738)
- Bound the Microsoft Teams group lookup cache [#102814](https://github.com/openclaw/openclaw/pull/102814)
- Share HTML entity decoding across core and plugins [#107235](https://github.com/openclaw/openclaw/pull/107235)
- Show readable filenames for URL-hosted Microsoft Teams attachments [#115127](https://github.com/openclaw/openclaw/pull/115127)
- Recognize provider-prefixed Microsoft Teams target IDs [#115609](https://github.com/openclaw/openclaw/pull/115609)
- Enable Microsoft Teams after accepting federated credentials [#118931](https://github.com/openclaw/openclaw/pull/118931)
- Return invalid-request errors for incompatible Teams probe modes [#121975](https://github.com/openclaw/openclaw/pull/121975)
- Finalize Microsoft Teams sent events after delivery settles [#82354](https://github.com/openclaw/openclaw/pull/82354)
- Keep Microsoft Teams attachment replies in channel threads [#94348](https://github.com/openclaw/openclaw/pull/94348)

</details>

</Accordion>

<Accordion title="Google Chat">

[Google Chat](/channels/googlechat) webhook events accepted by OpenClaw now remain queued through restarts, keep their order within each space, and recognize Google's retries before they create duplicate work. Recovery begins when the Gateway admits the event; events Google never delivered remain outside that recovery path.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Bug fixes**

- Preserve Google Chat webhooks across restarts [#110833](https://github.com/openclaw/openclaw/pull/110833)
- Stop stalled Google Chat requests from hanging indefinitely [#102227](https://github.com/openclaw/openclaw/pull/102227)
- Keep Google Chat off-mode replies out of threads [#104402](https://github.com/openclaw/openclaw/pull/104402)
- Preserve Google Chat streaming during doctor migration [#106018](https://github.com/openclaw/openclaw/pull/106018)
- Bound Google Chat authentication requests [#106178](https://github.com/openclaw/openclaw/pull/106178)
- Deliver Google Chat replies when thread targets are invalid [#108324](https://github.com/openclaw/openclaw/pull/108324)
- Release Google Chat sockets after status-only requests [#111290](https://github.com/openclaw/openclaw/pull/111290)
- Render outbound Markdown correctly in Google Chat [#113024](https://github.com/openclaw/openclaw/pull/113024)
- Stop partial and duplicate Google Chat replies [#115638](https://github.com/openclaw/openclaw/pull/115638)
- Keep Google Chat reply chunks in one fallback thread [#117053](https://github.com/openclaw/openclaw/pull/117053)
- Keep Google Chat Doctor repairs in canonical account settings [#118972](https://github.com/openclaw/openclaw/pull/118972)
- Keep Google Chat lanes moving after oversized attachments [#118986](https://github.com/openclaw/openclaw/pull/118986)
- Reject malformed UTF-8 in Google Chat responses [#120239](https://github.com/openclaw/openclaw/pull/120239)
- Preserve partial Google Chat delivery evidence [#122760](https://github.com/openclaw/openclaw/pull/122760)
- fix(googlechat): surface unsupported and unprocessed attachments [#130870](https://github.com/openclaw/openclaw/pull/130870)
- Cap Google Chat media downloads by default [#98425](https://github.com/openclaw/openclaw/pull/98425)
- Bound Google Chat approval registries [#101744](https://github.com/openclaw/openclaw/pull/101744)
- Bound Google Chat webhook certificate fetches [#102924](https://github.com/openclaw/openclaw/pull/102924)
- Close oversized Google Chat auth responses promptly [#115873](https://github.com/openclaw/openclaw/pull/115873)
- Preserve canonical Google Chat thread IDs in delivery receipts [#116717](https://github.com/openclaw/openclaw/pull/116717)
- Report invalid Google Chat webhook URLs as blocked [#117986](https://github.com/openclaw/openclaw/pull/117986)
- Stop stale Google Chat approval cards from retrying [#118225](https://github.com/openclaw/openclaw/pull/118225)
- Block unusable Google Chat webhook configurations at startup [#118968](https://github.com/openclaw/openclaw/pull/118968)

</details>

</Accordion>

<Accordion title="LINE">

[LINE](/channels/line) keeps mixed rich replies, their quick actions, and media together, using the reply path for as many as five messages when the response fits instead of consuming Push API quota unnecessarily. Long code that will not fit a Flex card falls back to ordinary chunks, unsupported media remains visible as a link, and blank or rejected rich structures no longer take the whole reply with them.

In groups that require a mention, slash commands addressed to the bot now run as commands, and quoting one of its recent Gateway-sent messages can address it without a second mention. Date, time, and rich-menu selections reach the agent, while supported actions and choices return as native controls with visible text for anything LINE cannot render.

A bot can also post one room-specific introduction when it actually joins an allowed group, while respecting both channel-wide and per-account opt-outs. Webhook events are stored before acknowledgement so work OpenClaw already admitted can continue after a restart. Affected installations that passed through the brief pre-drain queue transition migrate eligible accepted rows before delivery resumes, while genuinely mismatched rows remain quarantined and messages for removed accounts wait until that account is restored.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- feat(channels): add Matrix and LINE join introductions [#131128](https://github.com/openclaw/openclaw/pull/131128)
- Move LINE rich messages to typed structured output [#124755](https://github.com/openclaw/openclaw/pull/124755)

**Bug fixes**

- Keep LINE rich replies and quick actions intact [#109011](https://github.com/openclaw/openclaw/pull/109011)
- Prevent LINE webhook events from being silently lost [#109655](https://github.com/openclaw/openclaw/pull/109655)
- fix(line): migrate pre-drain spool rows to the canonical queue contract on upgrade [#110058](https://github.com/openclaw/openclaw/pull/110058)
- Prevent duplicate accepted LINE and Mattermost messages [#117024](https://github.com/openclaw/openclaw/pull/117024)
- fix(line): run group slash commands sent with the bot's mention [#131838](https://github.com/openclaw/openclaw/pull/131838)
- Keep internal tool traces out of LINE replies [#101708](https://github.com/openclaw/openclaw/pull/101708)
- Keep malformed LINE agenda and device cards from being dropped [#105381](https://github.com/openclaw/openclaw/pull/105381)
- Preserve LINE replies when template fields are blank [#105520](https://github.com/openclaw/openclaw/pull/105520)
- fix: keep LINE group allowlists scoped [AI] [#106056](https://github.com/openclaw/openclaw/pull/106056)
- Send playable LINE video and audio replies [#106515](https://github.com/openclaw/openclaw/pull/106515)
- Prevent inline slash text from bypassing LINE group mentions [#107230](https://github.com/openclaw/openclaw/pull/107230)
- Preserve LINE group context during concurrent mention turns [#107367](https://github.com/openclaw/openclaw/pull/107367)
- Retry LINE media while the content is still preparing [#108351](https://github.com/openclaw/openclaw/pull/108351)
- Redact LINE media URLs from validation errors [#108657](https://github.com/openclaw/openclaw/pull/108657)
- Bound LINE sender-profile cache growth [#109750](https://github.com/openclaw/openclaw/pull/109750)
- Preserve LINE webhooks through restarts and dispatch failures [#109819](https://github.com/openclaw/openclaw/pull/109819)
- Wait for deferred LINE ingress release during shutdown [#110104](https://github.com/openclaw/openclaw/pull/110104)
- Retry transient LINE inbound-media downloads [#110921](https://github.com/openclaw/openclaw/pull/110921)
- Prevent LINE reloads from hanging on stalled deliveries [#110971](https://github.com/openclaw/openclaw/pull/110971)
- Keep oversized LINE actions from dropping replies [#113081](https://github.com/openclaw/openclaw/pull/113081)
- Mark durably accepted LINE webhook deliveries [#115796](https://github.com/openclaw/openclaw/pull/115796)
- Preserve LINE provider delivery receipts and partial-send progress [#116879](https://github.com/openclaw/openclaw/pull/116879)
- Prevent duplicate LINE replies after uncertain delivery [#117126](https://github.com/openclaw/openclaw/pull/117126)
- Preserve longer LINE card and template descriptions [#117280](https://github.com/openclaw/openclaw/pull/117280)
- Preserve oversized LINE table delivery order [#117335](https://github.com/openclaw/openclaw/pull/117335)
- Preserve all rows in LINE markdown tables [#117481](https://github.com/openclaw/openclaw/pull/117481)
- Preserve LINE replies when location fields are blank [#118064](https://github.com/openclaw/openclaw/pull/118064)
- fix(line): prevent unbounded provider response buffering [#119099](https://github.com/openclaw/openclaw/pull/119099)
- Keep non-positive LINE media limits from dropping attachments [#121184](https://github.com/openclaw/openclaw/pull/121184)
- Retry LINE pushes without duplicate messages [#124464](https://github.com/openclaw/openclaw/pull/124464)
- Prevent LINE inbound media downloads from hanging [#124606](https://github.com/openclaw/openclaw/pull/124606)
- fix(line): preserve full Flex action labels up to LINE's limit [#128712](https://github.com/openclaw/openclaw/pull/128712)
- fix(line): preserve rich message source order [#129916](https://github.com/openclaw/openclaw/pull/129916)
- fix(line): preserve quick replies after rejected rich messages [#130076](https://github.com/openclaw/openclaw/pull/130076)
- fix(line): /card splits an action, list item, or receipt entry at a comma inside its data [#131195](https://github.com/openclaw/openclaw/pull/131195)
- fix(line): a permanently refused message is replayed instead of settling [#131285](https://github.com/openclaw/openclaw/pull/131285)
- fix(line): stop blank card fields from losing the whole reply [#131854](https://github.com/openclaw/openclaw/pull/131854)
- fix(line): give the agent the selection a postback carries [#132014](https://github.com/openclaw/openclaw/pull/132014)
- fix(line): let a quote of the bot address it in a group [#132055](https://github.com/openclaw/openclaw/pull/132055)
- fix(line): give the agent the names LINE knows, not raw ids [#132108](https://github.com/openclaw/openclaw/pull/132108)
- fix(line): retire the credential a rotation replaces [#132150](https://github.com/openclaw/openclaw/pull/132150)
- fix(line): deliver the controls an agent reply offers [#132479](https://github.com/openclaw/openclaw/pull/132479)
- fix(line): send outbound media as the kind its URL proves [#132551](https://github.com/openclaw/openclaw/pull/132551)
- fix(line): deliver a code block the Flex card cannot hold [#132558](https://github.com/openclaw/openclaw/pull/132558)
- Keep emoji intact in LINE invalid-recipient errors [#104109](https://github.com/openclaw/openclaw/pull/104109)
- Enable in-chat LINE allowlist edits [#106638](https://github.com/openclaw/openclaw/pull/106638)
- Validate LINE media before batch and auto-reply sends [#108917](https://github.com/openclaw/openclaw/pull/108917)
- Preserve links and styling in LINE messages [#112921](https://github.com/openclaw/openclaw/pull/112921)
- Preserve structured LINE webhook error details [#113606](https://github.com/openclaw/openclaw/pull/113606)
- Preserve full LINE Flex alternative text [#117217](https://github.com/openclaw/openclaw/pull/117217)
- Preserve indentation in LINE fenced-code cards [#117996](https://github.com/openclaw/openclaw/pull/117996)
- Fully remove the default LINE account [#118055](https://github.com/openclaw/openclaw/pull/118055)
- Deliver unrenderable LINE locations as text [#126298](https://github.com/openclaw/openclaw/pull/126298)
- fix(line): describe inbound stickers from what LINE actually sends [#131872](https://github.com/openclaw/openclaw/pull/131872)
- fix(line): apply a group's configured skill scope [#132501](https://github.com/openclaw/openclaw/pull/132501)
- fix(line): handle each event with the config that is live for it [#132592](https://github.com/openclaw/openclaw/pull/132592)

**Documentation**

- docs(line): document inbound durability, retry policy, and dead-letter recovery [#115702](https://github.com/openclaw/openclaw/pull/115702)

</details>

</Accordion>

<Accordion title="SMS, MMS, and RCS with Twilio">

The [Twilio-backed channel](/channels/sms) can now send and receive MMS and show recent provider or carrier states such as sent, delivered, failed, or conflicted without retaining message bodies or phone-number addresses. SMS and RCS messages OpenClaw has already accepted can survive a restart in sender order, while replay protection fails closed instead of accepting work it can no longer protect from duplication.

Delivery observations are kept for 30 days and reflect the latest state reported by Twilio or a carrier, which can differ from recipient-visible delivery. If the replay cache fills, new events are rejected rather than accepted without duplicate protection, and Twilio does not retry that response by default.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add Twilio MMS support to the SMS channel [#118664](https://github.com/openclaw/openclaw/pull/118664)
- Track Twilio delivery outcomes for SMS [#118665](https://github.com/openclaw/openclaw/pull/118665)

**Bug fixes**

- Durably queue Twilio messages before acknowledging webhooks [#109866](https://github.com/openclaw/openclaw/pull/109866)
- Preserve Twilio replay protection under heavy SMS traffic [#101107](https://github.com/openclaw/openclaw/pull/101107)
- Normalize Twilio RCS senders for SMS routing [#102373](https://github.com/openclaw/openclaw/pull/102373)
- Protect valid SMS callbacks from invalid webhook traffic [#103620](https://github.com/openclaw/openclaw/pull/103620)
- Isolate Twilio SMS webhook quotas by sender [#104862](https://github.com/openclaw/openclaw/pull/104862)
- Prevent zero SMS chunk limits from sending per-character texts [#118158](https://github.com/openclaw/openclaw/pull/118158)
- Retry transient Twilio MMS attachment downloads [#118994](https://github.com/openclaw/openclaw/pull/118994)
- Retry Twilio MMS downloads that stall after headers [#119002](https://github.com/openclaw/openclaw/pull/119002)
- Authorize text slash commands received over SMS [#90998](https://github.com/openclaw/openclaw/pull/90998)
- Ignore blank Twilio SMS account fallbacks [#109149](https://github.com/openclaw/openclaw/pull/109149)
- Accept spaces after SMS phone prefixes [#111111](https://github.com/openclaw/openclaw/pull/111111)

**Documentation**

- Add Twilio A2P setup and delivery troubleshooting guidance [#88743](https://github.com/openclaw/openclaw/pull/88743)

</details>

</Accordion>

<Accordion title="ClickClack">

[ClickClack](/channels/clickclack) can place a team discussion beside an OpenClaw session, giving people somewhere to coordinate around the work without turning the agent's main transcript into a meeting room. Guided and command-line setup, readable discussion names, native command menus, attachments, optional group mention rules, and opt-in progress make that room easier to use while keeping the final answer visible.

Opening a discussion still requires an authorized operator and a reachable ClickClack deployment. Generated names remain best effort, and mention-gated or bot-to-bot conversations have to be enabled deliberately.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add native command menus to ClickClack [#107907](https://github.com/openclaw/openclaw/pull/107907)
- Add guided and command-line ClickClack setup [#108271](https://github.com/openclaw/openclaw/pull/108271)
- Add ClickClack session discussion channels [#111503](https://github.com/openclaw/openclaw/pull/111503)
- Name ClickClack discussions from session titles [#114711](https://github.com/openclaw/openclaw/pull/114711)
- Generate titles before opening ClickClack discussions [#114740](https://github.com/openclaw/openclaw/pull/114740)
- Add ClickClack group mention gating [#115484](https://github.com/openclaw/openclaw/pull/115484)
- Show opt-in native agent progress in ClickClack [#116683](https://github.com/openclaw/openclaw/pull/116683)
- Add guarded bot-to-bot workflows for ClickClack [#119278](https://github.com/openclaw/openclaw/pull/119278)
- Verify ClickClack setup and show the correct next step [#108332](https://github.com/openclaw/openclaw/pull/108332)
- Configure ClickClack with one-time setup codes [#109398](https://github.com/openclaw/openclaw/pull/109398)
- Support ClickClack setup codes on private HTTP servers [#109429](https://github.com/openclaw/openclaw/pull/109429)
- Separate ClickClack's public and private endpoints [#111724](https://github.com/openclaw/openclaw/pull/111724)
- Deliver session changes to plugin services [#114813](https://github.com/openclaw/openclaw/pull/114813)

**Bug fixes**

- Deliver ClickClack attachments and honor model output budgets [#105775](https://github.com/openclaw/openclaw/pull/105775)
- Make ClickClack session discussions open on real deployments [#111685](https://github.com/openclaw/openclaw/pull/111685)
- Bound ClickClack inbound WebSocket frames [#102480](https://github.com/openclaw/openclaw/pull/102480)
- Prevent ClickClack history from replaying after restart [#102486](https://github.com/openclaw/openclaw/pull/102486)
- Sanitize ClickClack assistant text before delivery [#103142](https://github.com/openclaw/openclaw/pull/103142)
- Stop ClickClack promptly during reconnect delay [#108145](https://github.com/openclaw/openclaw/pull/108145)
- Prevent ClickClack reconnects from skipping inbound events [#108577](https://github.com/openclaw/openclaw/pull/108577)
- Support ClickClack v1 exact setup claim URLs [#111927](https://github.com/openclaw/openclaw/pull/111927)
- Keep ClickClack thread replies from disappearing [#117225](https://github.com/openclaw/openclaw/pull/117225)
- Preserve ClickClack managed discussion bindings [#118851](https://github.com/openclaw/openclaw/pull/118851)
- Keep ClickClack discussion rooms across session changes [#119358](https://github.com/openclaw/openclaw/pull/119358)
- Recover ClickClack monitors from stalled WebSocket handshakes [#106485](https://github.com/openclaw/openclaw/pull/106485)
- Show ClickClack discussions in the macOS dashboard [#111883](https://github.com/openclaw/openclaw/pull/111883)
- Use the configured default agent for global ClickClack discussions [#113997](https://github.com/openclaw/openclaw/pull/113997)
- Preserve file extensions for unnamed ClickClack uploads [#119646](https://github.com/openclaw/openclaw/pull/119646)
- Clarify ClickClack command-menu startup errors [#126802](https://github.com/openclaw/openclaw/pull/126802)
- fix(clickclack): stop queued messages after account shutdown [#128672](https://github.com/openclaw/openclaw/pull/128672)

</details>

</Accordion>

<Accordion title="Reef">

Trusted Claws can talk directly through [Reef](/channels/reef), OpenClaw's bundled end-to-end encrypted agent channel, using friend-code pairing, terminal registration and friendship controls, and discovery that keeps an external peer distinct from a local thread. Operators can now add plain-language inbound and outbound sharing rules for their own sensitive topics and named friends, while deterministic denials for secrets and credentials remain in force and changing the rules invalidates pending approvals from the old policy.

When an inbound message needs owner review, that recorded decision now owns later redelivery instead of rerunning the guard until the answer changes, and later inbox messages can keep moving while it waits. Temporary inbound guard failures leave the item parked for another attempt rather than rejecting it, with approved delivery receiving one final guard check and outbound sends still failing fast.

When a peer rejects a message, the sending agent gets bounded feedback and one controlled chance to rephrase before it stops for owner guidance instead of arguing in a loop.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add headless Reef registration and friendship CLI [d361b4c](https://github.com/openclaw/openclaw/commit/d361b4c)
- Bundle the Reef encrypted agent-to-agent channel [#106232](https://github.com/openclaw/openclaw/pull/106232)
- Surface Reef rejections and allow routine agent collaboration [#109160](https://github.com/openclaw/openclaw/pull/109160)
- Separate external conversations from local agent sessions [#109411](https://github.com/openclaw/openclaw/pull/109411)
- feat(reef): operator-configurable sharing rules for the guard [#131167](https://github.com/openclaw/openclaw/pull/131167)
- Notify Reef senders when delivery remains unconfirmed [#110938](https://github.com/openclaw/openclaw/pull/110938)

**Bug fixes**

- Discover trusted Reef peers before first contact [#109905](https://github.com/openclaw/openclaw/pull/109905)
- Stop Reef reconnect loops after channel crashes [#110870](https://github.com/openclaw/openclaw/pull/110870)
- fix(reef): parked owner reviews own inbound delivery instead of re-rolling the guard [#132420](https://github.com/openclaw/openclaw/pull/132420)
- Bound Reef relay JSON response reads [#106456](https://github.com/openclaw/openclaw/pull/106456)
- Send Reef messages through the connected Gateway [#107373](https://github.com/openclaw/openclaw/pull/107373)
- Add a deadline to Reef relay requests [#108333](https://github.com/openclaw/openclaw/pull/108333)
- Reject blank Reef guard credentials at startup [#109667](https://github.com/openclaw/openclaw/pull/109667)
- Bind first turns to directory-discovered Reef peers [#110029](https://github.com/openclaw/openclaw/pull/110029)
- Recover Reef inboxes after gateway restart [#110100](https://github.com/openclaw/openclaw/pull/110100)
- Keep accepted Reef receipts from stalling inbox delivery [#110177](https://github.com/openclaw/openclaw/pull/110177)
- Keep Reef running through startup relay throttling [#110918](https://github.com/openclaw/openclaw/pull/110918)
- Hide internal tool traces in Reef and Zalo Personal replies [#112621](https://github.com/openclaw/openclaw/pull/112621)
- Bind discovered peers after threaded conversations [#125514](https://github.com/openclaw/openclaw/pull/125514)
- Keep Gateway readiness steady during brief Reef reconnects [#126151](https://github.com/openclaw/openclaw/pull/126151)
- fix(reef): stop exposing retired account runtime [#129131](https://github.com/openclaw/openclaw/pull/129131)
- Restore Reef channel configuration discovery [2d5803a](https://github.com/openclaw/openclaw/commit/2d5803a)
- Bound Reef inbox WebSocket frames [#108886](https://github.com/openclaw/openclaw/pull/108886)
- Stop stalled Reef inbox handshakes [#109052](https://github.com/openclaw/openclaw/pull/109052)
- refactor(reef): drop hand-maintained manifest schema copies [#131292](https://github.com/openclaw/openclaw/pull/131292)

**Documentation**

- Add Reef channel setup and plugin documentation [4a7f8c5](https://github.com/openclaw/openclaw/commit/4a7f8c5)

</details>

</Accordion>

<Accordion title="Agent-to-Agent Messaging with A2A">

OpenClaw can now expose selected agents to explicitly trusted external agent systems through the [A2A v1.0 protocol](/channels/a2a). Configured peers can discover those agents, submit and poll authenticated tasks, receive replies as artifacts, and exchange text or structured data, while an unconfigured plugin registers no discovery or task routes at all.

This first version supports one account, keeps tasks in memory, and does not yet provide streaming, push notifications, or cancellation. Authenticated peers currently operate as trusted callers rather than passing through the normal command-policy decision, so this is a deliberate interoperability path for known peers rather than a public agent endpoint.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- feat(a2a): add A2A v1.0 agent-interop channel plugin [#130008](https://github.com/openclaw/openclaw/pull/130008)

**Bug fixes**

- fix(a2a): bound outbound JSON response bodies [#132273](https://github.com/openclaw/openclaw/pull/132273)
- fix(a2a): close request connections after outbound sends [#130873](https://github.com/openclaw/openclaw/pull/130873)

</details>

</Accordion>

<Accordion title="Buzz">

[Buzz](/channels/buzz) is now an official OpenClaw channel for team rooms, with guided setup that can route different rooms to different agents and live directories that give those agents current room and member names without replacing the stable UUIDs used for automation. One Gateway can now run named Buzz accounts with separate bot identities, credentials, rooms, routing, and lifecycles while preserving the legacy root account and environment fallback, and updating one account does not unnecessarily disconnect healthy siblings.

Replies can use native mentions and threads, and operators can choose flat automatic replies and typing while explicit message-tool and CLI targets remain explicit. Mention-gated rooms can carry a small amount of recent authorized context into the next turn without running the model on every background message.

Setup finishes only after Bot-role membership is verified, a room name must resolve uniquely before it can be used safely, native mentions cap at 50, and passive context remains opt-in and tightly bounded.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add the official Buzz team-room channel [#113419](https://github.com/openclaw/openclaw/pull/113419)
- Add live Buzz directory and recognizable sender and room names [#116799](https://github.com/openclaw/openclaw/pull/116799)
- Add native Buzz mentions and room-name targeting [#117927](https://github.com/openclaw/openclaw/pull/117927)
- feat(buzz): retain bounded passive context for accepted turns [#130509](https://github.com/openclaw/openclaw/pull/130509)
- feat(buzz): preserve bot identities when adding named accounts [#132226](https://github.com/openclaw/openclaw/pull/132226)
- Improve Buzz message fidelity [#116096](https://github.com/openclaw/openclaw/pull/116096)
- Show typing indicators during Buzz replies [#116194](https://github.com/openclaw/openclaw/pull/116194)
- feat(buzz): authorize different senders in each room [#129655](https://github.com/openclaw/openclaw/pull/129655)
- feat(buzz): bound bot-to-bot room conversations [#130488](https://github.com/openclaw/openclaw/pull/130488)
- feat(buzz): support flat automatic replies and typing [#130511](https://github.com/openclaw/openclaw/pull/130511)

**Bug fixes**

- Recover complete Buzz message backlogs after reconnect [#116925](https://github.com/openclaw/openclaw/pull/116925)
- fix: Buzz bots recover relay stalls and reject revoked senders [#130467](https://github.com/openclaw/openclaw/pull/130467)
- fix(buzz): messages sent during Gateway downtime are dropped after restart [#117259](https://github.com/openclaw/openclaw/pull/117259)
- fix(buzz): bound NIP-11 relay information responses [#119182](https://github.com/openclaw/openclaw/pull/119182)
- fix(buzz): stop named account setup from replacing the existing bot identity [#129663](https://github.com/openclaw/openclaw/pull/129663)
- fix(buzz): keep agent replies at thread root [#124884](https://github.com/openclaw/openclaw/pull/124884)
- fix(buzz): persist account names during noninteractive setup [#131997](https://github.com/openclaw/openclaw/pull/131997)

**Documentation**

- Streamline the Buzz plugin setup guide [#114156](https://github.com/openclaw/openclaw/pull/114156)

</details>

</Accordion>

<Accordion title="QQ Bot">

[QQ Bot](/channels/qqbot) has moved to Tencent's integrity-pinned external plugin while keeping the public `qqbot` channel ID and carrying existing credentials, account selection, allowlists, approval restrictions, streaming behavior, and group tool policy when Tencent 2.0 can represent them safely. If an older policy cannot be translated without weakening it, Doctor stops for an explicit repair instead of quietly changing the rules. Inbound envelopes already accepted into the local queue can also resume after a restart.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Move QQBot to Tencent's external plugin [#107295](https://github.com/openclaw/openclaw/pull/107295)

**Bug fixes**

- Add durable inbound replay for QQBot [#110844](https://github.com/openclaw/openclaw/pull/110844)
- Stop stalled QQBot speech transcription requests [#102028](https://github.com/openclaw/openclaw/pull/102028)
- Wrap QQ Bot approval commands safely [#102119](https://github.com/openclaw/openclaw/pull/102119)
- Classify QQ Bot media types case-insensitively [#102753](https://github.com/openclaw/openclaw/pull/102753)
- Preserve canonical MIME types for QQBot images [#102795](https://github.com/openclaw/openclaw/pull/102795)
- Use the core typing keepalive loop in QQBot [#104438](https://github.com/openclaw/openclaw/pull/104438)
- Keep long QQBot replies within the passive-send limit [#104634](https://github.com/openclaw/openclaw/pull/104634)
- Stop QQBot token refresh listener buildup [#105886](https://github.com/openclaw/openclaw/pull/105886)
- Time out stalled QQBot channel API response bodies [#108895](https://github.com/openclaw/openclaw/pull/108895)
- Ignore blank QQBot application IDs [#109460](https://github.com/openclaw/openclaw/pull/109460)
- Prevent replayed QQBot commands from clearing storage twice [#110904](https://github.com/openclaw/openclaw/pull/110904)
- Apply QQBot access policy to quoted message context [#114136](https://github.com/openclaw/openclaw/pull/114136)
- Keep QQBot routing on the live runtime configuration [#114227](https://github.com/openclaw/openclaw/pull/114227)
- Reconnect QQBot when heartbeat ACKs stop [#114902](https://github.com/openclaw/openclaw/pull/114902)
- Restore one-time and recurring QQBot reminders [#115488](https://github.com/openclaw/openclaw/pull/115488)
- Keep QQBot channel API calls on the active account [#118575](https://github.com/openclaw/openclaw/pull/118575)
- Keep partial QQBot credential edits from restoring stale backups [#120028](https://github.com/openclaw/openclaw/pull/120028)
- Keep QQBot connected after malformed gateway HELLO frames [#121031](https://github.com/openclaw/openclaw/pull/121031)
- Bound stalled QQBot token requests [#102897](https://github.com/openclaw/openclaw/pull/102897)
- Prevent QQBot media downloads from hanging before response headers [#103018](https://github.com/openclaw/openclaw/pull/103018)
- Time out stalled QQBot response bodies [#103855](https://github.com/openclaw/openclaw/pull/103855)
- Clear QQBot voice-send timers after delivery settles [#105885](https://github.com/openclaw/openclaw/pull/105885)
- Recover QQBot from stalled WebSocket handshakes [#106484](https://github.com/openclaw/openclaw/pull/106484)
- Route mixed-case QQBot group and channel targets correctly [#109008](https://github.com/openclaw/openclaw/pull/109008)
- Reject blank QQ Bot client-secret environment values [#109815](https://github.com/openclaw/openclaw/pull/109815)
- Bound QQ Bot client-secret file reads [#110002](https://github.com/openclaw/openclaw/pull/110002)
- Return QQ Bot media download errors promptly [#119466](https://github.com/openclaw/openclaw/pull/119466)
- Remove misleading QQBot data-directory diagnostics [#119849](https://github.com/openclaw/openclaw/pull/119849)
- Preserve QQ Bot group announcement routes [#98053](https://github.com/openclaw/openclaw/pull/98053)

**Documentation**

- Correct QQBot installation package documentation [#122417](https://github.com/openclaw/openclaw/pull/122417)

</details>

</Accordion>

<Accordion title="Zalo and Zalo Personal">

[Zalo Bot](/channels/zalo) and [Zalo Personal](/channels/zalouser) now keep accepted messages through restarts using separate recovery paths. Zalo Bot records a webhook before acknowledging it, while Zalo Personal resumes accepted socket messages from its account queue without one delayed conversation holding up unrelated chats. Polling and webhook modes remain mutually exclusive, and targeting, reactions, formatting, delivery errors, and partial receipts remain specific to the path that handled the message.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Recover accepted Zalo Personal messages after local crashes [#110916](https://github.com/openclaw/openclaw/pull/110916)

**Bug fixes**

- Prevent Zalo webhook message loss after acknowledgment [#110630](https://github.com/openclaw/openclaw/pull/110630)
- Hide internal tool traces from Zalo replies [#103377](https://github.com/openclaw/openclaw/pull/103377)
- Share offset-preserving text chunk ranges for Zalouser [#105842](https://github.com/openclaw/openclaw/pull/105842)
- Bound stalled Zalo Bot API requests [#111636](https://github.com/openclaw/openclaw/pull/111636)
- Make ZaloUser emphasis follow CommonMark rules [#113134](https://github.com/openclaw/openclaw/pull/113134)
- Align ZaloUser block formatting with CommonMark [#113590](https://github.com/openclaw/openclaw/pull/113590)
- Send Zalo text when optional media is blank [#114450](https://github.com/openclaw/openclaw/pull/114450)
- Surface Zalo delivery failures and preserve partial-send receipts [#117864](https://github.com/openclaw/openclaw/pull/117864)
- Route Zalouser reactions to the correct conversation [#118536](https://github.com/openclaw/openclaw/pull/118536)
- fix(zalo): bound stalled inbound media header waits [#104578](https://github.com/openclaw/openclaw/pull/104578)
- Stop Zalo polling backoff immediately on abort [#106498](https://github.com/openclaw/openclaw/pull/106498)
- Report unsupported Zalo message actions correctly [#108434](https://github.com/openclaw/openclaw/pull/108434)
- Distinguish Zalouser probe timeouts from missing authentication [#111336](https://github.com/openclaw/openclaw/pull/111336)
- Stop Zalo startup when Gateway shutdown already won [#115763](https://github.com/openclaw/openclaw/pull/115763)
- Deliver Zalo messages to prefixed direct and group targets [#115814](https://github.com/openclaw/openclaw/pull/115814)
- Report ZaloUser delivery failures and preserve partial receipts [#117860](https://github.com/openclaw/openclaw/pull/117860)
- Restore Zalo media when its size limit is non-positive [#120988](https://github.com/openclaw/openclaw/pull/120988)
- Report failed Zalo HTTP probes as unhealthy [#124593](https://github.com/openclaw/openclaw/pull/124593)

</details>

</Accordion>

<Accordion title="Tlon and Urbit">

[Tlon](/channels/tlon) now saves an accepted Urbit message before acknowledging it, so work already admitted to OpenClaw can resume after a restart without immediately abandoning the server cursor. Replies gain native Markdown lists, and oversized SSE events or JSON payloads stop before they can grow in memory without bound.

There is one hard recovery limit. If Eyre has definitively deleted a channel, OpenClaw can create and subscribe to another one, but the old cursor and its server-side history are gone.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Preserve accepted Tlon messages across restarts [#110910](https://github.com/openclaw/openclaw/pull/110910)
- Render Markdown lists natively in Tlon replies [#112968](https://github.com/openclaw/openclaw/pull/112968)

**Bug fixes**

- Bound Tlon SSE events to prevent memory exhaustion [#101274](https://github.com/openclaw/openclaw/pull/101274)
- Keep internal tool traces out of Tlon messages [#103450](https://github.com/openclaw/openclaw/pull/103450)
- Bound long-running Tlon monitor tracking [#103658](https://github.com/openclaw/openclaw/pull/103658)
- Clear Tlon SSE timers after failed connections [#104585](https://github.com/openclaw/openclaw/pull/104585)
- Send fragment-bearing Tlon image URLs as media [#104853](https://github.com/openclaw/openclaw/pull/104853)
- Stop Tlon reconnects after monitoring ends [#108168](https://github.com/openclaw/openclaw/pull/108168)
- Bound Tlon login response memory use [#109697](https://github.com/openclaw/openclaw/pull/109697)
- Close failed Tlon upload response streams [#110442](https://github.com/openclaw/openclaw/pull/110442)
- Release unread Tlon HTTP and SSE bodies [#111275](https://github.com/openclaw/openclaw/pull/111275)
- Prevent Tlon monitor shutdown hangs during startup [#114940](https://github.com/openclaw/openclaw/pull/114940)
- Honor the configured timezone in Tlon summaries [#117429](https://github.com/openclaw/openclaw/pull/117429)
- Close failed Tlon connections without leaking sockets [#117475](https://github.com/openclaw/openclaw/pull/117475)
- fix(tlon): keep Urbit SSE streams working when data lines omit the space [#130048](https://github.com/openclaw/openclaw/pull/130048)
- fix(tlon): await durable invite side effects [#130329](https://github.com/openclaw/openclaw/pull/130329)
- Clean up Tlon authentication retry listeners [#101661](https://github.com/openclaw/openclaw/pull/101661)
- Bound stalled Tlon file uploads with explicit deadlines [#102903](https://github.com/openclaw/openclaw/pull/102903)
- Bound stalled Tlon media header waits [#104132](https://github.com/openclaw/openclaw/pull/104132)
- Fix Tlon custom S3 endpoint parsing [#107567](https://github.com/openclaw/openclaw/pull/107567)
- Close unread Tlon account-probe response streams [#111081](https://github.com/openclaw/openclaw/pull/111081)
- Prevent Tlon shutdown cleanup from leaking rejections [#111106](https://github.com/openclaw/openclaw/pull/111106)
- Make Tlon probes honor adapter timeouts [#113646](https://github.com/openclaw/openclaw/pull/113646)
- Apply Tlon channel discovery settings live [#114949](https://github.com/openclaw/openclaw/pull/114949)
- Split long Tlon messages into bounded chunks [#117438](https://github.com/openclaw/openclaw/pull/117438)
- Tell Tlon agents when inbound images are unavailable [#122783](https://github.com/openclaw/openclaw/pull/122783)
- fix(tlon): await message persistence before acknowledgement [#129090](https://github.com/openclaw/openclaw/pull/129090)

</details>

</Accordion>

<Accordion title="Nextcloud Talk">

[Nextcloud Talk](/channels/nextcloud-talk) can now process different rooms concurrently while preserving message order within each room. Up to 32 deliveries can be active at once, with excess work queued, and sends or reactions to an unresponsive self-hosted or remote server now fail within a bounded time instead of hanging indefinitely.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Bug fixes**

- Hide internal tool traces in Nextcloud Talk replies [#101712](https://github.com/openclaw/openclaw/pull/101712)
- Allow parallel delivery across Nextcloud Talk rooms [#118692](https://github.com/openclaw/openclaw/pull/118692)
- Bound hanging Nextcloud Talk message and reaction sends [#102025](https://github.com/openclaw/openclaw/pull/102025)
- Bound stalled Nextcloud Talk room lookups [#102859](https://github.com/openclaw/openclaw/pull/102859)
- Keep Nextcloud Talk error snippets Unicode-safe [#102949](https://github.com/openclaw/openclaw/pull/102949)
- Limit Nextcloud Talk actions to supported reactions [#104906](https://github.com/openclaw/openclaw/pull/104906)
- Accept mixed-case Nextcloud Talk target prefixes [#105818](https://github.com/openclaw/openclaw/pull/105818)
- Release failed Nextcloud Talk response bodies [#110441](https://github.com/openclaw/openclaw/pull/110441)
- Reject unsupported Nextcloud Talk setup URLs [#111054](https://github.com/openclaw/openclaw/pull/111054)
- Stop disabled Nextcloud Talk accounts from sending reactions [#112675](https://github.com/openclaw/openclaw/pull/112675)
- Preserve Nextcloud Talk current-room aliases across plugin upgrades [#113432](https://github.com/openclaw/openclaw/pull/113432)
- Prevent shared-proxy Nextcloud Talk webhook lockouts [#126251](https://github.com/openclaw/openclaw/pull/126251)
- fix(nextcloud-talk): dispose webhook auth rate limiter on monitor stop [#126908](https://github.com/openclaw/openclaw/pull/126908)
- fix(nextcloud-talk): record non-outcomes for dropped inbound events [#130974](https://github.com/openclaw/openclaw/pull/130974)

</details>

</Accordion>

<Accordion title="Nostr">

A [Nostr](/channels/nostr) direct message can move to the next configured relay when one cannot connect, return the real connection error when every relay fails, and expose the successful relay's real event ID instead of a synthetic timestamp. Named accounts, protected keys, profile imports, reply targets, and ordered encrypted chunks also stay attached to the selected account more consistently.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Bug fixes**

- Fail over Nostr publishes when a relay cannot connect [#110007](https://github.com/openclaw/openclaw/pull/110007)
- Keep Nostr replies attached to their direct messages [#110085](https://github.com/openclaw/openclaw/pull/110085)
- Reject malformed Nostr profile fields without crashing [#110684](https://github.com/openclaw/openclaw/pull/110684)
- Report unavailable Nostr ingress when its queue cannot open [#115313](https://github.com/openclaw/openclaw/pull/115313)
- Keep private tool traces out of Nostr messages [#115769](https://github.com/openclaw/openclaw/pull/115769)
- Deliver long encrypted Nostr replies as ordered chunks [#115816](https://github.com/openclaw/openclaw/pull/115816)
- Preserve Nostr accounts configured with SecretRefs [#126934](https://github.com/openclaw/openclaw/pull/126934)
- fix(nostr): validate private keys consistently [#130305](https://github.com/openclaw/openclaw/pull/130305)
- Accept uppercase Nostr keys in setup and direct messages [#109878](https://github.com/openclaw/openclaw/pull/109878)
- Report relay event IDs in Nostr send receipts [#110006](https://github.com/openclaw/openclaw/pull/110006)
- Reject non-object Nostr profile metadata safely [#110330](https://github.com/openclaw/openclaw/pull/110330)
- Report Nostr relay connections only after success [#110878](https://github.com/openclaw/openclaw/pull/110878)
- Accept prefixed Nostr targets and allowlist identities [#110881](https://github.com/openclaw/openclaw/pull/110881)
- Preserve named Nostr accounts during setup [#111134](https://github.com/openclaw/openclaw/pull/111134)
- Make Nostr profile imports deterministic across relays [#111798](https://github.com/openclaw/openclaw/pull/111798)
- Stop reporting normal Nostr shutdown as a relay error [#111905](https://github.com/openclaw/openclaw/pull/111905)

</details>

</Accordion>

<Accordion title="Synology Chat">

[Synology Chat](/channels/synology-chat) now records inbound webhook work before returning success, allowing accepted messages to resume after a restart. If the local write fails, OpenClaw returns an error so the sender can redeliver, while the upstream retry remains controlled by Synology. Long Unicode replies keep their order, lookups and responses are bounded, and uncertain outbound sends remain unresolved instead of being replayed into a duplicate.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Preserve Synology Chat webhooks across restarts [#110899](https://github.com/openclaw/openclaw/pull/110899)

**Bug fixes**

- Prevent Synology Chat from sending internal tool traces [#102925](https://github.com/openclaw/openclaw/pull/102925)
- Bound Synology Chat user-list responses [#105089](https://github.com/openclaw/openclaw/pull/105089)
- Deliver long Synology Chat replies in ordered chunks [#116645](https://github.com/openclaw/openclaw/pull/116645)
- Report rejected Synology webhook deliveries [#118558](https://github.com/openclaw/openclaw/pull/118558)
- Prevent duplicate Synology Chat messages after uncertain sends [#119539](https://github.com/openclaw/openclaw/pull/119539)
- Prevent duplicate Synology Chat sends after custody loss [#123953](https://github.com/openclaw/openclaw/pull/123953)
- Isolate Synology webhook throttling by client [#103619](https://github.com/openclaw/openclaw/pull/103619)
- Preserve Unicode Synology reply recipients [#108019](https://github.com/openclaw/openclaw/pull/108019)
- Bound Synology user lookups to 15 seconds [#109111](https://github.com/openclaw/openclaw/pull/109111)
- Bound Synology Chat outgoing response deadlines [#110520](https://github.com/openclaw/openclaw/pull/110520)
- Stop reporting fabricated Synology Chat message IDs [#110770](https://github.com/openclaw/openclaw/pull/110770)

</details>

</Accordion>

<Accordion title="Twitch">

[Twitch](/channels/twitch) chat already accepted into OpenClaw's local queue can continue after a process crash. Stalled user lookups can be cancelled, stopped accounts stay stopped even when an earlier connection attempt finishes late, and ordinary replies keep normalized attachment links while internal tool traces and XML scaffolding are removed before they reach chat.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Bug fixes**

- Recover accepted Twitch chat after local crashes [#110852](https://github.com/openclaw/openclaw/pull/110852)
- Prevent internal tool traces from appearing in Twitch chat [#103109](https://github.com/openclaw/openclaw/pull/103109)
- Preserve emoji in long Twitch replies [#104030](https://github.com/openclaw/openclaw/pull/104030)
- Bound stalled Twitch user lookups [#105883](https://github.com/openclaw/openclaw/pull/105883)
- fix(twitch): prevent stopped accounts from reconnecting after delayed startup [#128909](https://github.com/openclaw/openclaw/pull/128909)
- fix(twitch): normal agent replies silently discard attachments [#129644](https://github.com/openclaw/openclaw/pull/129644)
- fix(twitch): record empty sends as a non-outcome, not a delivery receipt [#131689](https://github.com/openclaw/openclaw/pull/131689)
- Abort stalled Twitch user lookups [#107360](https://github.com/openclaw/openclaw/pull/107360)
- Preserve underscores in Twitch identifiers and URLs [#108548](https://github.com/openclaw/openclaw/pull/108548)
- Prevent retired Twitch chat managers from reconnecting [#127103](https://github.com/openclaw/openclaw/pull/127103)
- fix(twitch): retain native sender identity in execution audits [#130730](https://github.com/openclaw/openclaw/pull/130730)

</details>

</Accordion>

<Accordion title="IRC">

[IRC](/channels/irc) channel messages already admitted to OpenClaw can resume in order after a restart without echoing the bot's own replies back into the room. Direct-message recovery stays tied to the connection that accepted it and stops if that identity changes, while mentions follow IRC nickname rules, Markdown becomes readable plain text, and internal tool traces stay out of the channel.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add durable local ingress for IRC messages [#110914](https://github.com/openclaw/openclaw/pull/110914)

**Bug fixes**

- Hide internal tool traces from IRC replies [#109012](https://github.com/openclaw/openclaw/pull/109012)
- Accept the documented IRC configWrites setting [#112392](https://github.com/openclaw/openclaw/pull/112392)
- Send readable plain text to IRC instead of Markdown source [#112961](https://github.com/openclaw/openclaw/pull/112961)
- Apply RFC 1459 nickname matching to IRC bot mentions [#116758](https://github.com/openclaw/openclaw/pull/116758)

</details>

</Accordion>

<Accordion title="Android Chat">

[Android](/platforms/android) now writes text, images, and voice notes to its outbox before using the network, keeping them through offline periods and restarts until conversation history confirms delivery. If the outcome remains uncertain, the item stays visible with explicit Retry and Delete controls and is not sent again automatically.

Supported audio and video play inline, video uses the native upload flow, and notification replies return to the exact saved conversation or fail. Older 2026.7.x OpenClaw installations use a reduced compatibility path.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Make Android chat sends durable across offline use and restarts [#104089](https://github.com/openclaw/openclaw/pull/104089)
- Play audio and video inside Android chat [#115916](https://github.com/openclaw/openclaw/pull/115916)
- Add inline media playback and video upload on Android [#116037](https://github.com/openclaw/openclaw/pull/116037)
- Add Android conversation notifications with inline Reply [#120389](https://github.com/openclaw/openclaw/pull/120389)

**Bug fixes**

- Stop Android from silently replaying ambiguous sends [#103273](https://github.com/openclaw/openclaw/pull/103273)
- Restore Android chat sends against older gateways [#126540](https://github.com/openclaw/openclaw/pull/126540)
- fix(android): show channel sender name instead of "You" for peer messages [#119864](https://github.com/openclaw/openclaw/pull/119864)
- Cancel Android link preview network calls [#101853](https://github.com/openclaw/openclaw/pull/101853)
- Keep Android offline chat actions readable [#107404](https://github.com/openclaw/openclaw/pull/107404)
- fix(android): current-branch queued input fail after reconnect [#132954](https://github.com/openclaw/openclaw/pull/132954)

</details>

</Accordion>

<Accordion title="iOS and macOS Chat">

The [iOS](/platforms/ios) and [macOS](/platforms/macos) OpenClaw apps can play supported managed audio and video inside chat, upload video from the native composer, and hand the active attachment to system Now Playing controls. A slow accepted reply stays visibly pending while live state and saved history reconcile, so late history cannot clear a newer turn just because it arrived second.

A run that truly produces no output eventually releases the composer without inventing a reply. Native video uploads retain the 20 MB limit, and these chat apps remain separate from the iMessage channel plugin.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Render collapsible details in native chats [#115641](https://github.com/openclaw/openclaw/pull/115641)
- Add inline audio and video playback to Apple chats [#115903](https://github.com/openclaw/openclaw/pull/115903)
- Complete Apple media playback and video upload [#116051](https://github.com/openclaw/openclaw/pull/116051)

**Bug fixes**

- Render Markdown lists and dividers correctly on iOS [#111223](https://github.com/openclaw/openclaw/pull/111223)
- Keep slow Apple chat replies pending until they reconcile [#97722](https://github.com/openclaw/openclaw/pull/97722)
- Render accessible Markdown heading hierarchy in Apple chat [#103404](https://github.com/openclaw/openclaw/pull/103404)
- Keep visible reasoning headings visually subdued [#103436](https://github.com/openclaw/openclaw/pull/103436)
- Preserve active native chat when another run finishes [#113786](https://github.com/openclaw/openclaw/pull/113786)
- Prevent duplicate native chat replies after tool runs [#115678](https://github.com/openclaw/openclaw/pull/115678)
- Prevent Apple chat sends from stalling on older gateways [#126559](https://github.com/openclaw/openclaw/pull/126559)
- Show full multiline Markdown list items on iPhone and iPad [#112723](https://github.com/openclaw/openclaw/pull/112723)
- fix(apps): prevent stale Now Playing after ownership changes [#128381](https://github.com/openclaw/openclaw/pull/128381)

</details>

</Accordion>

<Accordion title="Control UI, WebChat, and TUI">

[Control UI chat](/web/webchat) now gives supported generated documents and managed audio and video their own named cards instead of exposing raw attachment instructions or treating every file like a download. Ready video can expand over the conversation, compatible delivered media can play inline, and every attempted attachment keeps a visible named outcome with actionable failure guidance. Active or unknown file formats remain unavailable rather than becoming downloadable, while media the browser cannot prepare keeps its download action.

Across Control UI, WebChat, and TUI, prompts, live work, attachments, and replies stay aligned when several clients share a conversation or reconnect at different times. Delayed prompts no longer jump below their live replies, and terminal users keep a privacy-safe attachment warning beside the answer and after history reload.

These are OpenClaw's own chat clients rather than external messaging services, and the saved conversation remains the final record when a live update and refreshed history disagree.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add guided channel setup to Control UI [#106469](https://github.com/openclaw/openclaw/pull/106469)
- Show live run telemetry across chat clients [#113084](https://github.com/openclaw/openclaw/pull/113084)
- Add first-class audio and video cards to Control UI chat [#115764](https://github.com/openclaw/openclaw/pull/115764)
- Add inline audio and video playback to Control UI chat [#116115](https://github.com/openclaw/openclaw/pull/116115)
- Show Discord and Slack conversation avatars in the sidebar [#125668](https://github.com/openclaw/openclaw/pull/125668)
- feat(ui): expand video attachments in the media overlay [#132131](https://github.com/openclaw/openclaw/pull/132131)

**Bug fixes**

- Prevent stale chat panes from sending to switched branches [#113073](https://github.com/openclaw/openclaw/pull/113073)
- Keep WebChat messages and live work in the correct turn [#113266](https://github.com/openclaw/openclaw/pull/113266)
- Make TUI errors safe and streamed replies chronological [#114869](https://github.com/openclaw/openclaw/pull/114869)
- Keep shared Control UI and TUI chats synchronized [#115066](https://github.com/openclaw/openclaw/pull/115066)
- Keep shared Web and TUI chats synchronized under load [#115191](https://github.com/openclaw/openclaw/pull/115191)
- Keep delayed shared-chat prompts in the right TUI order [#115219](https://github.com/openclaw/openclaw/pull/115219)
- fix(ui): structure chat transcript attachments by kind [#127076](https://github.com/openclaw/openclaw/pull/127076)
- Preserve Matrix and Signal conversation identities in the terminal [#113800](https://github.com/openclaw/openclaw/pull/113800)
- Honor outbound hooks in Control UI chat replies [#114351](https://github.com/openclaw/openclaw/pull/114351)
- Keep case-distinct channel conversations isolated [#114638](https://github.com/openclaw/openclaw/pull/114638)
- Preserve shared prompts when TUI scrollback is full [#115165](https://github.com/openclaw/openclaw/pull/115165)
- Show human names for Slack, Buzz, and Matrix sessions [#117680](https://github.com/openclaw/openclaw/pull/117680)
- Keep failed chat runs active until terminal state is saved [#126183](https://github.com/openclaw/openclaw/pull/126183)
- Prevent duplicate assistant bubbles after history refresh [#126364](https://github.com/openclaw/openclaw/pull/126364)
- fix: current chat attachments fail after send acknowledgement [#127737](https://github.com/openclaw/openclaw/pull/127737)
- fix(gateway): preserve queued WebChat overflow reply delivery [#129971](https://github.com/openclaw/openclaw/pull/129971)
- fix(webchat): render generated documents as attachments [#130402](https://github.com/openclaw/openclaw/pull/130402)
- fix(tui): keep finished runs idle after reconnect [#131487](https://github.com/openclaw/openclaw/pull/131487)
- fix: keep live replies after their delayed prompt [#131641](https://github.com/openclaw/openclaw/pull/131641)
- fix(webchat): hide attachment pipeline stages [#131812](https://github.com/openclaw/openclaw/pull/131812)
- fix(webchat): show named cards for failed attachments [#131826](https://github.com/openclaw/openclaw/pull/131826)
- fix(webchat): restore playback for delivered audio and video [#131831](https://github.com/openclaw/openclaw/pull/131831)
- fix(webchat): announce attachment failures before long replies [#132102](https://github.com/openclaw/openclaw/pull/132102)
- fix(tui): keep failed attachments visible beside replies [#132115](https://github.com/openclaw/openclaw/pull/132115)
- fix(webchat): hide managed media in initial transcript events [#132508](https://github.com/openclaw/openclaw/pull/132508)
- fix(tui): preserve large pasted drafts after blocked submit [#132528](https://github.com/openclaw/openclaw/pull/132528)
- fix(ui): stabilize readiness verification and media playback [#132832](https://github.com/openclaw/openclaw/pull/132832)
- fix(gateway): commit media ownership before publishing source replies [#133237](https://github.com/openclaw/openclaw/pull/133237)
- Preserve repeated messages in imported CLI session history [#113703](https://github.com/openclaw/openclaw/pull/113703)
- Hide duplicate raw image Markdown beside attachments [#125674](https://github.com/openclaw/openclaw/pull/125674)
- Preserve WebChat failure state during restart drain [#125985](https://github.com/openclaw/openclaw/pull/125985)
- fix: preserve message-tool images across gateway restarts [#127729](https://github.com/openclaw/openclaw/pull/127729)
- fix: show WebChat attachments from active runs [AI-assisted] [#127879](https://github.com/openclaw/openclaw/pull/127879)
- fix: keep message identity stable through send failures [#129127](https://github.com/openclaw/openclaw/pull/129127)
- fix(webchat): strip reply directives during media transcript rewrites [#131859](https://github.com/openclaw/openclaw/pull/131859)

</details>

</Accordion>

<Accordion title="Voice calls">

[Voice Call](/plugins/voice-call) can opt into an agent's main transcript when an operator wants phone and desktop conversations to share history, while the default remains one session per phone. Realtime agents can speak their final words and request a hangup, and failed startup, carrier hangup, or media silence now closes the unusable session instead of leaving it active until the maximum duration.

Choosing the main transcript places raw call turns in primary history. A carrier can still reject a requested hangup, and carrier, provider-media, Discord, Talk, and Meet calls keep their own credentials and lifecycle rather than being treated as one interchangeable voice system.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Let Voice Call share the agent's main session [#124708](https://github.com/openclaw/openclaw/pull/124708)
- Let realtime voice agents end active calls [#125525](https://github.com/openclaw/openclaw/pull/125525)
- feat(talk): add macOS realtime Gateway relay [#128204](https://github.com/openclaw/openclaw/pull/128204)

**Bug fixes**

- Hang up carrier calls after realtime startup failures [#118699](https://github.com/openclaw/openclaw/pull/118699)
- Preserve routed-agent credentials for realtime voice [#125111](https://github.com/openclaw/openclaw/pull/125111)
- Keep voice calls working across Gateway restarts [#125458](https://github.com/openclaw/openclaw/pull/125458)
- End realtime voice calls after hangup or media silence [#125463](https://github.com/openclaw/openclaw/pull/125463)
- Smooth realtime voice playback and telephony streaming [#125620](https://github.com/openclaw/openclaw/pull/125620)
- Keep active voice calls alive when replacement setup fails [#117960](https://github.com/openclaw/openclaw/pull/117960)
- Keep realtime voice close bounded and transcript state durable [#118025](https://github.com/openclaw/openclaw/pull/118025)
- Stop superseded realtime Voice Call consults [#118301](https://github.com/openclaw/openclaw/pull/118301)
- Keep Voice Call runtime ownership safe across Gateway restarts [#120289](https://github.com/openclaw/openclaw/pull/120289)
- Recognize agent-scoped OpenAI browser Talk credentials [#125142](https://github.com/openclaw/openclaw/pull/125142)
- Use each routed agent's credentials for realtime phone calls [#125144](https://github.com/openclaw/openclaw/pull/125144)
- Resolve Discord realtime voice SecretRefs [#125443](https://github.com/openclaw/openclaw/pull/125443)
- Expose voice-call audio streams through Tailscale [#125468](https://github.com/openclaw/openclaw/pull/125468)
- Keep realtime voice calls alive through brief reconnects [#125469](https://github.com/openclaw/openclaw/pull/125469)
- Preserve carrier-confirmed voice-call termination [#125717](https://github.com/openclaw/openclaw/pull/125717)
- Enable active-agent consultation in OAuth browser Talk [#126363](https://github.com/openclaw/openclaw/pull/126363)
- fix: realtime phone calls use the wrong audio format and stay open [#133018](https://github.com/openclaw/openclaw/pull/133018)
- Redial Google Meet after completed Twilio calls [#120807](https://github.com/openclaw/openclaw/pull/120807)
- Stop failed Google Meet voice gateway connections [#120822](https://github.com/openclaw/openclaw/pull/120822)
- Preserve Discord voice lookup errors and agent-scoped realtime auth [#125069](https://github.com/openclaw/openclaw/pull/125069)
- Keep offline Voice Call status read-only [#125354](https://github.com/openclaw/openclaw/pull/125354)
- Use typed Gateway fallback errors in Google Meet CLI [#125495](https://github.com/openclaw/openclaw/pull/125495)
- Allow Voice Call to use alternate Tailscale HTTPS ports [#125552](https://github.com/openclaw/openclaw/pull/125552)
- fix(ui): explain unavailable microphones on WebKit [#132904](https://github.com/openclaw/openclaw/pull/132904)
- fix: browser voice stays unavailable after OpenAI login [#133048](https://github.com/openclaw/openclaw/pull/133048)

</details>

</Accordion>

<Accordion title="Raft">

[Raft](/channels/raft) setup now says clearly when the machine running OpenClaw cannot find the Raft executable instead of presenting a configured channel as healthy. A passing probe means the command-line tool was available at that moment, not that a later connection or message has already succeeded.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Bug fixes**

- Report missing Raft CLI in channel status [#123140](https://github.com/openclaw/openclaw/pull/123140)

</details>

</Accordion>

</AccordionGroup>
