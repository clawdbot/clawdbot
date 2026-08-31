---
name: openclaw-docker-e2e-authoring
description: "Author OpenClaw Docker E2E and live provider Docker lanes."
---

# OpenClaw Docker E2E Authoring

Use this when adding or changing Docker E2E lanes, release-path Docker tests,
or live-provider Docker proof.

## Lane Choice

- Deterministic Docker: fake the dependency/server and assert the exact runtime
  contract crossing the boundary.
- Live Docker: use real provider credentials/model only when user-visible
  behavior needs the real service.
- Prefer both when they prove different risks: deterministic for byte/payload
  routing, live for actual provider behavior.

## Authoring Rules

- Test-only helpers live in `test/helpers` or `scripts/e2e/lib/<lane>/`, not
  `src/**`, unless production imports them.
- Package-installed app runs from `/app`; mount only explicit harness/helper
  paths read-only.
- Fake servers should log boundary requests as JSONL and clients should assert
  the real dependency payload, not just process success.
- Add the package script and `scripts/lib/docker-e2e-scenarios.mjs` lane in the
  same change.
- If a lane installs a plugin from npm, default the spec via env so published
  and local override paths are both testable.

## Media And Vision

- Expected answer must exist only in pixels or provider output being tested.
- Use neutral filenames, neutral prompts, and no metadata leaks.
- Random bitmap/OCR tokens reuse the repo OCR-safe alphabet `24567ACEF` unless
  the test owns a stronger glyph set.
- Make the expected answer unique per run when proving real image
  understanding.

## `chat.send` E2E

- Require `chat.send` to return `status: "started"` and a string `runId`.
- Wait for completion with `agent.wait`.
- Assert final user-visible text via `chat.history` when event ordering is not
  the behavior under test.
- Keep originating channel/account metadata only when the bug path needs queued
  inbound/channel context.

## Verification

Run the smallest proof that covers the touched lane:

```bash
pnpm exec oxfmt --write <changed files>
node --check <new .mjs files>
bash -n <new .sh files>
node scripts/run-vitest.mjs test/scripts/docker-e2e-plan.test.ts
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:<lane>
```

For real-provider lanes, run the matching live Docker script after deterministic
Docker is green. Finish with `$autoreview` before commit/PR.
