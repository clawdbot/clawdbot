---
title: "v2026.8.1: Browser and Computer Use"
description: "Signed-in browser sessions through an isolated managed profile or the Chrome tabs you share, and Computer Use on paired Macs and explicitly enabled Windows machines."
---

OpenClaw can now use [signed-in browser sessions](/tools/browser-login) through an isolated managed profile or the exact Chrome tabs you choose to share. On macOS, supported cookies can be imported locally or synced to a remote managed browser for an allowlist of sites you choose, while the official Chrome extension keeps live access scoped to shared tabs. Browser actions, downloads, and desktop input also stay attached to their intended tab, page state, and machine, with cancellation and timeouts reaching more of the local and remote work they own.

[Computer Use](/nodes/computer-use) can work with supported apps and windows on paired Macs and explicitly enabled Windows machines, and the Desktop panel can open the machine that owns a session. Control still requires the applicable pairing, policy, and operating-system permissions, view-only sessions reject input, and Linux control remains experimental.

<AccordionGroup>

<Accordion title="Browser setup">

On a Mac, you can explicitly copy compatible cookies from Chrome, Brave, Edge, or Chromium into an [isolated managed browser](/tools/browser) after approving Keychain or Touch ID access. If that browser runs on another OpenClaw machine, a separate opt-in sync can send cookies once or continuously for only the sites you allow. Neither path copies local storage or IndexedDB, and device-bound sessions can still ask you to sign in again.

