# Contributing to OpenClaw

Welcome to the lobster tank! 🦞

## Quick Links

- **GitHub:** https://github.com/openclaw/openclaw
- **Vision:** [`VISION.md`](VISION.md)
- **Discord:** https://discord.gg/clawd
- **X/Twitter:** [@openclaw](https://x.com/openclaw)

## Maintainers

The current OpenClaw Foundation team and Core Maintainers are listed on the
OpenClaw people page: https://www.openclaw.org/people

## How to Contribute

1. **Bugs & small fixes** → Open a PR!
2. **New features / architecture** → Start a [GitHub Issue](https://github.com/openclaw/openclaw/issues/new/choose) or ask in Discord first. Most features are not accepted and should be third party plugins instead using our plugin SDK.
3. **Refactor-only PRs** → Don't open a PR. We are not accepting refactor-only changes unless a maintainer explicitly asks for them as part of a concrete fix.
4. **Test/CI-only PRs for known `main` failures** → Don't open a PR. The Maintainer team is already tracking those failures, and PRs that only tweak tests or CI to chase them will be closed unless they are required to validate a new fix.
5. **Questions** → Discord [#help](https://discord.com/channels/1456350064065904867/1459642797895319552) / [#users-helping-users](https://discord.com/channels/1456350064065904867/1459007081603403828)

## Issue, PR, and Contact Routing

Start from this routing map before creating GitHub items:

| Situation                                                | Use                                                                                                                                                                                  | Required evidence                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Product bug, regression, crash, or behavior defect       | [Bug report](https://github.com/openclaw/openclaw/issues/new?template=bug_report.yml)                                                                                                | Repro steps, expected vs actual behavior, version, OS, model/provider route when relevant, logs/screenshots, impact |
| Documentation bug or missing/contradictory docs          | [Docs bug report](https://github.com/openclaw/openclaw/issues/new?template=docs_bug_report.yml)                                                                                      | Affected docs path or URL, verification steps, expected docs content, actual docs content, impact, evidence         |
| New feature, architecture change, or product improvement | [Feature request](https://github.com/openclaw/openclaw/issues/new?template=feature_request.yml) or Discord first                                                                     | Problem, proposed solution, alternatives, impact, examples or prior art                                             |
| Onboarding, setup help, or general support question      | Discord [#help](https://discord.com/channels/1456350064065904867/1459642797895319552) / [#users-helping-users](https://discord.com/channels/1456350064065904867/1459007081603403828) | Do not open a GitHub issue unless there is a concrete product defect or docs gap                                    |
| Security vulnerability                                   | See [Report a Vulnerability](#report-a-vulnerability) below                                                                                                                          | Do not file public issues for private security reports                                                              |
| PR for an existing or newly filed issue                  | Use the [PR template](.github/pull_request_template.md)                                                                                                                              | Visible `Closes #<issue>` or `Related: #<issue>`, problem, shipped solution, user impact, validation evidence       |

For agent-authored or otherwise non-trivial work, create or reuse the issue first, then open the PR against it. Bugs and very small fixes may go straight to PR, but still link existing context when it exists and fill out the PR template.

Do not guess who to tag. Let issue forms, labels/automation, and `.github/CODEOWNERS` route the work. Mention a maintainer only when an owned path or documented responsibility is directly relevant and you need a decision; otherwise rely on normal review. For coordinated change sets, ask in **#clawtributors** before opening more than the PR limit.

## PR Limits

We cap at **20 open PRs per author**. If you exceed this, the `r: too-many-prs` label is added and your PR is auto-closed. This is a hard limit.

For coordinated change sets that genuinely need more than 20 PRs, join the **#clawtributors** channel in Discord and talk to maintainers first.

## Before You PR

- Use **Node 24.15+** for source checkouts when possible. OpenClaw also supports Node 22.22.3+ and Node 25.9+, but Node 23, Node 22 before 22.22.3, and Node 24 before 24.15 are below the repository engine floor and can fail before `pnpm` commands run. See [Node install guidance](docs/install/node.md) if your local version is too old.
- Test locally with your OpenClaw instance
- External PRs must describe the user, product, or operational problem in **What Problem This Solves** and include useful validation in **Evidence**. Focused tests, CI results, screenshots, recordings, terminal output, live observations, redacted logs, and artifact links all count. Reviewers will inspect the code, tests, and CI; use the PR body to explain intent and make validation easy to understand.
- When ClawSweeper, Barnacle, or a maintainer asks for more context or evidence, edit the PR description instead of only replying in a new comment. Keep **What Problem This Solves**, **Why This Change Was Made**, **User Impact**, and **Evidence** current; a short comment can point reviewers to the update, but the PR body should remain the durable explanation for maintainers and bots.
- Keep PRs takeover-ready: open them from a branch maintainers can push to. For fork PRs, leave GitHub's **Allow edits by maintainers** option enabled so maintainers can finish urgent fixes, changelog entries, or merge prep when needed. If GitHub shows **Allow edits and access to secrets by maintainers**, enable it only when that workflow/secrets access is acceptable and say so in the PR.
- Do not edit `CHANGELOG.md` in contributor PRs. Maintainers or ClawSweeper add the changelog entry when landing user-facing changes.
- Run tests: `pnpm build && pnpm check && pnpm test`
- For iterative local commits, `scripts/committer --fast "message" <files...>` skips commit hooks. Only use it when you've already run equivalent targeted validation for the touched surface.
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
- If you are using an AI coding agent with OpenClaw skills available, run the `autoreview` skill before opening or updating your PR. Address accepted/actionable findings before asking for review.
- Do not submit refactor-only PRs unless a maintainer explicitly requested that refactor for an active fix or deliverable.
- Do not submit test or CI-config fixes for failures already red on `main` CI. If a failure is already visible in the [main branch CI runs](https://github.com/openclaw/openclaw/actions), it's a known issue the Maintainer team is tracking, and a PR that only addresses those failures will be closed automatically. If you spot a _new_ regression not yet shown in main CI, report it as an issue first.
- Do not submit test-only PRs that just try to make known `main` CI failures pass. Test changes are acceptable when they are required to validate a new fix or cover new behavior in the same PR.
- Ensure CI checks pass
- Keep PRs focused (one thing per PR; do not mix unrelated concerns)
- Describe what & why
- **Include screenshots** — one showing the problem/before, one showing the fix/after (for UI or visual changes)
- Use American English spelling and grammar in code, comments, docs, and UI strings
- Do not edit files covered by `CODEOWNERS` security ownership unless a listed owner explicitly asked for the change or is already reviewing it with you. Treat those paths as restricted review surfaces, not opportunistic cleanup targets.

## Review Conversations Are Author-Owned

After your PR receives Barnacle, ClawSweeper, or maintainer feedback, read the [pull request review flow](https://docs.openclaw.ai/reference/pull-request-review-flow) for how to interpret rank-up moves, proof guidance, re-review requests, and review conversation follow-up.

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
- [ ] Include a concise **Evidence** section with the most useful validation. Reviewers will inspect the code, tests, and CI rather than relying on the PR body alone.
- [ ] Include prompts or session logs if possible (super helpful!)
- [ ] Confirm you understand what the code does
- [ ] Run the `autoreview` skill when available and address accepted/actionable findings
- [ ] Follow the [pull request review flow](https://docs.openclaw.ai/reference/pull-request-review-flow) after Barnacle, ClawSweeper, or maintainer feedback

AI PRs are first-class citizens here. We just want transparency so reviewers know what to look for.

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
