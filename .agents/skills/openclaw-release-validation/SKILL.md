---
name: openclaw-release-validation
description: Run a public OpenClaw beta validation campaign through OCM using either clean state or copied real state, an isolated candidate checkout, a shared per-release GitHub issue, and a guided subsystem mission checklist. Use for beta readiness, existing-user upgrade validation, clean onboarding validation, or broad manual subsystem testing.
---

# OpenClaw Release Validation

Run one lane: prepare a clean or copied-state fixture, upgrade it to one exact
beta, test the subsystem missions, publish one redacted ledger comment, vote,
and clean up.

## Mission control

At the start, use the agent's available checklist or plan tool to show these
seven phases. Keep exactly one phase in progress and check each off visibly:

1. Resolve candidate and shared campaign issue.
2. Choose fixture and, for copied state, choose the source gateway.
3. Prepare the isolated candidate runtime.
4. Create or import the fixture and upgrade it.
5. Complete the subsystem mission board.
6. Publish feedback and record the promotion vote.
7. Destroy run-owned resources and restore any source gateway stopped here.

The detailed mission source of truth is
`references/subsystem-checklist.json`. Print a local board at any time:

```sh
node --import tsx .agents/skills/openclaw-release-validation/scripts/release-validation.mts board --fixture copied
```

## 1. Candidate and campaign

Default to the newest published tag matching `vYYYY.M.D-beta.N`; an explicit
version overrides it. Get or create the shared issue using the stable marker:

```sh
node --import tsx .agents/skills/openclaw-release-validation/scripts/release-validation.mts campaign
node --import tsx .agents/skills/openclaw-release-validation/scripts/release-validation.mts campaign --version v2026.8.1-beta.3
```

Use one issue per beta release and one comment per tester run. Record the exact
candidate version and commit. A run against source must name the beta campaign
it is evaluating and record the source commit separately.

## 2. Fixture

Ask the tester to choose one:

- `clean`: new-user install and onboarding journey.
- `copied`: existing-user upgrade journey.

For `copied`, discover stopped and running OCM environments plus plain
`~/.openclaw`. Show each detected version and running state, then ask which
gateway to copy. Never silently choose the personal gateway.

Copy the selected `.openclaw` state into the run-owned artifact root before
importing it with `ocm adopt import`. The source remains untouched. If live
channel testing uses copied credentials, stop the source gateway first and
record that this run owns restoring it.

## 3. Candidate isolation

Published beta validation uses the exact package version through OCM. For a
source build, create a detached, run-owned checkout; install, check, and build
there; then create and verify an OCM package runtime with
`ocm runtime build-local`. Keep the active/shared checkout read-only.

Preview the fixture plan before executing it. Every env, runtime, checkout,
and artifact path uses the run id.

## 4. Upgrade

For clean state, create the env at the candidate version and complete
onboarding. For copied state, import the copied state and upgrade that env to
the exact candidate. Verify service status, `--version`, logs, and a real
gateway action; OCM `running` alone is not proof.

## 5. Subsystem missions

Load the complete checklist JSON. For each mission:

1. Show its fixture-specific steps, pass evidence, safety note, and docs.
2. Let the tester work through it; assist with commands and observation.
3. Record `pass`, `fail`, `blocked`, `skipped`, or `n/a` plus their note.
4. Count `fail` and `blocked` as completed coverage; require a useful note.
5. Update the visible checklist immediately.

For Channels on copied state, first prove the inherited channel while the
source is stopped. Then remove that channel's configuration from the copied
fixture, configure it again from scratch, and repeat the round trip. Never
remove channel configuration from the source gateway.

## 6. Feedback and vote

After each mission, retain concise notes and only the smallest relevant log
sample. Redact credentials, pairing codes, private endpoints, user identifiers,
and secret-bearing config. Keep successful rows quiet.

At the end, ask exactly: **Is this release polished enough to promote?** Record
`yes` or `no`; the skill does not make the release decision. Upsert one run
comment on the campaign issue containing candidate identity, fixture, source
gateway version/commit when applicable, every mission result, notes, and vote.

## 7. Cleanup

Destroy only envs, runtimes, checkouts, and artifacts owned by this run. If the
run stopped a source gateway, stop the copied fixture first and restore the
source. Confirm the source's prior running state and report any retained
resources explicitly.
