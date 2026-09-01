---
name: verify-openclaw
description: Verify OpenClaw with CONTRIBUTING.md commands before a PR.
---

# Verify OpenClaw

Follow CONTRIBUTING.md. Use the workspace installer at repo root.

Runtime: Node 24.15+ for source checkouts when possible (also 22.22.3+ and 25.9+; Node 23 unsupported). docs/install/node.md recommends Node 26.

Contributor bar from CONTRIBUTING.md:

    pnpm install
    pnpm build && pnpm check && pnpm test

pnpm verify runs check then test and does not replace build.
Targeted lanes: check:changed, test:fast, test:extension, test:contracts, docs:list, format:docs:check.

Do not submit refactor-only PRs, test or CI-only for known main failures, CHANGELOG.md, security CODEOWNERS paths without an owner, or public vuln disclosure.

PR title: type: user-facing description (feat, fix, improve, refactor, docs, chore). One problem. American English. Fill the PR template. Keep Allow edits from maintainers enabled.