For a browser you already have open, the Apps page now points to the official [Chrome extension](/tools/chrome-extension) and the command line can prepare its local connection. You decide which tabs to share, each shared tab can have its own copilot, and sending a page, supported document or thread, or selected text to the main conversation is a one-time handoff rather than continuing access to the rest of your browser.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Open macOS dashboard links in a sidebar browser [#102899](https://github.com/openclaw/openclaw/pull/102899)
- Add tabs to the macOS dashboard link browser [#103438](https://github.com/openclaw/openclaw/pull/103438)
- Import Chrome-family cookies into managed browser profiles [#104057](https://github.com/openclaw/openclaw/pull/104057)
- Add browser-login import to the macOS app [#104177](https://github.com/openclaw/openclaw/pull/104177)
- Replace macOS cookie-import alerts with a dashboard banner [#104591](https://github.com/openclaw/openclaw/pull/104591)
- Add secure per-tab Chrome copilot panels [#109817](https://github.com/openclaw/openclaw/pull/109817)
- Send pages to the main session from the Chrome extension [#111158](https://github.com/openclaw/openclaw/pull/111158)
- Add Puppeteer support to the Chrome extension relay [#117915](https://github.com/openclaw/openclaw/pull/117915)
- Make the Chrome Web Store the primary extension action [#123377](https://github.com/openclaw/openclaw/pull/123377)
- Sync Mac browser cookies to a remote Gateway profile [#123494](https://github.com/openclaw/openclaw/pull/123494)
- Open external links in the docked Control UI browser [#123912](https://github.com/openclaw/openclaw/pull/123912)
- Show managed Chrome graphics details in status and doctor [#104291](https://github.com/openclaw/openclaw/pull/104291)
- Preserve browser identity in direct CDP diagnostics [#104678](https://github.com/openclaw/openclaw/pull/104678)
- fix(browser): warn when Chrome extension version drifts after upgrades [#119641](https://github.com/openclaw/openclaw/pull/119641)

**Bug fixes**

- Support native bootstrap for the official Chrome Web Store extension [#124775](https://github.com/openclaw/openclaw/pull/124775)
- Fix Browser profiles with prototype-like names and custom state paths [#101694](https://github.com/openclaw/openclaw/pull/101694)
- Make browser profile guidance respect configured defaults [#102582](https://github.com/openclaw/openclaw/pull/102582)
- Preserve actionable browser no-display failures and headless recovery [#102946](https://github.com/openclaw/openclaw/pull/102946)
- Fix macOS dashboard tab reuse and reordering [#103464](https://github.com/openclaw/openclaw/pull/103464)
- Show the macOS cookie-import offer only when browsing [#106255](https://github.com/openclaw/openclaw/pull/106255)
- Open macOS dashboard links at a useful width [#107798](https://github.com/openclaw/openclaw/pull/107798)
- Detect Windows browsers when install roots are blank [#111256](https://github.com/openclaw/openclaw/pull/111256)
- fix(browser): detect selected profile executable consistently [#129394](https://github.com/openclaw/openclaw/pull/129394)
- fix(browser): native bootstrap stalls before replying [#132212](https://github.com/openclaw/openclaw/pull/132212)
- Remove the gap above macOS link-browser tabs [#103469](https://github.com/openclaw/openclaw/pull/103469)
- Restore host-local browser profile administration [#104616](https://github.com/openclaw/openclaw/pull/104616)
- Skip unusable browsers during automatic discovery [#111951](https://github.com/openclaw/openclaw/pull/111951)
- Return a failing exit status for unhealthy Browser doctor reports [#116811](https://github.com/openclaw/openclaw/pull/116811)
- Resolve packaged Chrome extension assets in Browser Doctor [#126279](https://github.com/openclaw/openclaw/pull/126279)
- fix(browser): reject non-decimal --wait-ms during extension install [#130626](https://github.com/openclaw/openclaw/pull/130626)
- fix(browser): report native hosts with missing runtime targets [#131907](https://github.com/openclaw/openclaw/pull/131907)
- fix(browser): avoid missing-directory diagnosis after native-host refusals [#132891](https://github.com/openclaw/openclaw/pull/132891)

**Documentation**

- Document macOS cookie sync to a remote browser [#123537](https://github.com/openclaw/openclaw/pull/123537)
- Correct Docker sandbox browser setup documentation [#115254](https://github.com/openclaw/openclaw/pull/115254)
- Document mcporter Chrome relay auto-detection [#118066](https://github.com/openclaw/openclaw/pull/118066)
- docs: declared local browser profiles must set cdpPort or cdpUrl [#129923](https://github.com/openclaw/openclaw/pull/129923)

</details>

</Accordion>

<Accordion title="Browsing and page actions">

Navigation now returns a compact fresh view of the page for the next action, and snapshot references stay aligned with the content that appears in the final bounded snapshot. Multi-action batches pause after moving to a new document or closing a page so the next step can use fresh state, while new tabs can open in the background and the chosen locale, timezone, and device settings remain attached to the controlled page. Agents can also read bounded visible text, inspect recent network requests and uncaught page errors, and find matching controls in a snapshot without custom page evaluation. Page-controlled text and diagnostics remain untrusted, and existing-session profiles cannot collect the page-error log.

Command-line users can run a [repeatable JSON plan](/cli/browser) against one tab, keep ordered results, and choose whether a failure stops the batch or allows the remaining actions to finish. The conversation can show the active tab's title, URL, and latest thumbnail, then open the matching page in the Browser panel while keeping its session profile and machine attached. Cancelled or timed-out downloads stop without claiming a later request's file or publishing unwanted partial output, although a download already in its final save can still finish.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add batch browser actions to the CLI [#111457](https://github.com/openclaw/openclaw/pull/111457)
- Make browser batches and snapshots safer to continue [#113749](https://github.com/openclaw/openclaw/pull/113749)
- Add one-call Browser page question answering [#113861](https://github.com/openclaw/openclaw/pull/113861)
- Add scoped and structured browser extraction [#113938](https://github.com/openclaw/openclaw/pull/113938)
- Return compact page state after browser navigation [#114814](https://github.com/openclaw/openclaw/pull/114814)
- feat(browser): agent requests/text/emulate + snapshot query, and inline browser-tab thumbnail cards [#131592](https://github.com/openclaw/openclaw/pull/131592)
- feat(browser): expose the page errors action [#131906](https://github.com/openclaw/openclaw/pull/131906)
- docs(browser): expose batch/doubleClick/scrollIntoView/labels in tool schema and docs [#111381](https://github.com/openclaw/openclaw/pull/111381)
- Remove hidden model-backed Browser extraction [#120101](https://github.com/openclaw/openclaw/pull/120101)
- improve(browser): speed up repeated DOM snapshot finalization [#128036](https://github.com/openclaw/openclaw/pull/128036)

**Bug fixes**

- Let sequential browser actions finish within their budget [#104659](https://github.com/openclaw/openclaw/pull/104659)
- Enforce final size budgets for browser role snapshots [#104689](https://github.com/openclaw/openclaw/pull/104689)
- Open agent browser tabs without stealing focus [#105356](https://github.com/openclaw/openclaw/pull/105356)
- Preserve browser locale, timezone, and device overrides [#119695](https://github.com/openclaw/openclaw/pull/119695)
- Stop managed browser uploads from firing duplicate events [#103777](https://github.com/openclaw/openclaw/pull/103777)
- Refresh browser targets after guarded actions [#104094](https://github.com/openclaw/openclaw/pull/104094)
- Make browser file chooser uploads request-owned [#105151](https://github.com/openclaw/openclaw/pull/105151)
- fix(browser): don't steal focus on headed screenshot captures [#105393](https://github.com/openclaw/openclaw/pull/105393)
- Recognize mixed-case media types in web fetch [#108230](https://github.com/openclaw/openclaw/pull/108230)
- Keep case-distinct web requests from sharing cached content [#111281](https://github.com/openclaw/openclaw/pull/111281)
- Speed up extraction of large style-heavy webpages [#115584](https://github.com/openclaw/openclaw/pull/115584)
- fix(browser): resolve agent dir for screenshot descriptions [#121941](https://github.com/openclaw/openclaw/pull/121941)
- Stop cancelled browser downloads from capturing later files [#124382](https://github.com/openclaw/openclaw/pull/124382)
- fix(ui): show browser inspection failures without attaching stale elements [#128263](https://github.com/openclaw/openclaw/pull/128263)
- fix(browser): stop downloads hanging after their timeout [#129899](https://github.com/openclaw/openclaw/pull/129899)
- fix(browser): restore new-element markers across snapshot requests [#130220](https://github.com/openclaw/openclaw/pull/130220)
- fix(browser): accept common keyboard aliases [#130401](https://github.com/openclaw/openclaw/pull/130401)
- fix(browser): preserve exact select option values [#130410](https://github.com/openclaw/openclaw/pull/130410)
- fix(browser): hidden selectors prematurely complete waits [#130508](https://github.com/openclaw/openclaw/pull/130508)
- fix(browser): preserve literal names and formatter-owned snapshot refs [#130599](https://github.com/openclaw/openclaw/pull/130599)
- fix(browser): make snapshot refs work with quoted labels and frames [#130623](https://github.com/openclaw/openclaw/pull/130623)
- fix(browser): stop reporting failed nested batches as successful [#130809](https://github.com/openclaw/openclaw/pull/130809)
- fix(browser): resolve unnamed role refs and initialize AX markers [#130881](https://github.com/openclaw/openclaw/pull/130881)
- fix(browser): click the first duplicate raw accessibility ref [#130929](https://github.com/openclaw/openclaw/pull/130929)
- fix: cancel browser downloads when saving the output fails [#131048](https://github.com/openclaw/openclaw/pull/131048)
- fix(browser): return selector no-match snapshots promptly [#131441](https://github.com/openclaw/openclaw/pull/131441)
- fix(browser): keep the panel on the session browser profile [#132159](https://github.com/openclaw/openclaw/pull/132159)
- Normalize local browser request paths [#103727](https://github.com/openclaw/openclaw/pull/103727)
- Reject hexadecimal Browser click coordinates [#104440](https://github.com/openclaw/openclaw/pull/104440)
- Normalize Browser geolocation permission origins [#105092](https://github.com/openclaw/openclaw/pull/105092)
- Report the committed URL for newly opened browser tabs [#111374](https://github.com/openclaw/openclaw/pull/111374)
- Keep highlighted words intact in DuckDuckGo results [#111460](https://github.com/openclaw/openclaw/pull/111460)
- Prevent stale web fetches after User-Agent changes [#111806](https://github.com/openclaw/openclaw/pull/111806)
- Preserve the Browser tool output schema during lazy registration [#113925](https://github.com/openclaw/openclaw/pull/113925)
- fix(browser): bound batch action files [#115882](https://github.com/openclaw/openclaw/pull/115882)
- Allow page extraction in tab-bound Browser Copilot runs [#116779](https://github.com/openclaw/openclaw/pull/116779)
- Make browser screenshot sharing guidance capability-neutral [#125597](https://github.com/openclaw/openclaw/pull/125597)
- fix(browser): keep inspection state independent of error wording [#128625](https://github.com/openclaw/openclaw/pull/128625)
- fix(browser): stop cancelled downloads from publishing files [#128651](https://github.com/openclaw/openclaw/pull/128651)
- fix(browser): keep action URLs out of Gateway transport [#128870](https://github.com/openclaw/openclaw/pull/128870)

**Documentation**

- Clarify browser JSON flag placement [#103155](https://github.com/openclaw/openclaw/pull/103155)
- [AI-assisted] docs(browser): teach the code-mode global call, not the removed tools.call API [#128456](https://github.com/openclaw/openclaw/pull/128456)

</details>

</Accordion>

<Accordion title="Computer Use">

On a paired Mac, [Computer Use](/nodes/computer-use) can capture the desktop and work with supported apps, windows, and elements through pointer, keyboard, scroll, drag, and wait actions. Settings now shows the selected provider, Accessibility and Screen Recording state, and whether its supporting service is ready. Using those controls still requires pairing, the applicable command and tool policy, required arming, and the macOS permissions OpenClaw reports but cannot grant.

Explicitly enabled Windows machines now use the packaged Computer Use driver without a separately installed service. Linux uses the packaged route too and remains experimental, with complete live click-and-type behavior still unverified in this release. Codex Computer Use remains a separate macOS integration with its own readiness and recovery checks.

The Desktop panel can show the main OpenClaw machine, a Labs headless Linux desktop, or an explicitly enabled paired Mac, Windows, or Linux machine, and session buttons can open the computer that owns the work. Paired streaming is off by default, and view-only sessions keep keyboard, pointer, and clipboard input blocked.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Control paired Mac desktops with the computer tool [#102776](https://github.com/openclaw/openclaw/pull/102776)
- Add live readiness and recovery for Codex Computer Use [#103331](https://github.com/openclaw/openclaw/pull/103331)
- Let agents arrange the Control UI with a screen tool [#108737](https://github.com/openclaw/openclaw/pull/108737)
- Add experimental Windows and Linux computer control [#112267](https://github.com/openclaw/openclaw/pull/112267)
- Enable macOS Computer Control by default with clearer permission diagnostics [#115280](https://github.com/openclaw/openclaw/pull/115280)
- Replace the CUA daemon with the packaged Driver SDK [#117205](https://github.com/openclaw/openclaw/pull/117205)
- View the Gateway machine in the Desktop panel [#122545](https://github.com/openclaw/openclaw/pull/122545)
- Manage a headless Linux host desktop [#122677](https://github.com/openclaw/openclaw/pull/122677)
- View paired node desktops in the Control UI [#122724](https://github.com/openclaw/openclaw/pull/122724)
- Add fullscreen mode to the Desktop preview [#123278](https://github.com/openclaw/openclaw/pull/123278)
- Adopt Peekaboo's checked runtime for macOS Computer Control [#123420](https://github.com/openclaw/openclaw/pull/123420)
- Add background window and element control to the Windows and Linux computer tool [#123604](https://github.com/openclaw/openclaw/pull/123604)
- Add an embedded CUA computer-control provider to macOS [#123635](https://github.com/openclaw/openclaw/pull/123635)
- Add native Peekaboo support for computer.act v2 [#123801](https://github.com/openclaw/openclaw/pull/123801)
- Show Computer Control readiness in Settings [#124093](https://github.com/openclaw/openclaw/pull/124093)
- Update macOS Peekaboo to 3.9.0 [#104398](https://github.com/openclaw/openclaw/pull/104398)
- Gate Peekaboo Bridge on Computer Control [#106531](https://github.com/openclaw/openclaw/pull/106531)
- perf(computer): stop resending unchanged computer-use screenshots [#129924](https://github.com/openclaw/openclaw/pull/129924)
- Package a portable macOS elevation-host installer [#123675](https://github.com/openclaw/openclaw/pull/123675)

**Bug fixes**

- Restore Codex Computer Use with current ChatGPT desktop resources [#103470](https://github.com/openclaw/openclaw/pull/103470)
- Stop repeated Computer Use readiness stalls [#113393](https://github.com/openclaw/openclaw/pull/113393)
- Open each mobile session's own desktop [#123412](https://github.com/openclaw/openclaw/pull/123412)
- Verify CUA driver artifacts on Windows and Linux nodes [#123986](https://github.com/openclaw/openclaw/pull/123986)
- Fix macOS background computer use and add a live proof rig [#123991](https://github.com/openclaw/openclaw/pull/123991)
- Repair Computer Use driver verification and post-approval capabilities [#124128](https://github.com/openclaw/openclaw/pull/124128)
- Align computer-use reference lifecycles across providers [#124374](https://github.com/openclaw/openclaw/pull/124374)
- Restore desktop computer control when CUA is active [#124863](https://github.com/openclaw/openclaw/pull/124863)
- Refresh stale isolated Computer Use bundles [#126080](https://github.com/openclaw/openclaw/pull/126080)
- Unblock Codex Computer Use after installation [#126699](https://github.com/openclaw/openclaw/pull/126699)
- fix(gateway): restore view-only macOS desktop observation [#128306](https://github.com/openclaw/openclaw/pull/128306)
- fix(cloud): bind computer control to session desktops [#132374](https://github.com/openclaw/openclaw/pull/132374)
- Let Codex start with computer control enabled [#102944](https://github.com/openclaw/openclaw/pull/102944)
- Prevent stalled process inspection from blocking Codex Computer Use [#109091](https://github.com/openclaw/openclaw/pull/109091)
- Keep view-only Cloud Worker Desktops connected [#121256](https://github.com/openclaw/openclaw/pull/121256)
- Open the current session desktop directly [#122992](https://github.com/openclaw/openclaw/pull/122992)
- Make the macOS CUA driver handoff atomic [#123845](https://github.com/openclaw/openclaw/pull/123845)
- Initialize CUA resources on first use [#124156](https://github.com/openclaw/openclaw/pull/124156)
- Allow tested newer Codex Desktop app-servers [#125883](https://github.com/openclaw/openclaw/pull/125883)
- Resolve the ESM-only CUA driver during artifact checks [#126120](https://github.com/openclaw/openclaw/pull/126120)
- fix(codex): allow computer reuse across completed runs [#126399](https://github.com/openclaw/openclaw/pull/126399)
- fix(codex): keep Computer Use working after desktop updates [#127778](https://github.com/openclaw/openclaw/pull/127778)
- fix(codex): restore Computer Use after marketplace source upgrades [#129551](https://github.com/openclaw/openclaw/pull/129551)
- fix(ui): Desktop does not follow the chat session machine [#132255](https://github.com/openclaw/openclaw/pull/132255)
- fix(computer): keep observations available during recovery [#133188](https://github.com/openclaw/openclaw/pull/133188)
- fix(cua-computer): return zoom images to the model [#133266](https://github.com/openclaw/openclaw/pull/133266)
- Load the CUA computer driver on Windows and Linux nodes [#120169](https://github.com/openclaw/openclaw/pull/120169)
- Preserve legacy CUA driverPath compatibility [#120502](https://github.com/openclaw/openclaw/pull/120502)
- Accept noVNC extended clipboard framing [#121276](https://github.com/openclaw/openclaw/pull/121276)
- Pin the macOS companion to finalized Peekaboo 4.2.1 [#125208](https://github.com/openclaw/openclaw/pull/125208)
- Keep newer Codex Desktop app-servers eligible [#126450](https://github.com/openclaw/openclaw/pull/126450)
- Restore screen for exact tool allowlists [#126691](https://github.com/openclaw/openclaw/pull/126691)
- fix(macos): avoid publishing retired CUA startup endpoints [#131905](https://github.com/openclaw/openclaw/pull/131905)

**Documentation**

- Refresh native translations for Peekaboo Bridge guidance [#106543](https://github.com/openclaw/openclaw/pull/106543)
- Refresh cua-driver platform and MCP tool documentation [78b49f3](https://github.com/openclaw/openclaw/commit/78b49f3)
- Add cua-computer troubleshooting guidance [#112502](https://github.com/openclaw/openclaw/pull/112502)
- Fix the Windows and Linux Computer Use section link [#123892](https://github.com/openclaw/openclaw/pull/123892)
- Clarify the computer-use authorization boundary [#124355](https://github.com/openclaw/openclaw/pull/124355)
- Refresh release baselines and CUA Computer platform docs [#125586](https://github.com/openclaw/openclaw/pull/125586)

</details>

</Accordion>

<Accordion title="Remote screens and devices">

OpenClaw now keeps browser and computer work on the explicitly selected eligible [paired machine](/gateway/cloud-sessions). A disconnected, ambiguous, or ineligible selector returns an actionable error for that device, while unpinned automatic browser routing can still use the main machine when policy permits.

Browser uploads and downloads can move between the main machine and a remote Browser node without a shared filesystem, and completed downloads return as readable local files. Terminal uploads can place safely quoted remote paths into the active shell without pressing Enter. Transfer size and authorization limits remain in force, malformed screenshots and Canvas data stop before dispatch, and Android accessibility control remains an opt-in local foundation for third-party builds that a Gateway or agent cannot invoke yet.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Upload files directly into Control UI terminals [#107364](https://github.com/openclaw/openclaw/pull/107364)
- Add terminal upload progress, retry, and cancel controls [#107789](https://github.com/openclaw/openclaw/pull/107789)
- Select computer-use nodes by capability [#112107](https://github.com/openclaw/openclaw/pull/112107)
- Add an opt-in Android accessibility UI executor [#112232](https://github.com/openclaw/openclaw/pull/112232)

**Bug fixes**

- Restore Android Canvas presentation across the app [#103330](https://github.com/openclaw/openclaw/pull/103330)
- Restore scoped Gateway-hosted Canvas on macOS [#105336](https://github.com/openclaw/openclaw/pull/105336)
- Honor configured browser node pins across routes [#117087](https://github.com/openclaw/openclaw/pull/117087)
- Make browser node-host downloads usable from the Gateway [#103328](https://github.com/openclaw/openclaw/pull/103328)
- Resolve Unicode browser node display names consistently [#103548](https://github.com/openclaw/openclaw/pull/103548)
- Reject invalid Canvas A2UI JSONL before device dispatch [#103713](https://github.com/openclaw/openclaw/pull/103713)
- Preserve identity for approved local node commands [#103886](https://github.com/openclaw/openclaw/pull/103886)
- Stop advertising disabled browser proxies on headless nodes [#103894](https://github.com/openclaw/openclaw/pull/103894)
- Let approved commands run on macOS allowlist nodes [#104337](https://github.com/openclaw/openclaw/pull/104337)
- Reject oversized directory transfers during preflight [#106293](https://github.com/openclaw/openclaw/pull/106293)
- Make timed iOS reminders notify at their due time [#106376](https://github.com/openclaw/openclaw/pull/106376)
- Preserve startup keystrokes and harden remote terminal sessions [#107214](https://github.com/openclaw/openclaw/pull/107214)
- Keep embedded terminals connected during heavy output [#107348](https://github.com/openclaw/openclaw/pull/107348)
- Prevent computer control from targeting the wrong paired node [#112503](https://github.com/openclaw/openclaw/pull/112503)
- Make uploads work with remote browser nodes [#115291](https://github.com/openclaw/openclaw/pull/115291)
- Stop browser node discovery when a turn is cancelled [#124880](https://github.com/openclaw/openclaw/pull/124880)
- Restore static plugin commands on headless node hosts [#127043](https://github.com/openclaw/openclaw/pull/127043)
- Clarify malformed nodes invoke parameter errors [#101838](https://github.com/openclaw/openclaw/pull/101838)
- Return basename-only Agent Core file names on Windows [#102813](https://github.com/openclaw/openclaw/pull/102813)
- Reject malformed Canvas snapshot data [#108987](https://github.com/openclaw/openclaw/pull/108987)
- Deliver title-only and body-only node notifications [#113747](https://github.com/openclaw/openclaw/pull/113747)
- Reject malformed computer-use screenshots early [#114392](https://github.com/openclaw/openclaw/pull/114392)

**Documentation**

- Add a complete guide to iPhone HealthKit summaries [8a375c4](https://github.com/openclaw/openclaw/commit/8a375c4)
- Correct macOS node command documentation [#103878](https://github.com/openclaw/openclaw/pull/103878)
- Correct the system.which node examples [#103960](https://github.com/openclaw/openclaw/pull/103960)

</details>

</Accordion>

<Accordion title="Browser Targeting, Privacy, and Timeouts">

Tab handles, page references, screenshots, and desktop actions now remain bound to the tab, page, display, request, and provider that created them. Stale or ambiguous state stops with an error, cancellation and timeouts reach more of the local and remote work they own, and relay reconnects restore only tabs that are still shared.

Remote browser connections are validated and remain pinned to their configured endpoint, connection credentials are redacted on the supported paths, and page-controlled text enters model context as untrusted input. [Browser](/tools/browser) and Canvas screenshots remain available to the inspecting agent but are no longer attached automatically to outbound replies. Cleanup stays limited to browsers and tabs OpenClaw owns, and older extension clients may need an upgrade or fresh pairing for the newer relay protections.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add Browser Relay Authentication v2 [#120526](https://github.com/openclaw/openclaw/pull/120526)
- Allow one browser-tool retry after transient failures [#110607](https://github.com/openclaw/openclaw/pull/110607)
- Keep Browser upload cleanup lazy at Gateway startup [#126136](https://github.com/openclaw/openclaw/pull/126136)
- fix(browser): load Playwright runtime on demand [#127049](https://github.com/openclaw/openclaw/pull/127049)
- Diagnose web fetch proxy settings that remain inactive [#109778](https://github.com/openclaw/openclaw/pull/109778)

**Bug fixes**

- Protect credentials for authenticated remote browser connections [#103139](https://github.com/openclaw/openclaw/pull/103139)
- Prevent stale or replayed desktop actions [#103422](https://github.com/openclaw/openclaw/pull/103422)
- Prevent stale browser profile starts from resurrecting after cleanup [#104601](https://github.com/openclaw/openclaw/pull/104601)
- Keep browser tools usable when one shared tab hangs [#113921](https://github.com/openclaw/openclaw/pull/113921)
- Pin guarded Browser CDP sockets to validated endpoints [#114506](https://github.com/openclaw/openclaw/pull/114506)
- Protect Browser and Canvas observation privacy boundaries [#118775](https://github.com/openclaw/openclaw/pull/118775)
- Show browser pairing and tab-sharing failures [#119526](https://github.com/openclaw/openclaw/pull/119526)
- Harden Chrome extension relay pairing and tab consent [#120390](https://github.com/openclaw/openclaw/pull/120390)
- Classify Computer Use action risk before node dispatch [#124112](https://github.com/openclaw/openclaw/pull/124112)
- Cancel local browser actions with stopped agent turns [#124795](https://github.com/openclaw/openclaw/pull/124795)
- fix(browser): restore MCP page creation through the extension relay [#132232](https://github.com/openclaw/openclaw/pull/132232)
- fix(browser): preserve shared Chrome tabs during tracing and reconnects [#132485](https://github.com/openclaw/openclaw/pull/132485)
- Keep strict CDP discovery bound to the configured browser [7d0f9de](https://github.com/openclaw/openclaw/commit/7d0f9de)
- Keep Node 24 browser actions alive through request handling [c0d99ed](https://github.com/openclaw/openclaw/commit/c0d99ed)
- Bound Chrome startup diagnostics without losing recovery hints [#101506](https://github.com/openclaw/openclaw/pull/101506)
- Keep browser tab actions limited to real page targets [#103115](https://github.com/openclaw/openclaw/pull/103115)
- Reject ambiguous browser tab references [#103119](https://github.com/openclaw/openclaw/pull/103119)
- Prevent browser actions from targeting the wrong tab [#103177](https://github.com/openclaw/openclaw/pull/103177)
- Honor evaluate timeouts for existing browser sessions [#103181](https://github.com/openclaw/openclaw/pull/103181)
- Keep Gateway alive when managed Chrome cannot start [#103243](https://github.com/openclaw/openclaw/pull/103243)
- Stop macOS computer typing when control is canceled [#103528](https://github.com/openclaw/openclaw/pull/103528)
- Expire stale Chrome MCP tab and snapshot handles after reconnect [#103576](https://github.com/openclaw/openclaw/pull/103576)
- Prevent stale browser handles from switching duplicate-URL tabs [#103816](https://github.com/openclaw/openclaw/pull/103816)
- Reject unsafe Browser mutations before parsing JSON [#104677](https://github.com/openclaw/openclaw/pull/104677)
- Apply Browser profile policy to tab URL redaction [#104715](https://github.com/openclaw/openclaw/pull/104715)
- Keep parallel agent node calls authenticated [#105143](https://github.com/openclaw/openclaw/pull/105143)
- Adopt browser tabs only after final policy validation [#105301](https://github.com/openclaw/openclaw/pull/105301)
- Recover Chrome relay connections stuck during WebSocket opening [#109114](https://github.com/openclaw/openclaw/pull/109114)
- Cancel browser tab discovery immediately [#109617](https://github.com/openclaw/openclaw/pull/109617)
- fix(browser): stop agent-launched managed Chrome [#109723](https://github.com/openclaw/openclaw/pull/109723)
- Clean up OpenClaw browser tabs after Gateway restart [#110797](https://github.com/openclaw/openclaw/pull/110797)
- Retire tracked tabs whose browser never returns [#111307](https://github.com/openclaw/openclaw/pull/111307)
- Close browser tabs after isolated agent runs [#113566](https://github.com/openclaw/openclaw/pull/113566)
- Prevent the browser copilot popup from hanging when a tab closes [#113744](https://github.com/openclaw/openclaw/pull/113744)
- Clean up failed browser navigation guards [#113753](https://github.com/openclaw/openclaw/pull/113753)
- Keep Chrome page shares within field limits [#113768](https://github.com/openclaw/openclaw/pull/113768)
- Keep stale Chrome copilot events out of active chat turns [#113781](https://github.com/openclaw/openclaw/pull/113781)
- Show page-share failures when the browser relay disconnects [#113803](https://github.com/openclaw/openclaw/pull/113803)
- Recover remote Browser nodes after startup failure [#113926](https://github.com/openclaw/openclaw/pull/113926)
- Fix remote Browser node timeouts and cancellation isolation [#114131](https://github.com/openclaw/openclaw/pull/114131)
- Restore managed browser snapshots behind a proxy [#114546](https://github.com/openclaw/openclaw/pull/114546)
- Avoid Chrome extension relay port collisions [#115592](https://github.com/openclaw/openclaw/pull/115592)
- Close browser probe connections after unread responses [#115675](https://github.com/openclaw/openclaw/pull/115675)
- Keep Tab Copilot working after extension reloads [#116784](https://github.com/openclaw/openclaw/pull/116784)
- Wake Browser page shares when periodic heartbeats are disabled [#116790](https://github.com/openclaw/openclaw/pull/116790)
- Bound browser snapshot depth on deeply nested pages [#119217](https://github.com/openclaw/openclaw/pull/119217)
- Honor browser navigation timeouts across both drivers [#119654](https://github.com/openclaw/openclaw/pull/119654)
- Reject malformed browser extension relay frames [#120283](https://github.com/openclaw/openclaw/pull/120283)
- fix(browser): cancel waiting profile operations promptly [#120796](https://github.com/openclaw/openclaw/pull/120796)
- Recover stalled Chrome Copilot Gateway connections [#120839](https://github.com/openclaw/openclaw/pull/120839)
- Attached Browser workers exit after CDP use [#122103](https://github.com/openclaw/openclaw/pull/122103)
- Keep embedded browser tabs aligned with the displayed page [#122128](https://github.com/openclaw/openclaw/pull/122128)
- Restore shared Chrome tabs after extension reconnects [#122177](https://github.com/openclaw/openclaw/pull/122177)
- fix(browser): honor explicit snapshot timeout [#124575](https://github.com/openclaw/openclaw/pull/124575)
- Bound browser and Canvas tool results [#125126](https://github.com/openclaw/openclaw/pull/125126)
- Clean up Browser relays during Gateway shutdown [#125176](https://github.com/openclaw/openclaw/pull/125176)
- Report Browser open navigation failures [#125743](https://github.com/openclaw/openclaw/pull/125743)
- Recover managed Chromium launches from Linux zombie locks [#125831](https://github.com/openclaw/openclaw/pull/125831)
- fix(browser): give a paired extension time to attach before declaring it offline [#127761](https://github.com/openclaw/openclaw/pull/127761)
- perf(browser): reduce cold status process scans [#128692](https://github.com/openclaw/openclaw/pull/128692)
- fix(browser): honor inherited timeouts across browser commands [#129176](https://github.com/openclaw/openclaw/pull/129176)
- fix(browser): honor canonical action execution deadlines [#130055](https://github.com/openclaw/openclaw/pull/130055)
- fix(browser): response body reads outlive their timeout [#130386](https://github.com/openclaw/openclaw/pull/130386)
- fix(browser): avoid navigation timeouts during tab access renewal [#131841](https://github.com/openclaw/openclaw/pull/131841)
- fix(browser): worker targets no longer crash the gateway [#132419](https://github.com/openclaw/openclaw/pull/132419)
- fix(browser): preserve targets when relay clients share Chrome [#132504](https://github.com/openclaw/openclaw/pull/132504)
- fix: isolate browser bindings and clipboard teardown [#132878](https://github.com/openclaw/openclaw/pull/132878)
- fix(browser): prove post-action target continuity before adopting a tab (#110884) [91888cf](https://github.com/openclaw/openclaw/commit/91888cf)
- Return errors for malformed browser relay frames [#102070](https://github.com/openclaw/openclaw/pull/102070)
- Keep remote CDP target discovery within its configured host [#102328](https://github.com/openclaw/openclaw/pull/102328)
- Keep Chrome error-message tails valid UTF-8 [#102543](https://github.com/openclaw/openclaw/pull/102543)
- Reject credential-bearing browser page URLs before dispatch [#102952](https://github.com/openclaw/openclaw/pull/102952)
- Reject malformed computer-tool numeric inputs [#103642](https://github.com/openclaw/openclaw/pull/103642)
- Reject invalid raw CDP tab targets before selecting them [#104129](https://github.com/openclaw/openclaw/pull/104129)
- Stop duplicate watch result errors after malformed JSON [#104293](https://github.com/openclaw/openclaw/pull/104293)
- Keep Chrome launch error hints Unicode-safe [#104603](https://github.com/openclaw/openclaw/pull/104603)
- Bound browser control requests with the configured timeout [#106497](https://github.com/openclaw/openclaw/pull/106497)
- Keep sandbox browser startup probes within the configured deadline [#108670](https://github.com/openclaw/openclaw/pull/108670)
- Cancel Playwright click-and-hold delays promptly [#109710](https://github.com/openclaw/openclaw/pull/109710)
- Reject malformed Firecrawl success envelopes [#111210](https://github.com/openclaw/openclaw/pull/111210)
- Keep web-search provider errors valid at Unicode truncation boundaries [#111327](https://github.com/openclaw/openclaw/pull/111327)
- Reject blank Tavily extract URLs locally [#111333](https://github.com/openclaw/openclaw/pull/111333)
- Stop stalled Google Docs shares from hanging indefinitely [#111633](https://github.com/openclaw/openclaw/pull/111633)
- Reject corrupted UTF-8 in Exa search responses [#111736](https://github.com/openclaw/openclaw/pull/111736)
- Accept explicit SearXNG search endpoint URLs [#113661](https://github.com/openclaw/openclaw/pull/113661)
- Prevent duplicate volatile browser tab closes [#114507](https://github.com/openclaw/openclaw/pull/114507)
- Cancel browser status probes when requests stop [#115534](https://github.com/openclaw/openclaw/pull/115534)
- Cancel stalled browser CDP handshakes promptly [#115805](https://github.com/openclaw/openclaw/pull/115805)
- Return the actual committed Browser trace path [#116702](https://github.com/openclaw/openclaw/pull/116702)
- Recover Browser Copilot state after failed Chrome writes [#116882](https://github.com/openclaw/openclaw/pull/116882)
- Reclaim stalled browser extension relay connections [#120806](https://github.com/openclaw/openclaw/pull/120806)
- Keep browser close results tied to the closed tab [#124064](https://github.com/openclaw/openclaw/pull/124064)
- Preserve Chrome tabs when the last-tab close is refused [#124449](https://github.com/openclaw/openclaw/pull/124449)
- Let the browser panel mount without ResizeObserver [#125480](https://github.com/openclaw/openclaw/pull/125480)
- fix(browser): cancel pending CDP endpoint discovery [#129410](https://github.com/openclaw/openclaw/pull/129410)
- fix(browser): stop hangs after modal dialog handling fails [#129459](https://github.com/openclaw/openclaw/pull/129459)
- fix(browser): preserve response-body timeout diagnostics [#129803](https://github.com/openclaw/openclaw/pull/129803)
- fix(browser): handle concurrent first-use extension pairing [#130832](https://github.com/openclaw/openclaw/pull/130832)
- Close browser tabs left behind by cancelled opens [#131125](https://github.com/openclaw/openclaw/pull/131125)
- fix(browser): avoid unnecessary runtime loading for CLI commands [#132486](https://github.com/openclaw/openclaw/pull/132486)

</details>

</Accordion>

</AccordionGroup>
