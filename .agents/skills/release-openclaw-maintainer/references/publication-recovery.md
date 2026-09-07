# Publication authentication and recovery

Use `$one-password` before any credential operation, and `$release-private`
when available for maintainer credential locators. Core package publishing is
GitHub OIDC trusted publishing; never substitute `NPM_TOKEN` or plugin OTP
commands. GitHub's `npm-release` environment must be approved by
`@openclaw/openclaw-release-managers`.

The regular publish parent runs from the protected
`release-publish/<tooling-sha12>-<epoch>` tag minted at the pinned Tooling SHA;
use the candidate helper's printed command. Do not dispatch npm/plugin/ClawHub
publication from a moving main parent. Docker-only recovery may use main.
Tideclaw alpha uses its matching alpha branch and its owning skill.

Publication promotes previously qualified bytes. Bind the successful Full
Release Validation manifest, exact target SHA, successful attempt, and npm
preflight artifact identities. Current manifests contain npm qualification, so
both run-id inputs use that same run; historical manifests may need separate
npm preflight. Never rebuild as an implicit retry. Selected plugin repairs
require a nonempty `plugin_publish_scope=selected` package list; all-publishable
runs still need full immutable evidence even with core npm disabled.

Classify a failure before changing Git state:

- Product defect: repair the release branch, freeze a new Code SHA, replace
  downstream evidence; after npm publication use a new beta/version.
- Changelog-only defect: replace Release SHA and reuse Code SHA evidence only
  after proving the exact changelog delta.
- Tooling/provenance, credential/infrastructure, wrapper, approval, or selector
  failure: keep the candidate and recover the smallest failed surface. Change
  Tooling SHA only when needed and record the invalidated evidence.

After one diagnosis, fix when needed, and narrow retry, reassess. Do not rerun
all phases or scan moving main automatically. Operator-authorized beta-attempt
limits count admitted product attempts, not infrastructure retries.

## Published version, failed parent

Registry propagation may briefly return E404 after a successful npm child.
Use bounded `--prefer-online` reads and preserve the verified tarball/integrity
metadata. For an already-published version, run:

```bash
node --import tsx scripts/openclaw-npm-postpublish-verify.ts <published-version>
pnpm release:verify-beta -- <published-version> ... --skip-github-release
```

Use the original successful child run IDs and evidence output path with the
beta verifier. Restore the draft, dependency evidence asset, proof section and
finalization from that evidence. Never rerun publication for bytes already
published. A failed postpublish confidence lane does not authorize unpublishing.

Follow `docs/reference/RELEASING.md`: once a beta tag has been pushed, use the
next beta number rather than deleting or recreating it, even before npm
publication. Published npm versions and final stable/extended-stable tags remain
immutable. Routine release authority does not authorize destructive tag
rewrites; an exceptional operator request must name its exact scope. Mac-only
packaging recovery keeps the original tag and follows
[platform publication](platform-publication.md).

## Registry selectors

Promote through the restricted release-ops
`openclaw/releases/.github/workflows/openclaw-npm-dist-tags.yml` workflow.
Unlike package publication, npm selector management requires `NPM_TOKEN`.
Prefer repairing that workflow's token path. Point `latest` or `beta` only at
the operator-approved already-published version, then verify cache-bypassed
registry readback.

If the workflow is unavailable, use the approved `$one-password` / `$npm`
workflow in its persistent tmux session and private credential locators.
Authenticate as the intended npm owner and keep secrets/OTPs out of output.
Do not invent a credential retrieval or login procedure in this skill.

```bash
npm view openclaw dist-tags --json --prefer-online
npm view openclaw@latest version dist.tarball --json --prefer-online
```

An existing tag may still receive validation-only `preflight_only=true` to
verify packaging after publish; it does not authorize republishing.
