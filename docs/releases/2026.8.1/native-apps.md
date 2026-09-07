---
title: "v2026.8.1: Native Apps"
description: "iPhone, iPad, Android, macOS, and Wear OS bring voice, attachments, model choices, and conversation controls closer to the work."
---

This release makes the [native apps](/platforms) useful for more of the work around a conversation. iPhone, iPad, and Android bring voice, attachments, model choices, and conversation controls into Chat, macOS adds Quick Chat from the menu bar or a global shortcut, and Wear OS brings transcripts, replies, Talk, and session controls to a paired watch. Apple Watch retains wrist actions through relaunches and retries, while the Linux desktop companion work now covers a tray, an embedded Control UI, and Quick Chat.

Progress cards and assistant-created widgets also bring more of the Claw's active work into supported native conversations, with translations, profile accents, waveforms, and file diffs appearing on the specific clients covered below.

<AccordionGroup>

<Accordion title="iPhone, iPad, and Apple Watch">

On [iPhone and iPad](/platforms/ios), one Chat surface now handles typing, dictation, voice notes, attachments, realtime Talk, and the session, model, reasoning, and tool-activity controls around a conversation. The sidebar makes it easier to switch agents, search and manage recent conversations, see what needs attention, and pin the destinations used most often.

Sharing into OpenClaw now previews supported attachments and shows their progress from preparation through completion or failure. Completed shares in this release support text, links, or one to three images, and Send stays unavailable when an unsupported, excess, or unloadable attachment would otherwise be left out.

