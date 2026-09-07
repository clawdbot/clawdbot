---
title: "v2026.8.1: Skills"
description: "Creating, validating, finding, installing, and calling skills now follow one connected path, with Skill Workshop holding proposals, checks, decisions, and applied history."
---

[Skills](/tools/skills) turn the way you work into reusable instructions your Claw can follow again, and this release connects the entire path. You can create and validate a skill, find or install it, call it directly from a conversation, review proposed changes, and have supported edits ready on the next turn of a persistent session. Invalid skills are reported individually, so the rest of the catalog remains available.

Skill Workshop brings proposals, checks, decisions, and applied history into one workflow. Self-learning can turn substantial work and durable corrections into proposed improvements, or maintain skills created through Workshop when automatic learning is enabled, while skills owned by you or someone else stay under their owner's control.

<AccordionGroup>

<Accordion title="Creating and checking skills">

[Creating a skill](/tools/creating-skills) now follows one guided path from choosing how it should be invoked through adding supporting files, saving it, and validating the result. The checker understands supported invocation metadata and catches problems such as an overlong description before anything is written.

OpenClaw now reports malformed metadata, unreadable files, oversized instructions, and shadowed copies against the skill that caused them, while continuing to load valid skills around it. In a persistent Gateway session, edits to canonical and managed-worktree skills are available on the next turn, and required skill instructions are read in full.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Improve skill-authoring workflow and invocation validation [#121955](https://github.com/openclaw/openclaw/pull/121955)

**Bug fixes**

- Load JSON5-style skill metadata and report parser errors [#108926](https://github.com/openclaw/openclaw/pull/108926)
- Surface skill and workspace bootstrap load failures [#125348](https://github.com/openclaw/openclaw/pull/125348)
- Warn when execution-directory skills are shadowed [#125865](https://github.com/openclaw/openclaw/pull/125865)
- Refresh edited skills in persistent Gateway sessions [#125962](https://github.com/openclaw/openclaw/pull/125962)
- fix(agents): serve skill instructions whole instead of rejecting read windows [#130286](https://github.com/openclaw/openclaw/pull/130286)
- fix: report missing requirements for agent-excluded skills [#132110](https://github.com/openclaw/openclaw/pull/132110)
- fix(skills): expand Windows short paths before watching [ce32e00](https://github.com/openclaw/openclaw/commit/ce32e00)
- Warn when skill frontmatter is missing its closing delimiter [#110479](https://github.com/openclaw/openclaw/pull/110479)
- fix(skills): show byte-aware errors for long descriptions [#128594](https://github.com/openclaw/openclaw/pull/128594)
- fix(skills): restore evidence-backed authoring guidance [#129425](https://github.com/openclaw/openclaw/pull/129425)

</details>

</Accordion>

<Accordion title="Finding, Installing, and Using Skills">

[Installed skills](/tools/skills), ClawHub discovery, skill settings, and Skill Workshop now share one Plugins hub, giving you one place to find a skill, install it, configure it, and confirm its current status. Skills and plugins keep their separate lifecycles, while reconnecting or switching the active agent, model, or connectors refreshes the lists from the current Gateway.

When a skill is available to you and the active agent, you can choose it in chat or name up to eight with `$skill-name` across supported chat and agent entry points, including eligible skills hidden from automatic model selection. The chat picker adds references to your draft without sending it, and Code Mode can list and read eligible skills within its existing sandbox and allowlist. Large model-visible catalogs can still be compacted, so `openclaw skills check` remains the complete inventory.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Add first-class skill access to Code Mode [#114894](https://github.com/openclaw/openclaw/pull/114894)
- Reference multiple skills inside a Control UI prompt [#116330](https://github.com/openclaw/openclaw/pull/116330)
- Invoke explicit skill references on every channel [#123387](https://github.com/openclaw/openclaw/pull/123387)
- Combine Plugins, Skills, and Workshop in one hub [#104834](https://github.com/openclaw/openclaw/pull/104834)
- Show readable skill titles in the chat reference picker [#124017](https://github.com/openclaw/openclaw/pull/124017)
- Remove content hashes from skill catalogs [#126951](https://github.com/openclaw/openclaw/pull/126951)

**Bug fixes**

- Prevent quoted Codex context from invoking skills [#123345](https://github.com/openclaw/openclaw/pull/123345)
- Pass explicit skill selections to Codex as structured input [#123441](https://github.com/openclaw/openclaw/pull/123441)
- Make explicit skill references work in agent turns [#124784](https://github.com/openclaw/openclaw/pull/124784)
- Keep Skills state accurate during mutations and refreshes [#105671](https://github.com/openclaw/openclaw/pull/105671)
- Refresh macOS skill availability after Gateway changes [#107660](https://github.com/openclaw/openclaw/pull/107660)
- Align skill overrides, prompt limits, and tool access [#116817](https://github.com/openclaw/openclaw/pull/116817)
- Show inherited agent skill allowlists accurately [#124429](https://github.com/openclaw/openclaw/pull/124429)
- Keep model-visible skill catalogs bounded and available [#125346](https://github.com/openclaw/openclaw/pull/125346)
- fix(skills): load hidden skills from channel slash commands [#126335](https://github.com/openclaw/openclaw/pull/126335)
- Prevent stale tools and skills after reconnects [#126826](https://github.com/openclaw/openclaw/pull/126826)
- fix: recognize newly installed skill and Gmail dependencies [#131617](https://github.com/openclaw/openclaw/pull/131617)
- Preserve descriptions in compact skill catalogs [#88426](https://github.com/openclaw/openclaw/pull/88426)
- fix(ui): show agent skill matches while filtering [#127663](https://github.com/openclaw/openclaw/pull/127663)

</details>

</Accordion>

<Accordion title="Reviewing Changes in Skill Workshop">

[Skill Workshop](/tools/skill-workshop) gives you one place to turn an idea or a reusable lesson from substantial past work into a reviewable skill change. You can inspect the proposed instructions and supporting files, see results from plugin-provided scanners, benchmarks, and graders, revise the proposal, and then apply, reject, or quarantine it. Past-work scans produce pending proposals rather than editing live skills, and Android users can search and inspect them before an authenticated administrator makes a change.

Every decision stays bound to the exact proposal revision you reviewed, so a later revision returns for review. Critical prompt-injection findings block application, interrupted applies can recover without overwriting a target changed elsewhere, and an explicitly selected remote Gateway remains the authority for the change. Applied revisions are grouped by skill with newest-first history and comparisons that say when the visible diff is incomplete.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Review Skill Workshop proposals from Android [#101911](https://github.com/openclaw/openclaw/pull/101911)
- Scan past sessions for Skill Workshop ideas [#106766](https://github.com/openclaw/openclaw/pull/106766)
- Add Skill Workshop evaluation and lifecycle hooks [#115606](https://github.com/openclaw/openclaw/pull/115606)
- Remove redundant Skill Workshop approval prompts by default [#107690](https://github.com/openclaw/openclaw/pull/107690)
- Show changes between applied Skill Workshop revisions [#125854](https://github.com/openclaw/openclaw/pull/125854)

**Bug fixes**

- Keep Skill Workshop proposals as complete skills [#108339](https://github.com/openclaw/openclaw/pull/108339)
- Detect prompt injection split across skill lines [#117254](https://github.com/openclaw/openclaw/pull/117254)
- Preserve Skill Workshop updates across worktree sessions [#125737](https://github.com/openclaw/openclaw/pull/125737)
- Honor Skill Workshop auto approvals in agent calls [#102530](https://github.com/openclaw/openclaw/pull/102530)
- Keep Skill Workshop approval target names Unicode-safe [#102963](https://github.com/openclaw/openclaw/pull/102963)
- Restore scrolling in Skill Workshop board mode [#108197](https://github.com/openclaw/openclaw/pull/108197)
- Refresh Workshop skills without restarting Gateway [#114456](https://github.com/openclaw/openclaw/pull/114456)
- Preserve Skill Workshop apply reasons and correct its docs [#114471](https://github.com/openclaw/openclaw/pull/114471)
- Preserve Skill Workshop proposals across crashes and workspace moves [#114535](https://github.com/openclaw/openclaw/pull/114535)
- Recover interrupted Skills Workshop applies safely [#115885](https://github.com/openclaw/openclaw/pull/115885)
- Restore offline Skill Workshop apply after configless upgrades [#115982](https://github.com/openclaw/openclaw/pull/115982)
- fix(skills): fail closed for unavailable remote Gateway [#117567](https://github.com/openclaw/openclaw/pull/117567)
- Mark manually installed Skill Workshop proposals stale [#118676](https://github.com/openclaw/openclaw/pull/118676)
- Prevent Skill Workshop proposal lists from timing out against themselves [#123553](https://github.com/openclaw/openclaw/pull/123553)
- Show Skill Workshop evaluator outcomes immediately [#123994](https://github.com/openclaw/openclaw/pull/123994)
- Group applied Skill Workshop revisions by skill [#125794](https://github.com/openclaw/openclaw/pull/125794)
- Mark incomplete Skill Workshop diffs as truncated [#125922](https://github.com/openclaw/openclaw/pull/125922)
- Require re-review when Skill Workshop proposals change [#126156](https://github.com/openclaw/openclaw/pull/126156)
- Prevent Skill Workshop overflow on small-context models [#126158](https://github.com/openclaw/openclaw/pull/126158)
- Keep Skill Workshop revision drafts until Gateway admission [#126166](https://github.com/openclaw/openclaw/pull/126166)
- Keep Skill Workshop proposal revisions atomic [#126485](https://github.com/openclaw/openclaw/pull/126485)
- Reject invalid Skill Workshop proposal-list limits [#103496](https://github.com/openclaw/openclaw/pull/103496)
- Preserve emoji in Skill Workshop previews [#104047](https://github.com/openclaw/openclaw/pull/104047)
- Show Android Skill Workshop filters without truncation [#107574](https://github.com/openclaw/openclaw/pull/107574)
- Keep emoji intact in Skill Workshop history scans [#107720](https://github.com/openclaw/openclaw/pull/107720)
- Keep Skill Workshop resume batches reconstructable [#109741](https://github.com/openclaw/openclaw/pull/109741)
- Restore proposal details on Skill Workshop approval cards [#117549](https://github.com/openclaw/openclaw/pull/117549)
- Preserve complete Unicode characters in Skill Workshop evaluations [#117673](https://github.com/openclaw/openclaw/pull/117673)
- Forward correlation metadata to skill evaluators [#123425](https://github.com/openclaw/openclaw/pull/123425)
- fix(cli): plugins inspect skill-workshop fails on multi-agent rosters [#124283](https://github.com/openclaw/openclaw/pull/124283)
- fix(cli): return JSON for curator and workshop failures [#128601](https://github.com/openclaw/openclaw/pull/128601)

</details>

</Accordion>

<Accordion title="How Skills Improve Over Time">

OpenClaw can turn substantial work and durable corrections into reusable skills, then improve the Workshop-created skills that actually shaped a run. New and unconfigured installations start in `auto`, while upgrades keep their existing choice. `off` disables automatic repair, `propose` queues changes for review, and `auto` can create or update Workshop-owned skills with targeted patches or a same-turn repair. The conversation already in progress keeps the version it loaded until the next turn.

Skills you wrote and shared skills owned elsewhere remain yours. [Automatic learning](/tools/self-learning) can suggest improvements to them, but it cannot rewrite or remove them on its own, and explicit `/learn` or past-work scans also produce proposals for review.

On supported agent runtimes, optional background review runs separately without interrupting or posting into chat. When both the learning mode and scheduled-job settings allow it, a visible weekly job reviews the collection, records usage and outcomes, preserves specialized skills, and creates recoverable backups. Restoring a backup remains an explicit choice.

<details class="release-source-toggle">
<summary>Sources and complete change list</summary>

**Improvements**

- Propose reusable skills after substantial successful work [#105674](https://github.com/openclaw/openclaw/pull/105674)
- Make learned skill proposals easier to discover and reuse [#115103](https://github.com/openclaw/openclaw/pull/115103)
- Make self-learning automatic by default [#115576](https://github.com/openclaw/openclaw/pull/115576)
- Let Skill Workshop apply targeted learning patches [#119891](https://github.com/openclaw/openclaw/pull/119891)
- Improve skills used by a run through autonomous review [#121493](https://github.com/openclaw/openclaw/pull/121493)
- Let agents repair a used skill during the same turn [#121522](https://github.com/openclaw/openclaw/pull/121522)
- Add daily whole-collection skill reconciliation [#121653](https://github.com/openclaw/openclaw/pull/121653)
- feat(cron): schedule the skill collection review as a system-owned job [#130030](https://github.com/openclaw/openclaw/pull/130030)
- Learn from deep interrupted turns [#115887](https://github.com/openclaw/openclaw/pull/115887)

**Bug fixes**

- Make self-learning reviewer-only and prevent verbatim chat capture [#119818](https://github.com/openclaw/openclaw/pull/119818)
- Protect user-owned skills from autonomous Workshop cleanup [#125666](https://github.com/openclaw/openclaw/pull/125666)
- fix(skills): fork the foreground session for lean experience review [#129282](https://github.com/openclaw/openclaw/pull/129282)
- Enable delayed self-learning review for Codex sessions [#114501](https://github.com/openclaw/openclaw/pull/114501)
- Keep skill reviews running through cold starts and auth failures [#115950](https://github.com/openclaw/openclaw/pull/115950)
- Make automatic experience reviews run on live gateways [#116040](https://github.com/openclaw/openclaw/pull/116040)
- Preserve specialized skills during collection cleanup [#121829](https://github.com/openclaw/openclaw/pull/121829)
- Restore scheduled Skill Workshop reviews in auto mode [#123340](https://github.com/openclaw/openclaw/pull/123340)
- Protect shared skill roots during collection review [#123374](https://github.com/openclaw/openclaw/pull/123374)
- Exclude low-signal proposals from Skill Workshop capture [#125716](https://github.com/openclaw/openclaw/pull/125716)
- Back off failed skill collection reviews [#125899](https://github.com/openclaw/openclaw/pull/125899)
- Keep scheduled skill reviews due through Gateway restarts [#126948](https://github.com/openclaw/openclaw/pull/126948)
- fix(skills): patch skills above the read budget [#128871](https://github.com/openclaw/openclaw/pull/128871)
- fix: skill reviews recover after runtime config changes [#129218](https://github.com/openclaw/openclaw/pull/129218)
- fix(skills): record skill usage again and retire dead curator tables [#129769](https://github.com/openclaw/openclaw/pull/129769)
- fix(skills): keep the experience review on the foreground prompt-cache prefix [#130013](https://github.com/openclaw/openclaw/pull/130013)
- fix(skills): hide detached experience reviews from chat [#130217](https://github.com/openclaw/openclaw/pull/130217)
- fix(skills): stop experience reviews from blocking chats [#131077](https://github.com/openclaw/openclaw/pull/131077)
- Retry self-learning toggles after concurrent config changes [#106764](https://github.com/openclaw/openclaw/pull/106764)
- Keep Skill Workshop collection restores retryable [#126014](https://github.com/openclaw/openclaw/pull/126014)

</details>

</Accordion>

</AccordionGroup>
