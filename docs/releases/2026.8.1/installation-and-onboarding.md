---
title: "v2026.8.1: Installation and Onboarding"
description: "A clearer path from download to a first useful conversation on Mac, Linux, Windows, iPhone, iPad, and Android, plus the move of sessions and transcripts into SQLite."
---

<Warning>
**Storage and downgrade warning**

This release changes how sessions and transcripts are stored by moving them into SQLite. Before downgrading to an older file-backed release, use the current CLI to restore archived legacy transcript artifacts; sessions created after the migration will not appear in older releases.

Create a [verified backup](/install/updating#before-updating%3A-create-a-verified-backup) before upgrading to protect broader OpenClaw state, and review [downgrading across the session SQLite migration](/install/updating#downgrading-across-the-session-sqlite-migration) before rolling back.
</Warning>

OpenClaw now gives new [Mac, Linux, and Windows installs](/install) a clearer path from download to a first useful conversation, while iPhone, iPad, and Android put pairing and permissions where people need them. Guided setup can reuse supported subscriptions, API keys, and [local models](/gateway/local-models) already available, verifies the chosen model before saving it, and hands off to the web app or terminal when the connection is ready.

<AccordionGroup>

<Accordion title="Installing OpenClaw">

The [supported install path](/install) now keeps the app or command available after setup. A Mac app opened from Downloads or a disk image can offer to move itself into Applications, where updates and launch at login work properly. On Linux and other Unix systems, the installer makes `openclaw` available in new terminal sessions without asking you to edit shell startup files by hand.

Network installations that would expose OpenClaw without authentication are stopped before anything changes. Reinstalling also protects an existing working setup when preparation is cancelled or fails, and gives OpenClaw time to start before reporting whether it is reachable.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Install temporary macOS launches in Applications [#104661](https://github.com/openclaw/openclaw/pull/104661)
- feat(docker): install openssh-client in the runtime image [#131710](https://github.com/openclaw/openclaw/pull/131710)
- Clarify onboarding security guidance in plain language [#120172](https://github.com/openclaw/openclaw/pull/120172)

**Bug fixes**

- Prevent fresh-state Gateway startup timeouts [#111701](https://github.com/openclaw/openclaw/pull/111701)
- Keep Gateway startup responsive during model-runtime preparation [#112262](https://github.com/openclaw/openclaw/pull/112262)
- Add safe Gateway token recovery for onboarding [#118051](https://github.com/openclaw/openclaw/pull/118051)
- Keep OpenClaw available in fresh Unix shells after installation [#124779](https://github.com/openclaw/openclaw/pull/124779)
- Honor remote flags in interactive onboarding [#111517](https://github.com/openclaw/openclaw/pull/111517)
- Remove stale remote passwords when switching to token auth [#112544](https://github.com/openclaw/openclaw/pull/112544)
- Let first-boot loopback CLI calls connect after Gateway readiness [#114380](https://github.com/openclaw/openclaw/pull/114380)
- Avoid first-boot delays for canonical internal hooks [#117493](https://github.com/openclaw/openclaw/pull/117493)
- Honor external Gateway supervision during onboarding [#119846](https://github.com/openclaw/openclaw/pull/119846)
- Honor Gateway passwords during noninteractive setup [#126690](https://github.com/openclaw/openclaw/pull/126690)
- Add remote Gateway password authentication to onboarding [#126768](https://github.com/openclaw/openclaw/pull/126768)
- fix: preserve Gateway when setup Reinstall is cancelled [#130617](https://github.com/openclaw/openclaw/pull/130617)
- fix: share managed Gateway startup readiness across setup [#130682](https://github.com/openclaw/openclaw/pull/130682)
- fix(install): prevent low-memory postinstall OOMs [#132555](https://github.com/openclaw/openclaw/pull/132555)
- fix(cli): complete remote onboarding after Gateway restarts [#133257](https://github.com/openclaw/openclaw/pull/133257)
- Prevent piped installer subprocesses from consuming the install script [#87799](https://github.com/openclaw/openclaw/pull/87799)
- Block unauthenticated network Gateway service installs [#98022](https://github.com/openclaw/openclaw/pull/98022)
- Update fresh CLI installs to Node 22.22.2 [#104073](https://github.com/openclaw/openclaw/pull/104073)
- Wait for Gateway warnings before service installation [#104173](https://github.com/openclaw/openclaw/pull/104173)
- Validate Docker timezones in the selected runtime image [#116153](https://github.com/openclaw/openclaw/pull/116153)
- Keep shell-completion permission errors from failing onboarding [#125263](https://github.com/openclaw/openclaw/pull/125263)
- Persist configure changes before gateway side effects [#125751](https://github.com/openclaw/openclaw/pull/125751)
- fix(installer): avoid prerelease Node from Linux package repos [#130369](https://github.com/openclaw/openclaw/pull/130369)
- fix(installer): avoid restarting the gateway twice after source installs [#130900](https://github.com/openclaw/openclaw/pull/130900)
- fix: avoid cold SecretRef validation stalls in daemon install [#132206](https://github.com/openclaw/openclaw/pull/132206)

**Documentation**

- Correct README setup guidance and contributor avatar sizing [#113547](https://github.com/openclaw/openclaw/pull/113547)
- Streamline the README for first-time setup [#118376](https://github.com/openclaw/openclaw/pull/118376)
- Add a ChromeOS and Crostini installation guide [#107663](https://github.com/openclaw/openclaw/pull/107663)
- Stop telling hosted-installer users to onboard twice [#125246](https://github.com/openclaw/openclaw/pull/125246)

</details>

</Accordion>

<Accordion title="Connecting a subscription, API key, or local model">

[Guided setup](/start/wizard) now starts by looking for AI access you may already have. It can reuse verified Codex, ChatGPT, or Claude CLI sign-ins, accept an API key, run a supported provider's own sign-in, or find qualifying Ollama and LM Studio models, then prove that the exact choice can answer before it keeps that model and credential. Access already working on the machine can become part of setup instead of another thing to configure.

For OpenAI accounts, setup uses the models the signed-in account can actually access while preserving routes you configured yourself, and administrators can prepare supported [local models](/gateway/local-models) with live progress. Finding or downloading a local model is only the start, so the supported local-model screens do not show Start chatting until that exact choice passes activation.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Default fresh OpenAI setups to GPT-5.6 [#103581](https://github.com/openclaw/openclaw/pull/103581)
- Add provider sign-in to onboarding [#104502](https://github.com/openclaw/openclaw/pull/104502)
- Configure model providers from the Control UI [#106490](https://github.com/openclaw/openclaw/pull/106490)
- Discover installed local models during onboarding [#108605](https://github.com/openclaw/openclaw/pull/108605)
- Add guided model setup to the Control UI [#108868](https://github.com/openclaw/openclaw/pull/108868)
- Verify the current model connection from Control UI [#109183](https://github.com/openclaw/openclaw/pull/109183)
- Prefer stronger local models during guided onboarding [#109250](https://github.com/openclaw/openclaw/pull/109250)
- Add in-process local GGUF text inference [#109444](https://github.com/openclaw/openclaw/pull/109444)
- Use Gemma 4 as the RAM-gated llama.cpp default [#109585](https://github.com/openclaw/openclaw/pull/109585)
- Add unified AI setup recommendations [#109681](https://github.com/openclaw/openclaw/pull/109681)
- Stream provider preparation progress across setup surfaces [#109764](https://github.com/openclaw/openclaw/pull/109764)
- Automatically use the lean tool surface for verified local models [#110596](https://github.com/openclaw/openclaw/pull/110596)
- Add one-click local model setup on web and macOS [#113476](https://github.com/openclaw/openclaw/pull/113476)
- Add verified LM Studio and local-model onboarding [#116606](https://github.com/openclaw/openclaw/pull/116606)
- Replace node-llama-cpp with managed llama-server [#123105](https://github.com/openclaw/openclaw/pull/123105)
- Improve macOS device-code sign-in [#104766](https://github.com/openclaw/openclaw/pull/104766)
- Align macOS AI connection choices with CLI onboarding [#107642](https://github.com/openclaw/openclaw/pull/107642)
- Clarify provider credential setup and CLI login recovery [#108739](https://github.com/openclaw/openclaw/pull/108739)
- Report installed Pi and OpenCode tools during guided setup [#109624](https://github.com/openclaw/openclaw/pull/109624)
- Refresh DeepSeek, Together, and Venice setup defaults [#113973](https://github.com/openclaw/openclaw/pull/113973)
- Default fresh Cerebras setup to Gemma 4 31B [#114015](https://github.com/openclaw/openclaw/pull/114015)
- Unify Ollama model inspection across setup and discovery [#115879](https://github.com/openclaw/openclaw/pull/115879)
- Verify llama.cpp setup before opening chat [#116308](https://github.com/openclaw/openclaw/pull/116308)
- Simplify recovery for configured local models [#117165](https://github.com/openclaw/openclaw/pull/117165)
- Scope onboarding model browsing to the selected provider [#125373](https://github.com/openclaw/openclaw/pull/125373)
- Skip discarded workspace loading during first-run setup [#126967](https://github.com/openclaw/openclaw/pull/126967)
- Faster first-run model detection [#127053](https://github.com/openclaw/openclaw/pull/127053)

**Bug fixes**

- Make fresh AI onboarding reliable and transparent [#103962](https://github.com/openclaw/openclaw/pull/103962)
- Reuse Codex CLI login during fresh Mac setup [#104150](https://github.com/openclaw/openclaw/pull/104150)
- Restore grouped provider sign-in during guided onboarding [#107038](https://github.com/openclaw/openclaw/pull/107038)
- Harden OpenAI onboarding and Crestodian handoff [#107041](https://github.com/openclaw/openclaw/pull/107041)
- Keep Gateway health responsive during setup detection [#110625](https://github.com/openclaw/openclaw/pull/110625)
- Unblock Model Setup on configless gateways [#111841](https://github.com/openclaw/openclaw/pull/111841)
- Require viable imported and local AI routes during onboarding [#112028](https://github.com/openclaw/openclaw/pull/112028)
- Prevent onboarding crashes and prioritize subscription logins [#112378](https://github.com/openclaw/openclaw/pull/112378)
- Show account-available OpenAI models after API-key onboarding [#114258](https://github.com/openclaw/openclaw/pull/114258)
- Fix OpenAI model discovery and installed-package onboarding [#114288](https://github.com/openclaw/openclaw/pull/114288)
- Make Ollama and LM Studio onboarding reliable [#114405](https://github.com/openclaw/openclaw/pull/114405)
- Keep local model discovery, retries, and cloud timeouts correct [#114582](https://github.com/openclaw/openclaw/pull/114582)
- Guide Control UI users through unavailable AI setup [#115716](https://github.com/openclaw/openclaw/pull/115716)
- Make model setup the primary recovery action when no model is available [#116079](https://github.com/openclaw/openclaw/pull/116079)
- Choose an available GitHub Copilot onboarding model [#116590](https://github.com/openclaw/openclaw/pull/116590)
- Route Google setup through supported authentication [#116611](https://github.com/openclaw/openclaw/pull/116611)
- Honor Ollama model and pull-completion contracts [#117171](https://github.com/openclaw/openclaw/pull/117171)
- Activate the exact local model prepared during setup [#119050](https://github.com/openclaw/openclaw/pull/119050)
- Complete ChatGPT subscription setup on macOS [#120782](https://github.com/openclaw/openclaw/pull/120782)
- OpenCode onboarding chooses usable models and preserves coding tools [#121414](https://github.com/openclaw/openclaw/pull/121414)
- Make Ollama guided setup choose and verify a working model [#123190](https://github.com/openclaw/openclaw/pull/123190)
- Raise the llama.cpp default context to 64K [#123701](https://github.com/openclaw/openclaw/pull/123701)
- Complete macOS Codex setup and account model discovery [#124829](https://github.com/openclaw/openclaw/pull/124829)
- Detect CLI model logins when setup scans run long [#125114](https://github.com/openclaw/openclaw/pull/125114)
- Keep Claude CLI OAuth available after restart [#125471](https://github.com/openclaw/openclaw/pull/125471)
- Scope onboarding model hooks to the selected provider [#126427](https://github.com/openclaw/openclaw/pull/126427)
- fix: keep Claude CLI authentication native [#129052](https://github.com/openclaw/openclaw/pull/129052)
- fix(anthropic): native Claude models show incorrect availability [#129346](https://github.com/openclaw/openclaw/pull/129346)
- fix(auth): make Codex logout recovery actionable [#130866](https://github.com/openclaw/openclaw/pull/130866)
- fix: recover auth and chat after Model Setup activation [#133106](https://github.com/openclaw/openclaw/pull/133106)
- Preserve GitHub Copilot device-login backoff [#103434](https://github.com/openclaw/openclaw/pull/103434)
- Stop stalled GitHub Copilot token exchanges from hanging [#104488](https://github.com/openclaw/openclaw/pull/104488)
- Find model-probe credentials stored under provider aliases [#106736](https://github.com/openclaw/openclaw/pull/106736)
- Complete the Codex OAuth handoff during onboarding [#107174](https://github.com/openclaw/openclaw/pull/107174)
- Remove the duplicate Codex provider setup choice [#107979](https://github.com/openclaw/openclaw/pull/107979)
- Preserve fresh-install ChatGPT OAuth credentials [#108617](https://github.com/openclaw/openclaw/pull/108617)
- Prevent Codex login lookup from hanging the TUI [#109452](https://github.com/openclaw/openclaw/pull/109452)
- Ignore blank environment credentials during provider auth [#109691](https://github.com/openclaw/openclaw/pull/109691)
- Let Ollama setup continue past broken local models [#109895](https://github.com/openclaw/openclaw/pull/109895)
- Stop broken Ollama models from claiming tool support [#109921](https://github.com/openclaw/openclaw/pull/109921)
- fix(onboarding): stop recommending tools setup cannot activate [#109951](https://github.com/openclaw/openclaw/pull/109951)
- Stop advertising Ollama tools when model inspection fails [#109971](https://github.com/openclaw/openclaw/pull/109971)
- Allow OpenAI OAuth token exchange behind fake-IP proxies [#110096](https://github.com/openclaw/openclaw/pull/110096)
- Keep failed onboarding retries from overwriting working setup [#111558](https://github.com/openclaw/openclaw/pull/111558)
- Let OpenAI model login exit after browser callback [#112211](https://github.com/openclaw/openclaw/pull/112211)
- Keep Control UI setup responsive during stalled discovery [#112338](https://github.com/openclaw/openclaw/pull/112338)
- Stop stalled Microsoft Foundry device-code logins from hanging onboarding [#112369](https://github.com/openclaw/openclaw/pull/112369)
- Reuse active Codex API-key authentication during onboarding [#112770](https://github.com/openclaw/openclaw/pull/112770)
- Keep web model-download progress updating [#113613](https://github.com/openclaw/openclaw/pull/113613)
- Refresh provider onboarding model defaults [#113870](https://github.com/openclaw/openclaw/pull/113870)
- Keep OpenAI onboarding choices within account access [#114356](https://github.com/openclaw/openclaw/pull/114356)
- Prevent false provider failures in Doctor [#114533](https://github.com/openclaw/openclaw/pull/114533)
- Preserve the onboarding inference probe's in-memory session [#115452](https://github.com/openclaw/openclaw/pull/115452)
- Preserve selected Ollama model capabilities during onboarding [#115467](https://github.com/openclaw/openclaw/pull/115467)
- Keep verified Codex setup active through activation [#115704](https://github.com/openclaw/openclaw/pull/115704)
- Make Gemini CLI setup recovery actionable [#115835](https://github.com/openclaw/openclaw/pull/115835)
- Retry Ollama setup without restarting the wizard [#116210](https://github.com/openclaw/openclaw/pull/116210)
- Coordinate Settings and model-setup writes [#116940](https://github.com/openclaw/openclaw/pull/116940)
- Stop scraping Gemini CLI OAuth credentials [#117167](https://github.com/openclaw/openclaw/pull/117167)
- Use only loaded LM Studio models during setup [#117919](https://github.com/openclaw/openclaw/pull/117919)
- Detect reachable Ollama services during onboarding [#118020](https://github.com/openclaw/openclaw/pull/118020)
- Remove unsupported Google auth and quota guidance [#118034](https://github.com/openclaw/openclaw/pull/118034)
- Avoid loading idle Ollama models during guided setup [#118183](https://github.com/openclaw/openclaw/pull/118183)
- Detect running LM Studio during guided setup without a loaded model [#119134](https://github.com/openclaw/openclaw/pull/119134)
- Restore provider authentication in installed local TUI mode [#119283](https://github.com/openclaw/openclaw/pull/119283)
- Fix macOS AI onboarding visuals and Keychain fallback [#120907](https://github.com/openclaw/openclaw/pull/120907)
- Fix no-auth local models and prompt-template error handling [#121790](https://github.com/openclaw/openclaw/pull/121790)
- Make macOS onboarding candidate rows fully clickable [#121928](https://github.com/openclaw/openclaw/pull/121928)
- Show a retryable error when AI access detection times out [#121940](https://github.com/openclaw/openclaw/pull/121940)
- Remove the duplicate GPT-5.6 picker entry [#122178](https://github.com/openclaw/openclaw/pull/122178)
- Keep long OAuth setup links inside the Model Setup dialog [#122892](https://github.com/openclaw/openclaw/pull/122892)
- fix(openai): return structured failure for malformed OAuth token JSON [#122962](https://github.com/openclaw/openclaw/pull/122962)
- Show configured models when sign-in is unavailable [#123130](https://github.com/openclaw/openclaw/pull/123130)
- Make Codex Test & use complete from Model Setup [#123141](https://github.com/openclaw/openclaw/pull/123141)
- Choose the smallest capable local Ollama model during CLI setup [#123382](https://github.com/openclaw/openclaw/pull/123382)
- Keep model setup alive after provider authorization [#123418](https://github.com/openclaw/openclaw/pull/123418)
- Read Claude CLI Keychain auth during scripted macOS onboarding [#123839](https://github.com/openclaw/openclaw/pull/123839)
- fix(system-agent): leave reasoning room in local model setup probes [#124405](https://github.com/openclaw/openclaw/pull/124405)
- Keep OpenRouter sign-in waiting after invalid callbacks [#124922](https://github.com/openclaw/openclaw/pull/124922)
- Keep onboarding provider metadata scoped to the selected provider [#125379](https://github.com/openclaw/openclaw/pull/125379)
- Show accurate OpenAI OAuth recovery status without masking provider failures [#125515](https://github.com/openclaw/openclaw/pull/125515)
- fix(tui): local /auth exits 1 with no diagnostics when the session provider is CLI-backed [#125677](https://github.com/openclaw/openclaw/pull/125677)
- Make llama-server authentication changes reproducible [#126498](https://github.com/openclaw/openclaw/pull/126498)
- Keep OpenRouter API keys with OpenRouter during onboarding [#126578](https://github.com/openclaw/openclaw/pull/126578)
- fix(ui): Model Setup stuck on "Checking this Gateway" for fresh clients [#127695](https://github.com/openclaw/openclaw/pull/127695)
- fix(ollama): defer local service lookup until stream creation [#128399](https://github.com/openclaw/openclaw/pull/128399)
- fix(ui): keep Model Setup visible while checking AI access [#128636](https://github.com/openclaw/openclaw/pull/128636)
- fix(macos): allow cold ChatGPT Codex probes [#128819](https://github.com/openclaw/openclaw/pull/128819)
- fix(agents): preserve setup CLI model resolution [#129128](https://github.com/openclaw/openclaw/pull/129128)
- fix(onboarding): OpenAI setup installs mismatched Codex plugin [#129195](https://github.com/openclaw/openclaw/pull/129195)
- fix: report native Claude CLI models as available [#129332](https://github.com/openclaw/openclaw/pull/129332)
- fix(ollama): cancelled cloud setup continues and returns credentials [#129541](https://github.com/openclaw/openclaw/pull/129541)
- fix(onboard): preserve manifest-equivalent alias validation [#129590](https://github.com/openclaw/openclaw/pull/129590)
- fix(onboard): reject unavailable required runtimes [#129855](https://github.com/openclaw/openclaw/pull/129855)
- fix(ollama): retain advertised context and tools when model inspection is unavailable [#130000](https://github.com/openclaw/openclaw/pull/130000)
- fix(llama-cpp): stop recommending failed models during setup [#130136](https://github.com/openclaw/openclaw/pull/130136)
- fix(anthropic): prevent retired Claude CLI profile from breaking setup [#130225](https://github.com/openclaw/openclaw/pull/130225)
- fix(ollama): cloud models vanish from discovery when inspection returns nothing [#130240](https://github.com/openclaw/openclaw/pull/130240)
- fix: honor fresh provider catalog discovery [#130412](https://github.com/openclaw/openclaw/pull/130412)
- fix(ollama): keep local setup local and skip embedding chat defaults [#130459](https://github.com/openclaw/openclaw/pull/130459)
- fix(setup): treat superseded catalog refresh as activation success [#130795](https://github.com/openclaw/openclaw/pull/130795)
- fix(setup): preserve verified inference during first-agent creation [#132472](https://github.com/openclaw/openclaw/pull/132472)
- Clean up OpenAI Codex OAuth callbacks and stale prompts [#89491](https://github.com/openclaw/openclaw/pull/89491)
- Accept helper-managed Claude CLI authentication [#97492](https://github.com/openclaw/openclaw/pull/97492)
- Omit empty provider request settings during onboarding [aad9974](https://github.com/openclaw/openclaw/commit/aad9974)
- Bound MiniMax OAuth requests with 30-second timeouts [#102862](https://github.com/openclaw/openclaw/pull/102862)
- Stop GitHub Copilot device login from hanging indefinitely [#103255](https://github.com/openclaw/openclaw/pull/103255)
- Suppress trust warnings for explicitly enabled plugins [#104097](https://github.com/openclaw/openclaw/pull/104097)
- Show OpenRouter OAuth denial errors accurately [#105448](https://github.com/openclaw/openclaw/pull/105448)
- Clean up GitHub Copilot login polling listeners [#106453](https://github.com/openclaw/openclaw/pull/106453)
- Remove placeholder text from guided onboarding candidates [#110084](https://github.com/openclaw/openclaw/pull/110084)
- Release Ollama setup connections after responses [#111802](https://github.com/openclaw/openclaw/pull/111802)
- Explain how to recover from GitHub Copilot 403 errors [#112025](https://github.com/openclaw/openclaw/pull/112025)
- Honor the Azure device-code login window [#113741](https://github.com/openclaw/openclaw/pull/113741)
- Refresh Qianfan onboarding default and isolate OpenAI live tests [#113999](https://github.com/openclaw/openclaw/pull/113999)
- Reject malformed OpenAI OAuth token responses cleanly [#120685](https://github.com/openclaw/openclaw/pull/120685)
- Fix provider-key tests with the Codex runtime selected [#121500](https://github.com/openclaw/openclaw/pull/121500)
- Let users switch AI candidates during macOS onboarding [#121613](https://github.com/openclaw/openclaw/pull/121613)
- Make Codex onboarding tolerate inherited loader paths [#122731](https://github.com/openclaw/openclaw/pull/122731)
- Stop false missing-auth warnings after API key entry [#122756](https://github.com/openclaw/openclaw/pull/122756)
- Keep OpenAI setup authentication choices consistent [#124729](https://github.com/openclaw/openclaw/pull/124729)
- Retry transient first-run model detection [#125212](https://github.com/openclaw/openclaw/pull/125212)
- Stop false provider setup warnings [#125523](https://github.com/openclaw/openclaw/pull/125523)
- Recognize ambient CLI login for configured model availability [#125772](https://github.com/openclaw/openclaw/pull/125772)
- Fix Web UI provider probes for direct credentials [#125816](https://github.com/openclaw/openclaw/pull/125816)
- Stop false plugin warnings during non-interactive onboarding [#126734](https://github.com/openclaw/openclaw/pull/126734)
- fix: report native Claude CLI auth in status [#129364](https://github.com/openclaw/openclaw/pull/129364)
- fix: clean retired Claude auth before Doctor health [#129375](https://github.com/openclaw/openclaw/pull/129375)
- fix(llama-cpp): existing-server setup chooses ready models first [#129509](https://github.com/openclaw/openclaw/pull/129509)
- fix(ollama): setup picks a huge model despite explicit non-thinking capabilities [#129611](https://github.com/openclaw/openclaw/pull/129611)
- fix(ollama): allow setup reset with any installed local model [#129934](https://github.com/openclaw/openclaw/pull/129934)

**Documentation**

- docs(onboarding): preserve the selected model in setup guide [#128547](https://github.com/openclaw/openclaw/pull/128547)

</details>

</Accordion>

<Accordion title="Starting your first conversation">

Successful setup now hands off directly to a [first conversation](/start/wizard). Graphical Mac, Linux, and Windows sessions can open the web app, while SSH and other headless setups provide an authenticated link with port-forward instructions and keep terminal chat available.

From there, the setup conversation can finish supported skill and web-search configuration, then offer an external channel as an optional next step instead of another prerequisite for first use. The classic wizard can still continue without AI because its live model check remains optional.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Guided CLI setup verifies AI access before saving [#101880](https://github.com/openclaw/openclaw/pull/101880)
- Recommend plugins and skills from installed apps [#109668](https://github.com/openclaw/openclaw/pull/109668)
- Make guided onboarding the local custodian flow [#109841](https://github.com/openclaw/openclaw/pull/109841)
- Add browser-first handoff after guided macOS onboarding [#110054](https://github.com/openclaw/openclaw/pull/110054)
- Add conversational custodian onboarding [#110141](https://github.com/openclaw/openclaw/pull/110141)
- Persist onboarding recommendations and shorten first-run identity setup [#110173](https://github.com/openclaw/openclaw/pull/110173)
- Add typed onboarding questions with live option cards [#110242](https://github.com/openclaw/openclaw/pull/110242)
- Hand fresh setup into the agent's first chat [#110331](https://github.com/openclaw/openclaw/pull/110331)
- Extend browser onboarding and refresh app recommendations [#110484](https://github.com/openclaw/openclaw/pull/110484)
- Add rich setup controls to Custodian chat [#114631](https://github.com/openclaw/openclaw/pull/114631)
- Configure skills and web search inside Ask OpenClaw [#115130](https://github.com/openclaw/openclaw/pull/115130)
- Guide local Gateway configuration in Ask OpenClaw [#115363](https://github.com/openclaw/openclaw/pull/115363)
- Guide optional channel setup after first-run model setup [#116078](https://github.com/openclaw/openclaw/pull/116078)
- Name the first agent during onboarding [#123521](https://github.com/openclaw/openclaw/pull/123521)
- Add opt-in keyless Firecrawl search and richer search controls [#97078](https://github.com/openclaw/openclaw/pull/97078)
- Let users name new agents [#112009](https://github.com/openclaw/openclaw/pull/112009)
- Clarify web search setup choices [#112199](https://github.com/openclaw/openclaw/pull/112199)
- Show live progress during onboarding app scans [#112414](https://github.com/openclaw/openclaw/pull/112414)
- Constrain system-agent planner JSON at generation time [#113482](https://github.com/openclaw/openclaw/pull/113482)
- Offer optional workspace files without false missing warnings [#114559](https://github.com/openclaw/openclaw/pull/114559)

**Bug fixes**

- Make Gateway onboarding inference-first and route-safe [#102883](https://github.com/openclaw/openclaw/pull/102883)
- Make conversational setup practical on local models [#109445](https://github.com/openclaw/openclaw/pull/109445)
- Show actionable option cards in macOS onboarding [#110584](https://github.com/openclaw/openclaw/pull/110584)
- Keep Custodian health nudges out of hosted-wizard answers [#111430](https://github.com/openclaw/openclaw/pull/111430)
- Make first-run browser onboarding reliable [#111465](https://github.com/openclaw/openclaw/pull/111465)
- Isolate onboarding recommendations by workspace [#111560](https://github.com/openclaw/openclaw/pull/111560)
- Attach fresh agent hatches to the running Gateway [#122210](https://github.com/openclaw/openclaw/pull/122210)
- Keep guided agent credentials aligned with creation [#126096](https://github.com/openclaw/openclaw/pull/126096)
- Back navigation within terminal channel setup [#108007](https://github.com/openclaw/openclaw/pull/108007)
- Require decimal menu numbers in setup chats [#108140](https://github.com/openclaw/openclaw/pull/108140)
- Return setup inference repair to chat [#109938](https://github.com/openclaw/openclaw/pull/109938)
- Make setup wizard Copy buttons work over plain HTTP [#110139](https://github.com/openclaw/openclaw/pull/110139)
- Align Ask OpenClaw framing and confirmation defaults [#111263](https://github.com/openclaw/openclaw/pull/111263)
- Keep system-agent model changes on the verified route [#111431](https://github.com/openclaw/openclaw/pull/111431)
- Exit onboarding immediately when setup is skipped [#112165](https://github.com/openclaw/openclaw/pull/112165)
- Label onboarding fields and mask Matrix credentials [#112233](https://github.com/openclaw/openclaw/pull/112233)
- Avoid catalog preparation during verified TUI startup [#113136](https://github.com/openclaw/openclaw/pull/113136)
- Fresh installs find external search plugins and honor first tasks [#114327](https://github.com/openclaw/openclaw/pull/114327)
- Wait for a real new browser during onboarding [#117431](https://github.com/openclaw/openclaw/pull/117431)
- Keep channel setup moving through Gateway installation progress [#117877](https://github.com/openclaw/openclaw/pull/117877)
- Report failed browser launches during setup [#117979](https://github.com/openclaw/openclaw/pull/117979)
- Build Control UI before onboarding handoff [#118038](https://github.com/openclaw/openclaw/pull/118038)
- Show clipboard failures during onboarding and pairing [#118651](https://github.com/openclaw/openclaw/pull/118651)
- fix(tui): close setup gateway before exit fallback [#121183](https://github.com/openclaw/openclaw/pull/121183)
- Restore setup chat on development Gateway rosters [#121784](https://github.com/openclaw/openclaw/pull/121784)
- Split system-agent chat ownership and preserve handoff state [#121884](https://github.com/openclaw/openclaw/pull/121884)
- Keep agent bootstrap on the Gateway's OpenClaw CLI [#122765](https://github.com/openclaw/openclaw/pull/122765)
- Add recovery when Custodian channel setup checks fail [#124680](https://github.com/openclaw/openclaw/pull/124680)
- Open browser handoff in display-less WSL [#124704](https://github.com/openclaw/openclaw/pull/124704)
- Finalize guided agent creation safely [#125768](https://github.com/openclaw/openclaw/pull/125768)
- fix(onboard): recover manual handoff after browser launch failure [#130272](https://github.com/openclaw/openclaw/pull/130272)
- Reject invalid numeric values in plugin setup [#107346](https://github.com/openclaw/openclaw/pull/107346)
- Preserve emoji in onboarding recommendation explanations [#110401](https://github.com/openclaw/openclaw/pull/110401)
- Skip blank locale overrides in the setup wizard [#111076](https://github.com/openclaw/openclaw/pull/111076)
- Preserve the first-turn hatch for fresh named agents [#111553](https://github.com/openclaw/openclaw/pull/111553)
- Keep system care under Settings [#111686](https://github.com/openclaw/openclaw/pull/111686)
- Stop onboarding progress spinners from flooding narrow terminals [#112413](https://github.com/openclaw/openclaw/pull/112413)
- Show the setup cancel hint once when it applies [#113731](https://github.com/openclaw/openclaw/pull/113731)
- Keep skip-UI setup on guided onboarding [#118737](https://github.com/openclaw/openclaw/pull/118737)
- Accept agent names during setup [#124740](https://github.com/openclaw/openclaw/pull/124740)
- Keep named agents in guided onboarding [#126365](https://github.com/openclaw/openclaw/pull/126365)
- Keep token suppression in guided onboarding [#126580](https://github.com/openclaw/openclaw/pull/126580)
- fix(ollama): start local services for native chat [#128034](https://github.com/openclaw/openclaw/pull/128034)
- fix(onboard): scope hatch timeout to initial turn [#130010](https://github.com/openclaw/openclaw/pull/130010)
- fix(onboard): terminal hatch connects after guided setup [#130082](https://github.com/openclaw/openclaw/pull/130082)
- fix(onboarding): --skip-bootstrap still creates identity files [#130153](https://github.com/openclaw/openclaw/pull/130153)
- fix: give web and terminal users correct agent handoff guidance [#131646](https://github.com/openclaw/openclaw/pull/131646)
- fix(onboard): enable default hooks in guided setup [#131894](https://github.com/openclaw/openclaw/pull/131894)

**Documentation**

- Document Ask OpenClaw Gateway and memory wizards [#115487](https://github.com/openclaw/openclaw/pull/115487)
- Refresh the docs hero and complete the quick-start grid [#102880](https://github.com/openclaw/openclaw/pull/102880)
- Align classic onboarding documentation [#124712](https://github.com/openclaw/openclaw/pull/124712)
- Correct the classic onboarding step order in docs [#125454](https://github.com/openclaw/openclaw/pull/125454)

</details>

</Accordion>

<Accordion title="Setting Up OpenClaw on Mac, Windows, and Linux">

On [Mac](/platforms/macos), the main guide points directly to the app, and the local or remote Gateway you choose stays selected even if older startup or cleanup work finishes late. The app waits through the Local Network prompt and legitimate first-run data upgrades, authenticates the exact remote Gateway before moving on, and opens the dashboard only when the connection is ready.

On [Windows](/platforms/windows), the guide points to the latest signed x64 and Arm64 Hub installers. The PowerShell installer now recognizes a supported Node runtime correctly and can continue in the same session after Winget installs Node.js. Windows Hub updates independently, so its standalone stable build can be newer than the mirror included with an OpenClaw release.

On [Linux](/platforms/linux), desktop setup can repair or reinstall OpenClaw, connect to a local or remote Gateway directly or through SSH, verify eligible AI access already on the machine, and resume an interrupted activation. Direct certificate-pinned connections remain unavailable inside the desktop app.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Shorten macOS onboarding and hand off to Custodian [#117921](https://github.com/openclaw/openclaw/pull/117921)
- Open the dashboard immediately after macOS AI setup [#120950](https://github.com/openclaw/openclaw/pull/120950)
- feat: bring Linux desktop onboarding to macOS parity [#129815](https://github.com/openclaw/openclaw/pull/129815)
- Let macOS onboarding use taller windows [#104004](https://github.com/openclaw/openclaw/pull/104004)
- improve(installer): reduce Windows Git clone downloads [#130908](https://github.com/openclaw/openclaw/pull/130908)

**Bug fixes**

- Make macOS AI onboarding follow the connected Gateway [#102637](https://github.com/openclaw/openclaw/pull/102637)
- Open the macOS dashboard for configured Gateways [#102677](https://github.com/openclaw/openclaw/pull/102677)
- Make fresh macOS local setup start and activate reliably [#108764](https://github.com/openclaw/openclaw/pull/108764)
- Make macOS onboarding permissions scroll on short screens [#112507](https://github.com/openclaw/openclaw/pull/112507)
- Gate macOS remote onboarding on Gateway authentication [#117904](https://github.com/openclaw/openclaw/pull/117904)
- Unblock macOS first-launch Gateway setup [#119831](https://github.com/openclaw/openclaw/pull/119831)
- Let first-run macOS gateway migrations finish [#121012](https://github.com/openclaw/openclaw/pull/121012)
- Recover macOS onboarding during shared-state migration [#121313](https://github.com/openclaw/openclaw/pull/121313)
- fix(linux): truthful install failures, post-install repair, and reachable reinstall in the desktop companion [#128614](https://github.com/openclaw/openclaw/pull/128614)
- fix(linux): first-run desktop onboarding automatically connects working AI [#129211](https://github.com/openclaw/openclaw/pull/129211)
- fix(state): canonically bootstrap fresh state before startup-checkpoint tables [#129850](https://github.com/openclaw/openclaw/pull/129850)
- fix(desktop): preserve onboarding across model activation and restarts [#131757](https://github.com/openclaw/openclaw/pull/131757)
- Start an existing CLI Gateway during macOS onboarding [#104051](https://github.com/openclaw/openclaw/pull/104051)
- Let Return advance macOS onboarding and clarify missing CLI recovery [#104705](https://github.com/openclaw/openclaw/pull/104705)
- Prevent macOS onboarding installer output hangs [#104827](https://github.com/openclaw/openclaw/pull/104827)
- Prevent clipped and stalled macOS onboarding [#107598](https://github.com/openclaw/openclaw/pull/107598)
- Reject public plaintext Gateway profiles on macOS [#112161](https://github.com/openclaw/openclaw/pull/112161)
- Keep macOS setup polling through Gateway progress steps [#114383](https://github.com/openclaw/openclaw/pull/114383)
- Reduce idle CPU use on macOS onboarding [#115896](https://github.com/openclaw/openclaw/pull/115896)
- Keep macOS onboarding waiting for Local Network permission [#120859](https://github.com/openclaw/openclaw/pull/120859)
- Wait for concurrent first-run migrations during Gateway startup [#120959](https://github.com/openclaw/openclaw/pull/120959)
- Show Gateway startup failure reasons during macOS onboarding [#121306](https://github.com/openclaw/openclaw/pull/121306)
- Keep macOS profile onboarding inside its managed CLI [#121651](https://github.com/openclaw/openclaw/pull/121651)
- Isolate named profiles on stable Gateway ports [#122751](https://github.com/openclaw/openclaw/pull/122751)
- Report terminal macOS Gateway startup failures promptly [#126697](https://github.com/openclaw/openclaw/pull/126697)
- Auto-install the CLI during remote macOS onboarding [#126723](https://github.com/openclaw/openclaw/pull/126723)
- Isolate macOS profiles and report direct Gateway endpoints [#127007](https://github.com/openclaw/openclaw/pull/127007)
- Recover macOS remote onboarding after a local Gateway failure [#127033](https://github.com/openclaw/openclaw/pull/127033)
- Keep first-run macOS onboarding visible after Gateway changes [#127038](https://github.com/openclaw/openclaw/pull/127038)
- fix(macos): preserve remote tunnels when switching connection modes [#127665](https://github.com/openclaw/openclaw/pull/127665)
- fix: macOS onboarding waits for Gateway restart [#127713](https://github.com/openclaw/openclaw/pull/127713)
- fix(mac): keep remote Gateway connected after a delayed local failure [#127723](https://github.com/openclaw/openclaw/pull/127723)
- fix(macos): make OpenClaw settings pane responsive [#128177](https://github.com/openclaw/openclaw/pull/128177)
- fix(macos): keep CLI install complete when Gateway startup fails [#128350](https://github.com/openclaw/openclaw/pull/128350)
- fix(macos): show the correct first-run onboarding progress [#129435](https://github.com/openclaw/openclaw/pull/129435)
- fix(macos): confirm closing onboarding during API key verification [#129447](https://github.com/openclaw/openclaw/pull/129447)
- fix(macos): select a supported Node version during onboarding [#129564](https://github.com/openclaw/openclaw/pull/129564)
- fix(macos): stop remote onboarding from installing a local gateway [#129572](https://github.com/openclaw/openclaw/pull/129572)
- fix(macos): show save failures instead of endless onboarding loading [#129959](https://github.com/openclaw/openclaw/pull/129959)
- fix(onboard): preserve the remote gateway TLS pin for an unchanged endpoint [#131042](https://github.com/openclaw/openclaw/pull/131042)
- fix(ui): recover when the managed CLI is missing [#131974](https://github.com/openclaw/openclaw/pull/131974)
- Keep Swift device pairing compatible with older gateways [#80656](https://github.com/openclaw/openclaw/pull/80656)
- Prevent false Node rejection in the Windows installer [#106252](https://github.com/openclaw/openclaw/pull/106252)
- Continue Windows setup after winget installs Node.js [#106862](https://github.com/openclaw/openclaw/pull/106862)
- Correct named-profile Gateway guidance during macOS onboarding [#121614](https://github.com/openclaw/openclaw/pull/121614)
- fix(macos): prevent stale mode switches from stopping a new Gateway [#127609](https://github.com/openclaw/openclaw/pull/127609)
- fix(mac): keep node service aligned with the latest connection mode [#127732](https://github.com/openclaw/openclaw/pull/127732)
- fix(macos): resolve the onboarding install prompt when the gateway is already running [#128273](https://github.com/openclaw/openclaw/pull/128273)
- fix(macos): stop reporting broken Gateway executables as ready [#129453](https://github.com/openclaw/openclaw/pull/129453)
- fix(linux): keep first-run onboarding alive when the gateway restarts [#129502](https://github.com/openclaw/openclaw/pull/129502)
- fix(macos): paused Gateway setup loses recovery after CLI installation [#129566](https://github.com/openclaw/openclaw/pull/129566)
- fix: macOS setup closes without warning while verifying an existing AI connection [#129790](https://github.com/openclaw/openclaw/pull/129790)
- fix: macOS onboarding retry silently rechecks a failed AI connection [#129863](https://github.com/openclaw/openclaw/pull/129863)
- fix(macos): onboarding setup rows ignore clicks across their blank areas [#130273](https://github.com/openclaw/openclaw/pull/130273)
- fix(onboard): SSH tunnel hints use HTTPS for TLS gateways [#130313](https://github.com/openclaw/openclaw/pull/130313)
- fix(installer): pin NodeSource RPM repository [#132286](https://github.com/openclaw/openclaw/pull/132286)
- Correct macOS remote gateway URL guidance [#98548](https://github.com/openclaw/openclaw/pull/98548)
- Honor custom config paths in the macOS CLI [#98631](https://github.com/openclaw/openclaw/pull/98631)
- Preserve custom OpenClaw profiles when the macOS app launches at login [#99752](https://github.com/openclaw/openclaw/pull/99752)

**Documentation**

- Point Windows users to the latest standalone Hub installers [#104774](https://github.com/openclaw/openclaw/pull/104774)
- Link macOS onboarding to the app download [#111361](https://github.com/openclaw/openclaw/pull/111361)
- docs(install): surface desktop app download links for normal-app installs [#127991](https://github.com/openclaw/openclaw/pull/127991)

</details>

</Accordion>

<Accordion title="Setting Up OpenClaw on iPhone, iPad, and Android">

Mobile setup now puts QR and setup-code pairing first because that is what most people were trying to find anyway, while discovered Gateways and manual host and credential entry remain available. Secure official pairing shows whether the phone has Full or Limited access, and an unencrypted connection to another machine is automatically kept Limited.

On [iPhone and iPad](/platforms/ios), a valid setup QR can now pair and open the main UI in one scan when the connection is already trusted or matches the code, while untrusted connections still stop for approval. OpenClaw explains pairing before asking for Local Network access, lets you decide on optional permissions one at a time, and gives eligible administrators a dedicated Settings conversation for Gateway setup and repair without exposing that privileged assistant in ordinary Chat.

On [Android](/platforms/android), pairing stays usable in landscape, on narrow screens, and with larger system text. Public Gateways can use normal certificate checks while LAN and IP connections keep explicit pinning, and pairing again preserves saved location and notification choices instead of quietly changing consent; revoked permissions remain revoked, and Google Play builds still use foreground location only.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Full-access mobile pairing with an explicit limited mode [#105928](https://github.com/openclaw/openclaw/pull/105928)
- Put iOS gateway QR pairing front and center [#106111](https://github.com/openclaw/openclaw/pull/106111)
- Guide iOS first launch through pairing and permissions [#106129](https://github.com/openclaw/openclaw/pull/106129)
- Make Android gateway pairing prominent in Settings [#106211](https://github.com/openclaw/openclaw/pull/106211)
- Add Android system trust and manual Gateway pinning [#110976](https://github.com/openclaw/openclaw/pull/110976)
- Add an OpenClaw settings assistant to iOS [#112420](https://github.com/openclaw/openclaw/pull/112420)
- Make iOS onboarding connection status clear [#101921](https://github.com/openclaw/openclaw/pull/101921)
- Refresh native translations for access-status screens [#106260](https://github.com/openclaw/openclaw/pull/106260)

**Bug fixes**

- Replace dead-end iOS gateway connections [#103289](https://github.com/openclaw/openclaw/pull/103289)
- Preserve Android gateway hostnames during TLS checks [#105072](https://github.com/openclaw/openclaw/pull/105072)
- Make Android onboarding responsive in landscape and large text [#108405](https://github.com/openclaw/openclaw/pull/108405)
- Keep fresh iOS setup connected after pairing [#108779](https://github.com/openclaw/openclaw/pull/108779)
- Keep Android onboarding actions reachable with large text [#111747](https://github.com/openclaw/openclaw/pull/111747)
- Connect Android to pasted gateway hosts and ports [#113722](https://github.com/openclaw/openclaw/pull/113722)
- fix(gateway): stop secure link creation from hanging [#128545](https://github.com/openclaw/openclaw/pull/128545)
- fix(android): prevent unavailable SMS from reopening onboarding approval [#129077](https://github.com/openclaw/openclaw/pull/129077)
- fix(android): preserve background location during onboarding [#129543](https://github.com/openclaw/openclaw/pull/129543)
- fix(android): preserve notification forwarding consent [#129715](https://github.com/openclaw/openclaw/pull/129715)
- fix(android): preserve disabled location consent during onboarding [#129961](https://github.com/openclaw/openclaw/pull/129961)
- fix(android): serialize legacy gateway discovery [#131001](https://github.com/openclaw/openclaw/pull/131001)
- fix(ios): complete QR pairing in one step [#131267](https://github.com/openclaw/openclaw/pull/131267)
- Allow Android onboarding permission text to wrap [#103649](https://github.com/openclaw/openclaw/pull/103649)
- Keep iOS gateway errors visible during reconnects [#105875](https://github.com/openclaw/openclaw/pull/105875)
- fix(android): skip scoped IPv6 discovery addresses [#130165](https://github.com/openclaw/openclaw/pull/130165)
- fix(ios): stop blaming device storage for incomplete Gateway setup [#130407](https://github.com/openclaw/openclaw/pull/130407)
- Focus the missing gateway credential during iOS onboarding [#98189](https://github.com/openclaw/openclaw/pull/98189)

**Documentation**

- Separate phone browser recovery from native node pairing [#123767](https://github.com/openclaw/openclaw/pull/123767)

</details>

</Accordion>

<Accordion title="Moving, Importing, or Resetting an Existing Setup">

[Imports from Claude, Codex, and Hermes](/install/migrating) now happen in a temporary staging area, where OpenClaw verifies or repairs the model route before making the new setup active. If the source, import plan, or destination changes along the way, promotion stops rather than replaying a half-finished import against different data.

Rerunning onboarding keeps the workspace you already use unless you approve a move, and named agents keep the credentials they own through supported creation and configuration-only resets. OpenClaw validates the provider, Gateway, migration, and workspace choices before a reset can move existing data to Trash, but a valid confirmed reset is still destructive.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Stage onboarding migrations before publishing them [#112798](https://github.com/openclaw/openclaw/pull/112798)
- Allow safe reuse of main as an agent ID [#123609](https://github.com/openclaw/openclaw/pull/123609)

**Bug fixes**

- Make failed Hermes onboarding imports retryable [#103290](https://github.com/openclaw/openclaw/pull/103290)
- Import current Hermes state and provider contracts [#106758](https://github.com/openclaw/openclaw/pull/106758)
- Validate onboarding reset before deleting state [#111348](https://github.com/openclaw/openclaw/pull/111348)
- Keep onboarding effects on the configured default agent [#112738](https://github.com/openclaw/openclaw/pull/112738)
- Allow first-run imports after state initialization [#122967](https://github.com/openclaw/openclaw/pull/122967)
- Keep multi-agent CLI operations with their owning agent [#123871](https://github.com/openclaw/openclaw/pull/123871)
- fix(onboard): keep provider credentials with named first agents [#127572](https://github.com/openclaw/openclaw/pull/127572)
- Preserve plugin ownership during Codex onboarding [#103372](https://github.com/openclaw/openclaw/pull/103372)
- Preserve Gateway settings when rerunning onboarding [#111569](https://github.com/openclaw/openclaw/pull/111569)
- Preserve existing agent workspaces during onboarding reruns [#111787](https://github.com/openclaw/openclaw/pull/111787)
- Honor explicit Gateway options during quickstart onboarding [#112396](https://github.com/openclaw/openclaw/pull/112396)
- Isolate non-default gateway workspaces and skills [#114487](https://github.com/openclaw/openclaw/pull/114487)
- Preserve legacy model restrictions during migration [#114983](https://github.com/openclaw/openclaw/pull/114983)
- Protect OpenClaw state during headless reset [#116491](https://github.com/openclaw/openclaw/pull/116491)
- Honor explicit provider authentication when keeping the current model [#117883](https://github.com/openclaw/openclaw/pull/117883)
- Honor Gateway CLI settings during manual onboarding [#122961](https://github.com/openclaw/openclaw/pull/122961)
- Let onboarding imports survive runtime state initialization [#123106](https://github.com/openclaw/openclaw/pull/123106)
- Migrate legacy Ollama profiles for guided setup [#123341](https://github.com/openclaw/openclaw/pull/123341)
- Doctor handles explicit multi-agent profiles without false failures [#124010](https://github.com/openclaw/openclaw/pull/124010)
- Stop phantom auth migration notices on fresh installs [#124929](https://github.com/openclaw/openclaw/pull/124929)
- Group agent imports in classic onboarding [#126515](https://github.com/openclaw/openclaw/pull/126515)
- Show retryable errors when onboarding memory import fails [#126738](https://github.com/openclaw/openclaw/pull/126738)
- Honor the configured system agent during onboarding [#126861](https://github.com/openclaw/openclaw/pull/126861)
- fix(doctor): keep Claude CLI overrides selectable after migration [#126866](https://github.com/openclaw/openclaw/pull/126866)
- Honor provider credentials while keeping the existing model [#126946](https://github.com/openclaw/openclaw/pull/126946)
- fix: preserve legacy workspace during onboarding [#127059](https://github.com/openclaw/openclaw/pull/127059)
- fix(onboard): preserve named-agent profiles during config resets [#127716](https://github.com/openclaw/openclaw/pull/127716)
- fix(onboard): provider setup changes the wrong agent model in managed fleets [#128119](https://github.com/openclaw/openclaw/pull/128119)
- fix(migrate-claude): re-running Claude migration duplicates imported instructions [#130429](https://github.com/openclaw/openclaw/pull/130429)
- fix: doctor skips per-agent legacy model refs [#130725](https://github.com/openclaw/openclaw/pull/130725)
- fix(configure): keep the existing primary model when adding a custom provider [#131034](https://github.com/openclaw/openclaw/pull/131034)
- fix(configure): preserve the primary model across provider auth overrides [#131119](https://github.com/openclaw/openclaw/pull/131119)
- Preserve Anthropic model settings during Claude CLI migration [#103622](https://github.com/openclaw/openclaw/pull/103622)
- Block prototype pollution in migration config imports [#106116](https://github.com/openclaw/openclaw/pull/106116)
- Handle not-directory paths during onboarding migration [#109161](https://github.com/openclaw/openclaw/pull/109161)
- Reset session history for every agent during onboarding [#112610](https://github.com/openclaw/openclaw/pull/112610)
- Protect the default workspace when onboarding config is unreadable [#114110](https://github.com/openclaw/openclaw/pull/114110)
- Reject reset scope when reset is missing [#115554](https://github.com/openclaw/openclaw/pull/115554)
- Hide empty Matrix migration noise on fresh installs [#122808](https://github.com/openclaw/openclaw/pull/122808)
- Preserve system-agent workspace ownership in Configure [#125377](https://github.com/openclaw/openclaw/pull/125377)
- Point legacy model-reference warnings to Doctor's migration command [#125660](https://github.com/openclaw/openclaw/pull/125660)
- Keep named onboarding state on the created agent [#126463](https://github.com/openclaw/openclaw/pull/126463)
- fix(onboard): name the available providers when --import-from is unknown [#127780](https://github.com/openclaw/openclaw/pull/127780)
- fix(stepfun): preserve selected models when repeating onboarding [#129045](https://github.com/openclaw/openclaw/pull/129045)
- fix(onboard): preserve the saved skills package manager [#130438](https://github.com/openclaw/openclaw/pull/130438)

</details>

</Accordion>

<Accordion title="Automating Setup and Recovering from Interruptions">

[Non-interactive onboarding](/start/wizard-cli-automation) now rejects invalid provider, authentication, Gateway, workspace, and conflicting flow choices before it creates an agent or writes configuration. When `--json` is requested, failures return one machine-readable result instead of empty or mixed output, and a concurrent setup for the same profile fails quickly with the current holder when known instead of sitting there looking frozen.

Cancelled or interrupted setup revokes stale work, while failed provider sign-in or local-model preparation can be retried without cancelling a newer attempt. Gateway health failures stay inside setup with the original diagnostic and recovery hints, but `--json` does not waive risk acknowledgement, and deliberately skipping service startup can still finish without a reachable Gateway, so automation must inspect the reported health instead of trusting exit status alone.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Make setup and doctor repairs follow one safe order [#114375](https://github.com/openclaw/openclaw/pull/114375)
- Add one-click cancellation to Custodian setup [#118953](https://github.com/openclaw/openclaw/pull/118953)

**Bug fixes**

- Recover dashboards and interrupted first-time setup [#118388](https://github.com/openclaw/openclaw/pull/118388)
- Make interrupted onboarding safe to cancel, retry, and resume [#121415](https://github.com/openclaw/openclaw/pull/121415)
- Keep health-check failures inside setup flows [#126758](https://github.com/openclaw/openclaw/pull/126758)
- fix(ui): prevent interrupted model setup from blocking retries [#127657](https://github.com/openclaw/openclaw/pull/127657)
- Reject invalid onboarding options before setup writes [#111680](https://github.com/openclaw/openclaw/pull/111680)
- Preserve invalid config during baseline setup [#112010](https://github.com/openclaw/openclaw/pull/112010)
- Recover expired setup wizards after Gateway restart [#112286](https://github.com/openclaw/openclaw/pull/112286)
- Restore fresh non-interactive onboarding [#113601](https://github.com/openclaw/openclaw/pull/113601)
- Validate non-interactive onboarding before creating setup state [#114823](https://github.com/openclaw/openclaw/pull/114823)
- Keep hosted setup exits from stopping the Gateway [#115671](https://github.com/openclaw/openclaw/pull/115671)
- Prevent overlapping remote setup after cancellation [#115856](https://github.com/openclaw/openclaw/pull/115856)
- Keep hosted wizards alive across Gateway config reloads [#120582](https://github.com/openclaw/openclaw/pull/120582)
- Serialize onboarding and plugin installation [#121482](https://github.com/openclaw/openclaw/pull/121482)
- Gateway setup recovers after lock-release failures [#121915](https://github.com/openclaw/openclaw/pull/121915)
- Allow replacement setup after terminal wizard status [#122054](https://github.com/openclaw/openclaw/pull/122054)
- Fail fast when another onboarding session is active [#122968](https://github.com/openclaw/openclaw/pull/122968)
- Let intentionally unstarted Gateways complete onboarding [#123857](https://github.com/openclaw/openclaw/pull/123857)
- Cancel onboarding cleanly on Ctrl-D or closed stdin [#124780](https://github.com/openclaw/openclaw/pull/124780)
- Report onboarding health failures in JSON summaries [#126801](https://github.com/openclaw/openclaw/pull/126801)
- Reject local Gateway credentials in remote onboarding [#127015](https://github.com/openclaw/openclaw/pull/127015)
- fix(onboard): stop printing two contradictory Fix lines for one failure [#127698](https://github.com/openclaw/openclaw/pull/127698)
- fix(onboard): reject --gateway-bind custom without a valid customBindHost [#127779](https://github.com/openclaw/openclaw/pull/127779)
- fix(onboard): JSON commands return no output without a terminal [#129437](https://github.com/openclaw/openclaw/pull/129437)
- fix(cli): emit JSON failures when existing config is invalid [#129578](https://github.com/openclaw/openclaw/pull/129578)
- refactor(system-agent): unify operator handoffs and proposal lifecycle [#131630](https://github.com/openclaw/openclaw/pull/131630)
- Allow immediate setup-wizard replacement after completion [5c308e0](https://github.com/openclaw/openclaw/commit/5c308e0)
- Release setup admission before completing wizard sessions [f3e1efe](https://github.com/openclaw/openclaw/commit/f3e1efe)
- Reject unknown non-interactive onboarding auth choices [#111409](https://github.com/openclaw/openclaw/pull/111409)
- Ignore blank workspace inputs during automated onboarding [#115537](https://github.com/openclaw/openclaw/pull/115537)
- Reject contradictory non-interactive TUI onboarding [#115573](https://github.com/openclaw/openclaw/pull/115573)
- Reject conflicting custom model input flags [#115595](https://github.com/openclaw/openclaw/pull/115595)
- Reject remote-only flags during local onboarding [#115636](https://github.com/openclaw/openclaw/pull/115636)
- Fail onboarding when a requested daemon install fails [#122845](https://github.com/openclaw/openclaw/pull/122845)
- Prevent failed workspace setup from publishing onboarding config [#124092](https://github.com/openclaw/openclaw/pull/124092)
- Reject command-shaped API keys from environment onboarding [#126776](https://github.com/openclaw/openclaw/pull/126776)
- Reject ignored options on onboarding recommendation actions [#126973](https://github.com/openclaw/openclaw/pull/126973)
- Make onboarding auth-choice help match accepted values [#127030](https://github.com/openclaw/openclaw/pull/127030)
- fix(onboard): emit JSON on option-validation failures [#127794](https://github.com/openclaw/openclaw/pull/127794)
- fix(onboard): emit JSON for remaining non-interactive option rejections [#127976](https://github.com/openclaw/openclaw/pull/127976)
- fix(onboarding): preserve JSON output for rejected setup options [#128542](https://github.com/openclaw/openclaw/pull/128542)
- fix(onboard): reject invalid provider choices without silent success [#128574](https://github.com/openclaw/openclaw/pull/128574)
- fix(cli): make managed Gateway and Node recovery hints actionable [#129243](https://github.com/openclaw/openclaw/pull/129243)
- fix(node): broken Node service suggests repairing the Gateway [#129545](https://github.com/openclaw/openclaw/pull/129545)
- fix(onboarding): recovery hints target the wrong Gateway [#129577](https://github.com/openclaw/openclaw/pull/129577)
- fix(setup): emit JSON failure for invalid baseline config [#129867](https://github.com/openclaw/openclaw/pull/129867)
- fix(onboarding): missing ESM package errors omit the repair hint [#130159](https://github.com/openclaw/openclaw/pull/130159)
- fix(onboarding): remote retry hint omits required risk acknowledgment [#130174](https://github.com/openclaw/openclaw/pull/130174)
- fix(cli): return JSON errors for rejected onboarding recommendation options [#130245](https://github.com/openclaw/openclaw/pull/130245)
- fix(onboard): remote setup no longer enables local hooks [#130292](https://github.com/openclaw/openclaw/pull/130292)
- fix(doctor): stop flagging lazily-created session dirs as missing [#130704](https://github.com/openclaw/openclaw/pull/130704)
- fix(wizard): require literal true for confirmation [#131238](https://github.com/openclaw/openclaw/pull/131238)

**Documentation**

- Fix non-interactive onboarding command examples [#121954](https://github.com/openclaw/openclaw/pull/121954)
- Correct onboarding commands and Google Chat credentials [#118936](https://github.com/openclaw/openclaw/pull/118936)
- Correct the onboarding setup command [#126964](https://github.com/openclaw/openclaw/pull/126964)

</details>

</Accordion>

</AccordionGroup>