Apple Watch retains messages, approvals, replies, and commands through relaunches, Gateway changes, navigation, and retries, then reconciles the result across the phone and Watch so the same wrist action is less likely to be lost or repeated.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Redesign the iOS share compose sheet [#104187](https://github.com/openclaw/openclaw/pull/104187)
- Unify iOS chat, dictation, voice notes, and realtime voice [#107879](https://github.com/openclaw/openclaw/pull/107879)
- Bring richer chat controls and live Talk feedback to iOS [#110254](https://github.com/openclaw/openclaw/pull/110254)
- Bring model controls and session management to iOS chat [#110831](https://github.com/openclaw/openclaw/pull/110831)
- Add iOS Talk camera flip and microphone selection [#111044](https://github.com/openclaw/openclaw/pull/111044)
- Replace the iOS tab bar with a full sidebar [#111339](https://github.com/openclaw/openclaw/pull/111339)
- Add durable voice sessions to iOS Talk [#111369](https://github.com/openclaw/openclaw/pull/111369)
- fix(ios): refine Chat Actions and header controls [#132045](https://github.com/openclaw/openclaw/pull/132045)
- Refresh the iPhone Control tab layout [#98582](https://github.com/openclaw/openclaw/pull/98582)
- Refresh iOS and Watch icons with the current OpenClaw mascot [#101411](https://github.com/openclaw/openclaw/pull/101411)
- Add state-aware mascot moods to iOS setup [#108900](https://github.com/openclaw/openclaw/pull/108900)
- Add a mood-aware Clawd mascot to the watch inbox [#109365](https://github.com/openclaw/openclaw/pull/109365)
- Add agent avatars and more space to the iOS sidebar [#112082](https://github.com/openclaw/openclaw/pull/112082)
- fix(ios): simplify sidebar navigation [#132086](https://github.com/openclaw/openclaw/pull/132086)
- Harden iOS releases and simplify location access selection [12515ad](https://github.com/openclaw/openclaw/commit/12515ad)
- Use branded typography in the iOS Talk menu [af62abe](https://github.com/openclaw/openclaw/commit/af62abe)
- Keep recurring iOS gateway alerts stationary [#110493](https://github.com/openclaw/openclaw/pull/110493)
- chore(i18n): refresh native locales [#131438](https://github.com/openclaw/openclaw/pull/131438)
- chore(i18n): refresh native locales [#132302](https://github.com/openclaw/openclaw/pull/132302)

**Bug fixes**

- Harden iOS gateway and Apple Watch state handling [5e9bc09](https://github.com/openclaw/openclaw/commit/5e9bc09)
- Prevent stale iOS voice work after cancellation and session changes [#103072](https://github.com/openclaw/openclaw/pull/103072)
- Localize iOS and Apple Watch app surfaces [#105372](https://github.com/openclaw/openclaw/pull/105372)
- Smooth iOS sidebar gestures and controls [#111831](https://github.com/openclaw/openclaw/pull/111831)
- Smooth iOS sidebar drags and unify drawer surfaces [#112299](https://github.com/openclaw/openclaw/pull/112299)
- fix(talk): share and bound Apple relay lifecycle [#127232](https://github.com/openclaw/openclaw/pull/127232)
- Preserve iOS app and extension names across languages [690ed56](https://github.com/openclaw/openclaw/commit/690ed56)
- Keep iOS chat visibly active after returning [#102309](https://github.com/openclaw/openclaw/pull/102309)
- Stop cancelled iOS camera requests cleanly [#103069](https://github.com/openclaw/openclaw/pull/103069)
- Keep iOS session actions with the selected agent [#103415](https://github.com/openclaw/openclaw/pull/103415)
- Preserve legitimate text in iOS share drafts [#103453](https://github.com/openclaw/openclaw/pull/103453)
- Resize oversized images shared from iOS [#103860](https://github.com/openclaw/openclaw/pull/103860)
- Localize iOS Settings labels for VoiceOver [#105859](https://github.com/openclaw/openclaw/pull/105859)
- Prevent incomplete iOS shares when attachments are omitted [#106513](https://github.com/openclaw/openclaw/pull/106513)
- Keep the active iOS chat selected after reconnecting [#108241](https://github.com/openclaw/openclaw/pull/108241)
- Restore translucent iOS chat edges [#110505](https://github.com/openclaw/openclaw/pull/110505)
- Keep unified iOS voice controls recoverable [#110906](https://github.com/openclaw/openclaw/pull/110906)
- Keep iOS replies visible above the open keyboard [#110944](https://github.com/openclaw/openclaw/pull/110944)
- Harden iOS Talk voice-session recovery and confirmation feedback [#111424](https://github.com/openclaw/openclaw/pull/111424)
- fix(ios): page session rosters and restore approval guidance [#112004](https://github.com/openclaw/openclaw/pull/112004)
- Localize Agent Pro detail labels on iOS [#112980](https://github.com/openclaw/openclaw/pull/112980)
- Add Dark Home Screen icons on iOS [#113039](https://github.com/openclaw/openclaw/pull/113039)
- Prevent iOS Settings and release screenshots from stalling [#113187](https://github.com/openclaw/openclaw/pull/113187)
- Honor speech locale for iOS system voice fallback [#113372](https://github.com/openclaw/openclaw/pull/113372)
- Keep Stop available for staged iOS voice notes [#115744](https://github.com/openclaw/openclaw/pull/115744)
- Restore Magic Keyboard Return in the iPad chat composer [#116042](https://github.com/openclaw/openclaw/pull/116042)
- Remove duplicate URLs from iOS shared drafts [#116430](https://github.com/openclaw/openclaw/pull/116430)
- Honor forced agent consultation in iOS Talk routing [#117485](https://github.com/openclaw/openclaw/pull/117485)
- Restore iOS chat composer keyboard focus [#120723](https://github.com/openclaw/openclaw/pull/120723)
- fix(ios): report unavailable when network observation times out [#128724](https://github.com/openclaw/openclaw/pull/128724)
- fix(ios): settle expired background refreshes exactly once [#129097](https://github.com/openclaw/openclaw/pull/129097)
- fix(ios): stale Watch operations overwrite current prompts and commands [#129804](https://github.com/openclaw/openclaw/pull/129804)
- fix(ios): prevent Apple Watch callbacks from crashing the app [#129921](https://github.com/openclaw/openclaw/pull/129921)
- fix(ios): show sidebar sessions on multi-agent gateways [#131356](https://github.com/openclaw/openclaw/pull/131356)
- Prevent overlapping automatic iOS overview refreshes [818eca2](https://github.com/openclaw/openclaw/commit/818eca2)
- Correct Korean native UI translations [#107573](https://github.com/openclaw/openclaw/pull/107573)
- Prevent stale delayed overlays in the iOS app [#113062](https://github.com/openclaw/openclaw/pull/113062)
- Make the iOS chat agent identity accessible and expandable [#113917](https://github.com/openclaw/openclaw/pull/113917)
- fix(ios): keep tool details visible in dark mode [#124021](https://github.com/openclaw/openclaw/pull/124021)
- fix(ios): device status leaves battery monitoring enabled [#128174](https://github.com/openclaw/openclaw/pull/128174)
- fix(ios): report no data for throttled silent pushes [#129026](https://github.com/openclaw/openclaw/pull/129026)
- fix(ios): preserve keyboard feedback during voice capture [#129462](https://github.com/openclaw/openclaw/pull/129462)
- fix(ios): Voice Wake silently loses commands when Gateway delivery fails [#130139](https://github.com/openclaw/openclaw/pull/130139)

</details>

</Accordion>

<Accordion title="Android and Wear OS">

[Android](/platforms/android) puts dictation, voice notes, realtime Talk, model and thinking choices, context use, attachments, and the current Talk, Send, or Stop action into one compact composer, with Photos, Videos, and Files behind one plus menu. Text, links, images, supported audio, and common documents received from the system Sharesheet become drafts for review, and unsupported, oversized, or excess items are shown before anything sends.

Search can reach Gateway-backed sessions beyond cached recents while Android is connected, and Threads can expand related parent and child work with descendant status. When the app is offline, search uses the active sessions already in its cache. Eligible capped assistant replies can now open inline so the ending, formatting, attachments, and full code remain available to read or copy, while unavailable, failed, or oversized results remain explicit instead of silently ending the answer.

The Wear OS companion uses its paired Android phone for the connection and stores no Gateway credentials on the Watch. It can show recent transcripts, send typed or dictated replies, stop a run, notify when a reply arrives, use continuous realtime Talk, and switch agents, sessions, and models when the phone advertises those controls. Supported phones also add Agent Pulse as a read-only view of bounded background work and pending attention, with no approval or mutation actions on the Watch.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add per-app language selection on Android [#102876](https://github.com/openclaw/openclaw/pull/102876)
- Show configured agent avatars throughout the Android app [#103248](https://github.com/openclaw/openclaw/pull/103248)
- Add Android system sharing into chat [#104571](https://github.com/openclaw/openclaw/pull/104571)
- Preview inline images in Android chat [#104620](https://github.com/openclaw/openclaw/pull/104620)
- Localize the Android app across 21 languages [#105049](https://github.com/openclaw/openclaw/pull/105049)
- Add foreground Voice Wake on Android [#107081](https://github.com/openclaw/openclaw/pull/107081)
- Add inline dictation and Talk to Android Chat [#109329](https://github.com/openclaw/openclaw/pull/109329)
- Add a secure Wear OS companion through the paired Android phone [#109433](https://github.com/openclaw/openclaw/pull/109433)
- Add continuous Real-Time Talk to the Wear OS companion [#109483](https://github.com/openclaw/openclaw/pull/109483)
- Restore the complete Wear OS companion experience [#110130](https://github.com/openclaw/openclaw/pull/110130)
- Improve Wear OS voice controls and accessibility [#110425](https://github.com/openclaw/openclaw/pull/110425)
- Put Wear OS agent, session, and model controls on Home [#110661](https://github.com/openclaw/openclaw/pull/110661)
- Share audio and documents from Android [#110941](https://github.com/openclaw/openclaw/pull/110941)
- Copy or save Android chat widgets as images [#111030](https://github.com/openclaw/openclaw/pull/111030)
- Animate the Wear Talk avatar from assistant audio [#111516](https://github.com/openclaw/openclaw/pull/111516)
- Bring working status and turn recaps to Android chat [#112221](https://github.com/openclaw/openclaw/pull/112221)
- Add one-tap Voice and Chat routes to the Wear OS Tile [#112721](https://github.com/openclaw/openclaw/pull/112721)
- Add adaptive Material navigation to the Android app [#113908](https://github.com/openclaw/openclaw/pull/113908)
- Show live subagent activity in Android chat [#121813](https://github.com/openclaw/openclaw/pull/121813)
- Add Agent Pulse to the Wear companion [#122123](https://github.com/openclaw/openclaw/pull/122123)
- Show clear system notices and session dividers on Android [#122268](https://github.com/openclaw/openclaw/pull/122268)
- Streamline the Android chat composer [#123077](https://github.com/openclaw/openclaw/pull/123077)
- Add pinned gateway-backed session search to Android [#124338](https://github.com/openclaw/openclaw/pull/124338)
- Show durable progress cards in Android chat [#125444](https://github.com/openclaw/openclaw/pull/125444)
- Add direct searchable context pickers to Wear OS [#126863](https://github.com/openclaw/openclaw/pull/126863)
- feat(android): show session hierarchy in Threads [#128862](https://github.com/openclaw/openclaw/pull/128862)
- Simplify Android Sessions sorting and row markers [#103108](https://github.com/openclaw/openclaw/pull/103108)
- Align Android voice waveforms and Thinking state with Apple platforms [#103130](https://github.com/openclaw/openclaw/pull/103130)
- Improve Android workspace file navigation [#104873](https://github.com/openclaw/openclaw/pull/104873)
- Prepare Android per-device sessions before loading chat history [#105115](https://github.com/openclaw/openclaw/pull/105115)
- Add mood-aware mascot animations to Android onboarding [#109311](https://github.com/openclaw/openclaw/pull/109311)
- Add the Android phone proxy for Wear OS [#109341](https://github.com/openclaw/openclaw/pull/109341)
- Align Wear OS light and dark themes [#110314](https://github.com/openclaw/openclaw/pull/110314)
- Add Android Talk camera and microphone controls [#111046](https://github.com/openclaw/openclaw/pull/111046)
- Add rare working-claw animations on Android [#112571](https://github.com/openclaw/openclaw/pull/112571)
- Collapse Android sidebar search behind a header action [#116956](https://github.com/openclaw/openclaw/pull/116956)
- Show plan status and explanations in Android chat [#124958](https://github.com/openclaw/openclaw/pull/124958)
- Let Android chat bubbles show who is speaking [#124985](https://github.com/openclaw/openclaw/pull/124985)
- Unify Android chat colors under ClawTheme [#125020](https://github.com/openclaw/openclaw/pull/125020)
- feat(android): group sidebar sessions [#128092](https://github.com/openclaw/openclaw/pull/128092)
- feat(android): unify agent and session pickers [#128309](https://github.com/openclaw/openclaw/pull/128309)
- Make Android release screenshots deterministic [f163f32](https://github.com/openclaw/openclaw/commit/f163f32)
- Align the Android launcher icon with the OpenClaw favicon [#101423](https://github.com/openclaw/openclaw/pull/101423)
- Simplify the Android Canvas standby layout [#104001](https://github.com/openclaw/openclaw/pull/104001)
- Refresh generated native app translations [#112803](https://github.com/openclaw/openclaw/pull/112803)
- Keep completed Android plan steps readable [#124916](https://github.com/openclaw/openclaw/pull/124916)
- chore(i18n): refresh native locales [#127681](https://github.com/openclaw/openclaw/pull/127681)

**Bug fixes**

- Keep Android composer state with its chat [#109200](https://github.com/openclaw/openclaw/pull/109200)
- Stabilize Wear OS realtime audio and agent requests [#111033](https://github.com/openclaw/openclaw/pull/111033)
- Respect reduced-motion settings in the Wear Talk avatar [#112245](https://github.com/openclaw/openclaw/pull/112245)
- fix(android): recover the ending of truncated assistant replies [#131575](https://github.com/openclaw/openclaw/pull/131575)
- Stop canceled Android work from appearing as failures [#105047](https://github.com/openclaw/openclaw/pull/105047)
- Keep Android app sessions stable during reconnects [#105144](https://github.com/openclaw/openclaw/pull/105144)
- Keep long Android chat runs active [#106864](https://github.com/openclaw/openclaw/pull/106864)
- Restore brand colors for Android header logos [#108199](https://github.com/openclaw/openclaw/pull/108199)
- Preserve emoji in Android diagnostics [#108823](https://github.com/openclaw/openclaw/pull/108823)
- Preserve complete Unicode graphemes in Android initials [#108830](https://github.com/openclaw/openclaw/pull/108830)
- Preserve full Unicode graphemes in Android badges [#109486](https://github.com/openclaw/openclaw/pull/109486)
- Keep restarted Wear Talk sessions alive after stale audio errors [#110292](https://github.com/openclaw/openclaw/pull/110292)
- Recover Wear requests from stale phone routes [#110423](https://github.com/openclaw/openclaw/pull/110423)
- Keep Android streaming replies in view [#110983](https://github.com/openclaw/openclaw/pull/110983)
- Keep streamed replies visible in the Wear OS thread [#111459](https://github.com/openclaw/openclaw/pull/111459)
- Localize Wear OS companion status and failures [#112228](https://github.com/openclaw/openclaw/pull/112228)
- React to Android Remove animations changes [#112687](https://github.com/openclaw/openclaw/pull/112687)
- Keep active Wear OS replies when older turns finish [#113804](https://github.com/openclaw/openclaw/pull/113804)
- Format Android and Wear labels with the active locale [#115015](https://github.com/openclaw/openclaw/pull/115015)
- Localize the Android “Pinned” accessibility label [#117726](https://github.com/openclaw/openclaw/pull/117726)
- Keep Wear OS chat on the newest reply [#120307](https://github.com/openclaw/openclaw/pull/120307)
- Start Android subagent retention from local completion [#122089](https://github.com/openclaw/openclaw/pull/122089)
- Keep Android subagent activity visible for the full retention period [#122198](https://github.com/openclaw/openclaw/pull/122198)
- Restore compact Android chat metadata labels [#125053](https://github.com/openclaw/openclaw/pull/125053)
- fix(android): normalize null calendar and contact write fields [#125527](https://github.com/openclaw/openclaw/pull/125527)
- fix: location.get can return a stale fix when no cached location is fresh enough [#128439](https://github.com/openclaw/openclaw/pull/128439)
- fix(android): gateway accent color is fetched but never applied to the app theme [#128702](https://github.com/openclaw/openclaw/pull/128702)
- fix(android): fence canceled voice-note permission callbacks [#128733](https://github.com/openclaw/openclaw/pull/128733)
- fix(android): select writable calendars for new events [#129055](https://github.com/openclaw/openclaw/pull/129055)
- fix(android): preserve photo orientation in chat images [#129136](https://github.com/openclaw/openclaw/pull/129136)
- fix(android): stop interrupted assistant audio and remove cached files [#129574](https://github.com/openclaw/openclaw/pull/129574)
- fix(android): recover dropped gateway events [#129723](https://github.com/openclaw/openclaw/pull/129723)
- fix(android): load chat images, audio, and video behind proxy paths [#129957](https://github.com/openclaw/openclaw/pull/129957)
- fix(android): photo library returns rotated or mirrored camera images [#129965](https://github.com/openclaw/openclaw/pull/129965)
- fix(android): preserve document attachments in offline chat history [#130163](https://github.com/openclaw/openclaw/pull/130163)
- fix(android): report disabled notification categories instead of success [#130531](https://github.com/openclaw/openclaw/pull/130531)
- fix(android): read long replies aloud without silent failure [#130574](https://github.com/openclaw/openclaw/pull/130574)
- fix(android): keep question answers when reading earlier messages [#130821](https://github.com/openclaw/openclaw/pull/130821)
- fix(android): keep settings controls reachable with the keyboard open [#130995](https://github.com/openclaw/openclaw/pull/130995)
- fix(android): keep offline history current after reconnect [#132964](https://github.com/openclaw/openclaw/pull/132964)
- Keep forwarded Android notification text UTF-16 safe [#102442](https://github.com/openclaw/openclaw/pull/102442)
- Keep Android link preview metadata UTF-16 safe [#102988](https://github.com/openclaw/openclaw/pull/102988)
- Wrap long filenames in the Android workspace browser [#104075](https://github.com/openclaw/openclaw/pull/104075)
- fix(android): refresh notification access on resume [#104460](https://github.com/openclaw/openclaw/pull/104460)
- Keep Android session search inside Sessions [#104792](https://github.com/openclaw/openclaw/pull/104792)
- Bound Android structured history image decoding [#105065](https://github.com/openclaw/openclaw/pull/105065)
- Autofocus Android command-palette search [#105471](https://github.com/openclaw/openclaw/pull/105471)
- Center the Android command palette title [#106264](https://github.com/openclaw/openclaw/pull/106264)
- Make Android attachment removal easier to tap [#106737](https://github.com/openclaw/openclaw/pull/106737)
- Outline the Android Providers & Models back button [#106803](https://github.com/openclaw/openclaw/pull/106803)
- Preserve emoji when Android voice errors are shortened [#108101](https://github.com/openclaw/openclaw/pull/108101)
- Preserve emoji boundaries in Android session labels [#108102](https://github.com/openclaw/openclaw/pull/108102)
- Preserve emoji in Android presence-rejection logs [#108103](https://github.com/openclaw/openclaw/pull/108103)
- Enlarge Android voice-note recording controls [#108307](https://github.com/openclaw/openclaw/pull/108307)
- Android tool previews preserve emoji [#108330](https://github.com/openclaw/openclaw/pull/108330)
- Preserve Android push-to-talk speech across pauses [#110995](https://github.com/openclaw/openclaw/pull/110995)
- Restore Wear Talk after exiting and reopening [#112383](https://github.com/openclaw/openclaw/pull/112383)
- Make Android branch message counts locale-neutral [#112426](https://github.com/openclaw/openclaw/pull/112426)
- Correct Android accessibility executor localization [#113276](https://github.com/openclaw/openclaw/pull/113276)
- Show pinned status in Android sidebar sessions [#117063](https://github.com/openclaw/openclaw/pull/117063)
- Show all matching sessions in Android sidebar search [#117981](https://github.com/openclaw/openclaw/pull/117981)
- Show active Android session status in the sidebar [#118624](https://github.com/openclaw/openclaw/pull/118624)
- Generate useful titles for new Android chats [#123670](https://github.com/openclaw/openclaw/pull/123670)
- Keep pinned Android sessions in the compact picker [#125264](https://github.com/openclaw/openclaw/pull/125264)
- fix(android): preserve photo capture dates and requested image resolution [#125550](https://github.com/openclaw/openclaw/pull/125550)
- Localize Android progress-card labels [#125608](https://github.com/openclaw/openclaw/pull/125608)
- fix(android): prevent expired subagent tasks from reappearing [#128612](https://github.com/openclaw/openclaw/pull/128612)
- fix(android): normalize optional motion date ranges [#128734](https://github.com/openclaw/openclaw/pull/128734)
- fix(android): contacts without personal names appear unnamed [#129549](https://github.com/openclaw/openclaw/pull/129549)
- fix(android): preserve document-only chat messages [#129557](https://github.com/openclaw/openclaw/pull/129557)
- fix(android): captions disappear when sharing multiple images [#129603](https://github.com/openclaw/openclaw/pull/129603)
- fix(android): preserve omitted image-only chat messages [#129711](https://github.com/openclaw/openclaw/pull/129711)
- fix(android): preserve disconnected node gateway status [#129839](https://github.com/openclaw/openclaw/pull/129839)
- fix(android): shared images lose their original filenames [#130156](https://github.com/openclaw/openclaw/pull/130156)
- fix(android): honor low camera snapshot quality [#130160](https://github.com/openclaw/openclaw/pull/130160)
- fix(android): require listener access before forwarding notifications [#130173](https://github.com/openclaw/openclaw/pull/130173)
- fix(android): keep the composer visible with slash suggestions [#130555](https://github.com/openclaw/openclaw/pull/130555)
- fix(android): keep Talk's speaking indicator active during reply replacement [#130868](https://github.com/openclaw/openclaw/pull/130868)
- chore(i18n): refresh native locales [#132101](https://github.com/openclaw/openclaw/pull/132101)
- fix(android): delayed archive completion switches away from newer chat [#132873](https://github.com/openclaw/openclaw/pull/132873)

</details>

</Accordion>

<Accordion title="macOS app">

[macOS Quick Chat](/platforms/macos) opens from the menu bar or a global shortcut over the app already in use, with a picker for the five most recently updated conversations. It streams the reply in place, switches agents, accepts dictation, and selects a model and reasoning level. Screen Recording permission adds window or region capture, while Accessibility permission adds bounded text from the focused app and lets a final answer paste back where the user was working. Captured context clears after the send or when Quick Chat hides.

Full-window native chat now centers wide conversations, grows with longer drafts, searches loaded user and assistant messages with Command-F and Command-G, and puts Copy, Reply, Listen, and other message actions directly on the conversation. A failed queued send can be retried immediately, while a send whose outcome is uncertain remains under user control. Search stays within loaded visible message text and does not fetch older history or inspect hidden reasoning and tool payloads.

Native chat can rename, fork, pin, archive, mark read or unread, and organize conversations in parent-child trees and groups, with batch actions, inspection, and worktree-backed creation. A worktree request stops when the chosen agent, parent, worktree, or base reference cannot be honored.

The Dashboard returns to its remembered frame, Space, and eligible route through reconnects, and the status menu keeps live session cards, selection, and Gateway or device diagnostics stable and readable.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Move the macOS sidebar toggle into the titlebar [#104380](https://github.com/openclaw/openclaw/pull/104380)
- Redesign the macOS menu-bar critter [#104846](https://github.com/openclaw/openclaw/pull/104846)
- Adapt macOS titlebar controls to sidebar state [#105175](https://github.com/openclaw/openclaw/pull/105175)
- Move macOS dashboard toolbar controls into the web UI [#105902](https://github.com/openclaw/openclaw/pull/105902)
- Make the macOS dashboard feel native [#106997](https://github.com/openclaw/openclaw/pull/106997)
- Add nightcap, graduation cap, and hat-tip mascot moments on Mac [#108882](https://github.com/openclaw/openclaw/pull/108882)
- Add macOS Quick Chat [#109720](https://github.com/openclaw/openclaw/pull/109720)
- Expand macOS Quick Chat with agent switching and window screenshots [#109952](https://github.com/openclaw/openclaw/pull/109952)
- Improve microphone control and live feedback in macOS Talk Mode [#109995](https://github.com/openclaw/openclaw/pull/109995)
- Native macOS chat adds session actions, unread handling, and a subagent tree [#110019](https://github.com/openclaw/openclaw/pull/110019)
- Add native session groups, batch actions, and worktree creation [#110347](https://github.com/openclaw/openclaw/pull/110347)
- macOS Quick Chat streams replies and continues recent conversations [#110631](https://github.com/openclaw/openclaw/pull/110631)
- Add Quick Chat area capture and focused-app text context [#110635](https://github.com/openclaw/openclaw/pull/110635)
- Add dictation, paste-back, and model controls to macOS Quick Chat [#110994](https://github.com/openclaw/openclaw/pull/110994)
- Add approval-gated camera pan, tilt, and zoom on macOS [#120511](https://github.com/openclaw/openclaw/pull/120511)
- Present widgets on connected Mac device panels [#125818](https://github.com/openclaw/openclaw/pull/125818)
- refactor(macos): single-owner hybrid status menu with live session cards and exec approvals [#130041](https://github.com/openclaw/openclaw/pull/130041)
- refactor(macos): status menu polish — owned width, quiet header, structured diagnostics, native highlight [#130388](https://github.com/openclaw/openclaw/pull/130388)
- feat(macos): bring native chat layout and controls closer to web [#131849](https://github.com/openclaw/openclaw/pull/131849)
- Reuse the macOS MLX voice model across utterances [#104200](https://github.com/openclaw/openclaw/pull/104200)
- Reclaim vertical space in macOS chat split view [#104628](https://github.com/openclaw/openclaw/pull/104628)
- Refresh the macOS installer artwork and layout [#107142](https://github.com/openclaw/openclaw/pull/107142)
- Let the macOS menu-bar critter celebrate recovery and finished work [#108866](https://github.com/openclaw/openclaw/pull/108866)
- Merge the macOS WebChat title and toolbar rows [#109318](https://github.com/openclaw/openclaw/pull/109318)
- Add a true background-only launch mode for the macOS app [#112168](https://github.com/openclaw/openclaw/pull/112168)
- Clarify macOS remote-gateway onboarding [#114494](https://github.com/openclaw/openclaw/pull/114494)
- Move macOS node identity reads out of menu rendering [#116435](https://github.com/openclaw/openclaw/pull/116435)
- Refresh generated macOS locale artifacts [#117948](https://github.com/openclaw/openclaw/pull/117948)
- macOS: surface realtime Talk settings [#118505](https://github.com/openclaw/openclaw/pull/118505)
- Make macOS Peekaboo host upgrades transactional [#124564](https://github.com/openclaw/openclaw/pull/124564)
- Add Command-bracket history shortcuts to the macOS dashboard [#104328](https://github.com/openclaw/openclaw/pull/104328)
- Give macOS dashboard titlebar controls more space [#104572](https://github.com/openclaw/openclaw/pull/104572)
- Add a working mascot animation for macOS setup and updates [#108735](https://github.com/openclaw/openclaw/pull/108735)
- Reduce macOS location-permission polling overhead [#116092](https://github.com/openclaw/openclaw/pull/116092)
- Remove the duplicate macOS menu bar hover card [#118116](https://github.com/openclaw/openclaw/pull/118116)

**Bug fixes**

- Keep the macOS Dashboard stable through reconnects [#117112](https://github.com/openclaw/openclaw/pull/117112)
- fix(macos): suppress SIGPIPE on process pipe write ends [#127666](https://github.com/openclaw/openclaw/pull/127666)
- fix(macos): keep node connections working after app rebuilds [#131466](https://github.com/openclaw/openclaw/pull/131466)
- Restore session deletion in the macOS Dashboard [#102263](https://github.com/openclaw/openclaw/pull/102263)
- Drag macOS windows from split-view pane headers [#104048](https://github.com/openclaw/openclaw/pull/104048)
- Align macOS dashboard traffic lights with hosted titlebar controls [#106099](https://github.com/openclaw/openclaw/pull/106099)
- Make macOS menu bar clicks reliable [#107786](https://github.com/openclaw/openclaw/pull/107786)
- Restore macOS app builds on Swift 6.2 [#107926](https://github.com/openclaw/openclaw/pull/107926)
- Keep hidden macOS Canvas panels from reopening [#110107](https://github.com/openclaw/openclaw/pull/110107)
- Open the receiving agent's Quick Chat conversation [#110118](https://github.com/openclaw/openclaw/pull/110118)
- Stabilize macOS Quick Chat capture and text context [#110830](https://github.com/openclaw/openclaw/pull/110830)
- Reap timed-out macOS shell process groups [#115859](https://github.com/openclaw/openclaw/pull/115859)
- fix(camera): preserve landscape output on external macOS webcams [#116046](https://github.com/openclaw/openclaw/pull/116046)
- Pause inactive macOS Canvas polling [#116106](https://github.com/openclaw/openclaw/pull/116106)
- Resume every concurrent macOS location permission request [#116183](https://github.com/openclaw/openclaw/pull/116183)
- Stop cancelled Voice Wake timers from doing stale work [#116189](https://github.com/openclaw/openclaw/pull/116189)
- Keep the macOS Voice Wake indicator active for the current capture [#116196](https://github.com/openclaw/openclaw/pull/116196)
- Keep the newest macOS Voice Wake triggers [#116202](https://github.com/openclaw/openclaw/pull/116202)
- Stop cancelled macOS refresh tasks from running late [#116322](https://github.com/openclaw/openclaw/pull/116322)
- Restore scrolling across macOS Settings panes [#118831](https://github.com/openclaw/openclaw/pull/118831)
- Restore double-click zoom in the macOS dashboard [#118976](https://github.com/openclaw/openclaw/pull/118976)
- Deliver provisional macOS notifications [#122179](https://github.com/openclaw/openclaw/pull/122179)
- Reap macOS helper processes on shutdown [#123538](https://github.com/openclaw/openclaw/pull/123538)
- Present macOS Canvas widgets atomically [#126039](https://github.com/openclaw/openclaw/pull/126039)
- fix(macos): read current channel health state [#128176](https://github.com/openclaw/openclaw/pull/128176)
- fix(ui): propagate user accent to Talk Mode and widget frames [#128577](https://github.com/openclaw/openclaw/pull/128577)
- fix(macos): user accent from Control UI is clobbered by config snapshots and never live-updates the chat window [#128703](https://github.com/openclaw/openclaw/pull/128703)
- fix(mac): prevent network discovery crashes on addressless interfaces [#129265](https://github.com/openclaw/openclaw/pull/129265)
- fix(macos): prevent crashes when SSH tunnel startup is canceled [#130332](https://github.com/openclaw/openclaw/pull/130332)
- fix(macos): quit without leaving SSH tunnels behind [#130421](https://github.com/openclaw/openclaw/pull/130421)
- fix: Claude session discovery stalls on stale Desktop metadata [#131237](https://github.com/openclaw/openclaw/pull/131237)
- fix(macos): stop companion commands when their caller is cancelled [#131650](https://github.com/openclaw/openclaw/pull/131650)
- fix(macos): preserve status-less health probe errors [#132062](https://github.com/openclaw/openclaw/pull/132062)
- Remove the duplicate macOS titlebar brand mark [#102497](https://github.com/openclaw/openclaw/pull/102497)
- Use safe reads for macOS MLX speech output [#104233](https://github.com/openclaw/openclaw/pull/104233)
- Keep macOS split-view headers clear of window controls [#104593](https://github.com/openclaw/openclaw/pull/104593)
- Remove duplicate sidebar toggles from the macOS dashboard [#104694](https://github.com/openclaw/openclaw/pull/104694)
- Keep the compact macOS brand clear of window controls [#107783](https://github.com/openclaw/openclaw/pull/107783)
- Stop Settings opening with the macOS dashboard [#108074](https://github.com/openclaw/openclaw/pull/108074)
- Stop agent-presented Canvas windows from stealing focus [#110245](https://github.com/openclaw/openclaw/pull/110245)
- Align the macOS session header with native titlebar controls [#110462](https://github.com/openclaw/openclaw/pull/110462)
- Restore the critter icon in the macOS menu bar [#114223](https://github.com/openclaw/openclaw/pull/114223)
- Keep replacement macOS notifications visible [#116226](https://github.com/openclaw/openclaw/pull/116226)
- Refresh generated macOS locale catalogs [#116640](https://github.com/openclaw/openclaw/pull/116640)
- Remove the macOS self-named defaults warning [#117690](https://github.com/openclaw/openclaw/pull/117690)
- Restore native Codex and Claude sidebar handling on macOS [#118914](https://github.com/openclaw/openclaw/pull/118914)
- Honor While Using location permission on macOS [#122435](https://github.com/openclaw/openclaw/pull/122435)
- Restore Group badges for opaque session keys on macOS [#126807](https://github.com/openclaw/openclaw/pull/126807)
- fix(macos): cancelled Talk sessions can spin at full CPU [#129682](https://github.com/openclaw/openclaw/pull/129682)
- fix(macos): restore denied speech permission recovery in Settings and voice controls [#129950](https://github.com/openclaw/openclaw/pull/129950)
- fix(macos): recognize Screen Recording access after granting permission [#130530](https://github.com/openclaw/openclaw/pull/130530)
- fix(macos): allow dragging the OpenClaw panel header [#132288](https://github.com/openclaw/openclaw/pull/132288)
- fix(macos): restore Codex catalogs on paired Macs [#132713](https://github.com/openclaw/openclaw/pull/132713)

**Documentation**

- test(exec): cover companion response loss without local replay [#131961](https://github.com/openclaw/openclaw/pull/131961)

</details>

</Accordion>

<Accordion title="Linux app">

The [Linux desktop companion](/platforms/linux) work now includes first-run setup, tray and service controls, an embedded Control UI, reconnect handling, deep links, autostart, window restoration, update notices, and native alerts for pending requests. Quick Chat switches agents, keeps one Gateway connection open, streams replies in the bar, and shows whether a send was accepted, failed, or is waiting for reconnection.

The build and publication path supports .deb and AppImage packages, although their availability as v2026.8.1 downloads has not yet been verified. The summon shortcut works on X11, Wayland keeps the tray entry, and approval decisions remain in the Dashboard or command line.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add a Linux desktop companion app [#106352](https://github.com/openclaw/openclaw/pull/106352)
- Add Linux companion packages, brand icons, and Gateway guidance [#106533](https://github.com/openclaw/openclaw/pull/106533)
- Add Linux desktop companion OS integration [#109236](https://github.com/openclaw/openclaw/pull/109236)
- Add Linux approval alerts and a summon shortcut [#109322](https://github.com/openclaw/openclaw/pull/109322)
- Add Quick Chat to the Linux companion [#109947](https://github.com/openclaw/openclaw/pull/109947)
- Add agent switching and shortcut controls to Linux Quick Chat [#110285](https://github.com/openclaw/openclaw/pull/110285)
- Connect Linux Quick Chat directly to the Gateway [#110491](https://github.com/openclaw/openclaw/pull/110491)
- Stream Linux Quick Chat replies in the bar [#110632](https://github.com/openclaw/openclaw/pull/110632)
- Render interactive widgets in Linux Quick Chat [#111933](https://github.com/openclaw/openclaw/pull/111933)
- Publish Linux companion packages with stable releases [#106891](https://github.com/openclaw/openclaw/pull/106891)
- Use the Clawd mascot for Linux desktop icons [#108181](https://github.com/openclaw/openclaw/pull/108181)

**Bug fixes**

- Stabilize Linux Quick Chat widgets [#112261](https://github.com/openclaw/openclaw/pull/112261)
- Package Linux media playback codecs [#115616](https://github.com/openclaw/openclaw/pull/115616)
- Hide Linux Quick Chat before stale widget cleanup [#112308](https://github.com/openclaw/openclaw/pull/112308)
- Keep Linux Quick Chat on-screen across DPI and widget resizes [#114271](https://github.com/openclaw/openclaw/pull/114271)
- fix(linux): Quick Chat ignores the configured Gateway accent [#129451](https://github.com/openclaw/openclaw/pull/129451)

</details>

</Accordion>

<Accordion title="Progress and Presentation by Native App">

On iOS, macOS, and Android, rich [progress cards](/tools/progress-card) can remain above the composer after a run and return through a relaunch or reconnect when the connected Gateway supports saved cards. Those clients also show a working Claw, elapsed time, and long-wait status while a turn runs, then add a duration and token recap when it completes successfully and unambiguously. Older Gateways can still show live fallback cards, but they cannot restore those cards after relaunch, and Android's fallback can sometimes retain a stale completed status.

[Assistant-created widgets](/web/dashboards) can render inline on iOS, Android, macOS, and Linux Quick Chat when the client advertises support, and an eligible connected Mac can also present one in its native Canvas panel. Linux Quick Chat remains text-only when it uses a custom Gateway TLS leaf pin. Expandable file-edit diffs cover a narrower set of clients and appear on iPhone, iPad, and Mac.

Runtime translations now reach Android's main workflows and named iPhone, iPad, Live Activity, Apple Watch, and Wear status surfaces, with a per-app language picker on Android. Identity-bound iOS, macOS, and Android connections follow the user's profile accent as it changes across devices, and voice surfaces on iOS, watchOS, macOS, and Android share the same phase-based waveform, using synthetic motion where live metering is unavailable.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Unified voice waveform with live audio feedback across native apps [#102901](https://github.com/openclaw/openclaw/pull/102901)
- Add responsive moods and Easter eggs to the Apple app mascot [#104255](https://github.com/openclaw/openclaw/pull/104255)
- Add interactive inline widgets to native chats [#109212](https://github.com/openclaw/openclaw/pull/109212)
- Bring native macOS chat closer to web chat parity [#109712](https://github.com/openclaw/openclaw/pull/109712)
- Improve native chat copying, long-message reading, and trace controls [#110276](https://github.com/openclaw/openclaw/pull/110276)
- Show Apple chat tool activity as expandable rows [#110618](https://github.com/openclaw/openclaw/pull/110618)
- Copy or save chat widgets as images on Apple platforms [#110987](https://github.com/openclaw/openclaw/pull/110987)
- Show file-edit diffs in iOS and macOS chat [#111039](https://github.com/openclaw/openclaw/pull/111039)
- Complete inline tool diffs in Apple chat [#111326](https://github.com/openclaw/openclaw/pull/111326)
- Add session dashboards to iOS and Android [#112163](https://github.com/openclaw/openclaw/pull/112163)
- Bring the working claw and turn recap to iOS and macOS [#112188](https://github.com/openclaw/openclaw/pull/112188)
- Bring live session observer summaries to native apps [#112597](https://github.com/openclaw/openclaw/pull/112597)
- Show live Swarm worker progress in native chat apps [#113850](https://github.com/openclaw/openclaw/pull/113850)
- Show live subagent activity in Apple chat [#121815](https://github.com/openclaw/openclaw/pull/121815)
- Show system notices and history boundaries in Apple chat [#122255](https://github.com/openclaw/openclaw/pull/122255)
- View a machine desktop from iOS and Android [#123097](https://github.com/openclaw/openclaw/pull/123097)
- Bring durable progress cards to iOS and macOS [#125442](https://github.com/openclaw/openclaw/pull/125442)
- feat(apps): resolve the per-profile accent live on iOS, macOS, and Android [#130598](https://github.com/openclaw/openclaw/pull/130598)
- Use thread wording across native chat apps [#111038](https://github.com/openclaw/openclaw/pull/111038)
- Refresh generated native catalogs across all supported locales [#112441](https://github.com/openclaw/openclaw/pull/112441)
- Add zen, drummer, and peekaboo working-claw animations [#112570](https://github.com/openclaw/openclaw/pull/112570)
- Refresh generated native app translations [#112662](https://github.com/openclaw/openclaw/pull/112662)
- Refresh native app translations [#114915](https://github.com/openclaw/openclaw/pull/114915)
- Refresh translations across native apps [#115532](https://github.com/openclaw/openclaw/pull/115532)
- Add four rare working-claw animations [#120826](https://github.com/openclaw/openclaw/pull/120826)
- Refresh native translations for chat recovery and history messages [#122355](https://github.com/openclaw/openclaw/pull/122355)
- chore(i18n): refresh native locales [#128759](https://github.com/openclaw/openclaw/pull/128759)
- chore(i18n): refresh native locales [#133074](https://github.com/openclaw/openclaw/pull/133074)
- Share Apple chat gateway payload mapping [#106154](https://github.com/openclaw/openclaw/pull/106154)
- Replace the wide jump-to-latest pill with a compact button [#110651](https://github.com/openclaw/openclaw/pull/110651)
- Sharpen the working-claw icon across apps [#114939](https://github.com/openclaw/openclaw/pull/114939)
- Refresh current Android and iOS translations [#120352](https://github.com/openclaw/openclaw/pull/120352)
- Refresh generated native app locales [#121000](https://github.com/openclaw/openclaw/pull/121000)
- Refresh generated native app locales [#121561](https://github.com/openclaw/openclaw/pull/121561)
- Refresh generated Android and iOS locales [#123101](https://github.com/openclaw/openclaw/pull/123101)
- Refresh generated native app locales [#124089](https://github.com/openclaw/openclaw/pull/124089)
- chore(i18n): refresh native locales [#131987](https://github.com/openclaw/openclaw/pull/131987)

**Bug fixes**

- Harden mobile Gateway sessions and Apple Watch reply state [2c316f5](https://github.com/openclaw/openclaw/commit/2c316f5)
- Fence stale Watch actions and preserve retried attachments [7838c6a](https://github.com/openclaw/openclaw/commit/7838c6a)
- Make Apple timeouts return promptly and keep retries safe [#103066](https://github.com/openclaw/openclaw/pull/103066)
- Restore native live updates after reconnects [#113634](https://github.com/openclaw/openclaw/pull/113634)
- Render assistant-generated images in native chat [#115042](https://github.com/openclaw/openclaw/pull/115042)
- Restore native Talk behavior across iOS, Android, and macOS [#115577](https://github.com/openclaw/openclaw/pull/115577)
- Restore plan cards with released Gateways on Apple apps [#125588](https://github.com/openclaw/openclaw/pull/125588)
- Resync native translations after Android inventory drift [bd03b4d](https://github.com/openclaw/openclaw/commit/bd03b4d)
- Restore native runtime, Watch avatar, browser graphics, and local audio behavior [#107631](https://github.com/openclaw/openclaw/pull/107631)
- Use native desktop system notifications [#109901](https://github.com/openclaw/openclaw/pull/109901)
- Keep Jump to latest hidden at the live edge [#110811](https://github.com/openclaw/openclaw/pull/110811)
- Localize Android flavor and Apple settings surfaces [#113214](https://github.com/openclaw/openclaw/pull/113214)
- Refresh native locales and fix Indonesian countdown units [#113289](https://github.com/openclaw/openclaw/pull/113289)
- Preserve images and voice notes in native chat and exports [#113764](https://github.com/openclaw/openclaw/pull/113764)
- Restore Apple chat sidebar ordering and search [#113886](https://github.com/openclaw/openclaw/pull/113886)
- Preserve literal Markdown image examples in native chat [#113904](https://github.com/openclaw/openclaw/pull/113904)
- Localize Apple gateway discovery status [#115051](https://github.com/openclaw/openclaw/pull/115051)
- Show expanded disclosure content on Apple platforms [#115863](https://github.com/openclaw/openclaw/pull/115863)
- Keep iOS attachments available when routing is unknown [#116787](https://github.com/openclaw/openclaw/pull/116787)
- Refresh native translations for subagent status [#121939](https://github.com/openclaw/openclaw/pull/121939)
- Match embedded Control UI to mobile app appearance [#123408](https://github.com/openclaw/openclaw/pull/123408)
- fix(macos): prevent duplicate New Chat sessions and stale navigation [#127693](https://github.com/openclaw/openclaw/pull/127693)
- fix(apps): prevent Unicode numerals from freezing code highlights [#128364](https://github.com/openclaw/openclaw/pull/128364)
- fix(location): reject future-dated cached fixes [#128591](https://github.com/openclaw/openclaw/pull/128591)
- fix(nodes): report camera positions the hardware actually reached [#128595](https://github.com/openclaw/openclaw/pull/128595)
- feat(ios): adopt gateway user accent in chat [#128599](https://github.com/openclaw/openclaw/pull/128599)
- chore(i18n): refresh native locales [#130270](https://github.com/openclaw/openclaw/pull/130270)
- fix(apple): avoid rebuilding unchanged tool diff previews [#130615](https://github.com/openclaw/openclaw/pull/130615)
- chore(i18n): refresh native locales [#130667](https://github.com/openclaw/openclaw/pull/130667)
- fix(apple): load chat media behind reverse-proxy paths [#130755](https://github.com/openclaw/openclaw/pull/130755)
- fix(ios): avoid duplicate Markdown work while replies stream [#131513](https://github.com/openclaw/openclaw/pull/131513)
- Refresh native app translations and locale catalogs [#115608](https://github.com/openclaw/openclaw/pull/115608)
- fix(apple): bind widget snapshots to their document owner [#129666](https://github.com/openclaw/openclaw/pull/129666)
- fix(talk): preserve replacement speech when an old utterance is canceled [#130687](https://github.com/openclaw/openclaw/pull/130687)
- fix(i18n): show Hindi search match counts in argument order [#132176](https://github.com/openclaw/openclaw/pull/132176)
- Stabilize streamed replies in Apple chat [#50483](https://github.com/openclaw/openclaw/pull/50483)

</details>

</Accordion>

</AccordionGroup>
