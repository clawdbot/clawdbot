# Contributing to OpenClaw

Welcome to the lobster tank! 🦞

## Quick Links

- **GitHub:** https://github.com/openclaw/openclaw
- **Vision:** [`VISION.md`](VISION.md)
- **Discord:** https://discord.gg/qkhbAGHRBT
- **X/Twitter:** [@steipete](https://x.com/steipete) / [@openclaw](https://x.com/openclaw)

## Maintainers

- **Peter Steinberger** - Benevolent Dictator
  - GitHub: [@steipete](https://github.com/steipete) · X: [@steipete](https://x.com/steipete)

- **Shadow** - Discord subsystem, Discord admin, Clawhub, all community moderation
  - GitHub: [@thewilloftheshadow](https://github.com/thewilloftheshadow) · X: [@4shadowed](https://x.com/4shadowed)

- **Vignesh** - Memory (QMD), formal modeling, TUI, IRC, and Lobster
  - GitHub: [@vignesh07](https://github.com/vignesh07) · X: [@\_vgnsh](https://x.com/_vgnsh)

- **Jos** - Telegram, API, Nix mode
  - GitHub: [@joshp123](https://github.com/joshp123) · X: [@jjpcodes](https://x.com/jjpcodes)

- **Ayaan Zaidi** - Telegram subsystem, Android app
  - GitHub: [@obviyus](https://github.com/obviyus) · X: [@obviyus](https://x.com/obviyus)

- **Tyler Yust** - Agents/subagents, cron, BlueBubbles, macOS app
  - GitHub: [@tyler6204](https://github.com/tyler6204) · X: [@tyleryust](https://x.com/tyleryust)

- **Mariano Belinky** - iOS app, Security
  - GitHub: [@mbelinky](https://github.com/mbelinky) · X: [@belimad](https://x.com/belimad)

- **Nimrod Gutman** - iOS app, macOS app and crustacean features
  - GitHub: [@ngutman](https://github.com/ngutman) · X: [@theguti](https://x.com/theguti)

- **Vincent Koc** - Agents, Telemetry, Hooks, Security
  - GitHub: [@vincentkoc](https://github.com/vincentkoc) · X: [@vincent_koc](https://x.com/vincent_koc)

- **Val Alexander** - UI/UX, Docs, and Agent DevX
  - GitHub: [@BunsDev](https://github.com/BunsDev) · X: [@BunsDev](https://x.com/BunsDev)

- **Seb Slight** - Docs, Agent Reliability, Runtime Hardening
  - GitHub: [@sebslight](https://github.com/sebslight) · X: [@sebslig](https://x.com/sebslig)

- **Christoph Nakazawa** - JS Infra
  - GitHub: [@cpojer](https://github.com/cpojer) · X: [@cnakazawa](https://x.com/cnakazawa)

- **Gustavo Madeira Santana** - Multi-agents, CLI, Performance, Plugins, Matrix
  - GitHub: [@gumadeiras](https://github.com/gumadeiras) · X: [@gumadeiras](https://x.com/gumadeiras)

- **Onur Solmaz** - Agents, dev workflows, ACP integrations, MS Teams
  - GitHub: [@onutc](https://github.com/onutc), [@osolmaz](https://github.com/osolmaz) · X: [@onusoz](https://x.com/onusoz)

- **Josh Avant** - Core, CLI, Gateway, Security, Agents
  - GitHub: [@joshavant](https://github.com/joshavant) · X: [@joshavant](https://x.com/joshavant)

- **Jonathan Taylor** - ACP subsystem, Gateway features/bugs, Gog/Mog/Sog CLI's, SEDMAT
  - GitHub [@visionik](https://github.com/visionik) · X: [@visionik](https://x.com/visionik)

- **Josh Lehman** - Compaction, Tlon/Urbit subsystem
  - GitHub [@jalehman](https://github.com/jalehman) · X: [@jlehman\_](https://x.com/jlehman_)

- **Radek Sienkiewicz** - Docs, Control UI
  - GitHub [@velvet-shark](https://github.com/velvet-shark) · X: [@velvet_shark](https://twitter.com/velvet_shark)

- **Muhammed Mukhthar** - Mattermost, CLI
  - GitHub [@mukhtharcm](https://github.com/mukhtharcm) · X: [@mukhtharcm](https://x.com/mukhtharcm)

- **Altay** - Agents, CLI, error handling
  - GitHub [@altaywtf](https://github.com/altaywtf) · X: [@altaywtf](https://x.com/altaywtf)

- **Robin Waslander** - Security, PR triage, bug fixes
  - GitHub: [@hydro13](https://github.com/hydro13) · X: [@Robin_waslander](https://x.com/Robin_waslander)

- **Tengji (George) Zhang** - Chinese model APIs, cloud, pi
  - GitHub: [@odysseus0](https://github.com/odysseus0) · X: [@odysseus0z](https://x.com/odysseus0z)

- **Sliverp** - Chinese Channel: QQ, WeChat, Wecom, Dingtalk, Feishu
  - GitHub: [@sliverp](https://github.com/sliverp) · X: [@sliver01234](https://x.com/sliver01234)

- **Mason Huang** - Stability, Security, Speed
  - GitHub: [@hxy91819](https://github.com/hxy91819) · X: [@chenjingtalk](https://x.com/chenjingtalk)

## How to Contribute

1. **Bugs & small fixes** → Open a PR!
2. **New features / architecture** → Start a [GitHub Discussion](https://github.com/openclaw/openclaw/discussions) or ask in Discord first
3. **Refactor-only PRs** → Don't open a PR. We are not accepting refactor-only changes unless a maintainer explicitly asks for them as part of a concrete fix.
4. **Test/CI-only PRs for known `main` failures** → Don't open a PR. The Maintainer team is already tracking those failures, and PRs that only tweak tests or CI to chase them will be closed unless they are required to validate a new fix.
5. **Questions** → Discord [#help](https://discord.com/channels/1456350064065904867/1459642797895319552) / [#users-helping-users](https://discord.com/channels/1456350064065904867/1459007081603403828)

## PR Limits

We cap at **10 open PRs per author**. If you exceed this, the `r: too-many-prs` label is added and your PR is auto-closed. This is a hard limit.

For coordinated change sets that genuinely need more than 10 PRs, join the **#clawtributors** channel in Discord and talk to maintainers first.

## Before You PR

- Test locally with your OpenClaw instance
- Run tests: `pnpm build && pnpm check && pnpm test`
- For iterative local commits, `scripts/committer --fast "message" <files...>` passes `FAST_COMMIT=1` through to the pre-commit hook so it skips the repo-wide `pnpm check`. Only use it when you've already run equivalent targeted validation for the touched surface.
- For extension/plugin changes, run the fast local lane first:
  - `pnpm test:extension <extension-name>`
  - `pnpm test:extension --list` to see valid extension ids
  - If you changed shared plugin or channel surfaces, run `pnpm test:contracts`
  - For targeted shared-surface work, use `pnpm test:contracts:channels` or `pnpm test:contracts:plugins`
  - These commands also cover the shared seam/smoke files that the default unit lane skips
  - If you changed broader runtime behavior, still run the relevant wider lanes (`pnpm test:extensions`, `pnpm test:channels`, or `pnpm test`) before asking for review
- If you touched bundled-plugin boundaries in shared code, run the matching inventories:
  - `node scripts/check-src-extension-import-boundary.mjs --json` for `src/**`
  - `node scripts/check-sdk-package-extension-import-boundary.mjs --json` for `src/plugin-sdk/**` and `packages/**`
  - `node scripts/check-test-helper-extension-import-boundary.mjs --json` for `test/helpers/**`
- Shared test helpers must use `src/test-utils/bundled-plugin-public-surface.ts` instead of repo-relative `extensions/**` imports. Keep plugin-local deep mocks inside the owning bundled plugin package.
- If you have access to Codex, run `codex review --base origin/main` locally before opening or updating your PR. Treat this as the current highest standard of AI review, even if GitHub Codex review also runs.
- Do not submit refactor-only PRs unless a maintainer explicitly requested that refactor for an active fix or deliverable.
- Do not submit test or CI-config fixes for failures already red on `main` CI. If a failure is already visible in the [main branch CI runs](https://github.com/openclaw/openclaw/actions), it's a known issue the Maintainer team is tracking, and a PR that only addresses those failures will be closed automatically. If you spot a _new_ regression not yet shown in main CI, report it as an issue first.
- Do not submit test-only PRs that just try to make known `main` CI failures pass. Test changes are acceptable when they are required to validate a new fix or cover new behavior in the same PR.
- Ensure CI checks pass
- Keep PRs focused (one thing per PR; do not mix unrelated concerns)
- Describe what & why
- Reply to or resolve bot review conversations you addressed before asking for review again
- **Include screenshots** — one showing the problem/before, one showing the fix/after (for UI or visual changes)
- Use American English spelling and grammar in code, comments, docs, and UI strings
- Do not edit files covered by `CODEOWNERS` security ownership unless a listed owner explicitly asked for the change or is already reviewing it with you. Treat those paths as restricted review surfaces, not opportunistic cleanup targets.

## Review Conversations Are Author-Owned

If a review bot leaves review conversations on your PR, you are expected to handle the follow-through:

- Resolve the conversation yourself once the code or explanation fully addresses the bot's concern
- Reply and leave it open only when you need maintainer or reviewer judgment
- Do not leave "fixed" bot review conversations for maintainers to clean up for you
- If Codex leaves comments, address every relevant one or resolve it with a short explanation when it is not applicable to your change
- If GitHub Codex review does not trigger for some reason, run `codex review --base origin/main` locally anyway and treat that output as required review work

This applies to both human-authored and AI-assisted PRs.

## Control UI Decorators

The Control UI uses Lit with **legacy** decorators (current Rollup parsing does not support
`accessor` fields required for standard decorators). When adding reactive fields, keep the
legacy style:

```ts
@state() foo = "bar";
@property({ type: Number }) count = 0;
```

The root `tsconfig.json` is configured for legacy decorators (`experimentalDecorators: true`)
with `useDefineForClassFields: false`. Avoid flipping these unless you are also updating the UI
build tooling to support standard decorators.

## AI/Vibe-Coded PRs Welcome! 🤖

Built with Codex, Claude, or other AI tools? **Awesome - just mark it!**

Please include in your PR:

- [ ] Mark as AI-assisted in the PR title or description
- [ ] Note the degree of testing (untested / lightly tested / fully tested)
- [ ] Include prompts or session logs if possible (super helpful!)
- [ ] Confirm you understand what the code does
- [ ] If you have access to Codex, run `codex review --base origin/main` locally and address the findings before asking for review
- [ ] Resolve or reply to bot review conversations after you address them

AI PRs are first-class citizens here. We just want transparency so reviewers know what to look for. If you are using an LLM coding agent, instruct it to resolve bot review conversations it has addressed instead of leaving them for maintainers.

## Current Focus & Roadmap 🗺

We are currently prioritizing:

- **Stability**: Fixing edge cases in channel connections (WhatsApp/Telegram).
- **UX**: Improving the onboarding wizard and error messages.
- **Skills**: For skill contributions, head to [ClawHub](https://clawhub.ai/) — the community hub for OpenClaw skills.
- **Performance**: Optimizing token usage and compaction logic.

Check the [GitHub Issues](https://github.com/openclaw/openclaw/issues) for
["good first issue"](https://github.com/openclaw/openclaw/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
labels. If none are open, pick a small docs or bug issue and leave a quick comment saying
you'd like to work on it.

## Maintainers

We're selectively expanding the maintainer team.
If you're an experienced contributor who wants to help shape OpenClaw's direction — whether through code, docs, or community — we'd like to hear from you.

Being a maintainer is a responsibility, not an honorary title. We expect active, consistent involvement — triaging issues, reviewing PRs, and helping move the project forward.

Still interested? Email contributing@openclaw.ai with:

- Links to your PRs on OpenClaw (if you don't have any, start there first)
- Links to open source projects you maintain or actively contribute to
- Your GitHub, Discord, and X/Twitter handles
- A brief intro: background, experience, and areas of interest
- Languages you speak and where you're based
- How much time you can realistically commit

We welcome people across all skill sets — engineering, documentation, community management, and more.
We review every human-only-written application carefully and add maintainers slowly and deliberately.
Please allow a few weeks for a response.

## Report a Vulnerability

We take security reports seriously. Report vulnerabilities directly to the repository where the issue lives:

- **Core CLI and gateway** — [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **macOS desktop app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/macos)
- **iOS app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/ios)
- **Android app** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/android)
- **ClawHub** — [openclaw/clawhub](https://github.com/openclaw/clawhub)
- **Trust and threat model** — [openclaw/trust](https://github.com/openclaw/trust)

For issues that don't fit a specific repo, or if you're unsure, email **security@openclaw.ai** and we'll route it.

### Required in Reports

1. **Title**
2. **Severity Assessment**
3. **Impact**
4. **Affected Component**
5. **Technical Reproduction**
6. **Demonstrated Impact**
7. **Environment**
8. **Remediation Advice**

Reports without reproduction steps, demonstrated impact, and remediation advice will be deprioritized. Given the volume of AI-generated scanner findings, we must ensure we're receiving vetted reports from researchers who understand the issues.
