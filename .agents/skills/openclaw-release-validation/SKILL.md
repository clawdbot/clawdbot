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
5. Choose the subsystem scope and complete only those missions.
6. Publish feedback and record the promotion vote.
7. Destroy run-owned resources and restore any source gateway stopped here.

The detailed mission source of truth is
`references/subsystem-checklist.json`. Print the compact test menu at any time:

```sh
node .agents/skills/openclaw-release-validation/scripts/release-validation.mts board --fixture copied
```

## 1. Candidate and campaign

Default to the newest published tag matching `vYYYY.M.D-beta.N`; an explicit
version overrides it. Get or create the shared issue using the stable marker:

```sh
node .agents/skills/openclaw-release-validation/scripts/release-validation.mts campaign
node .agents/skills/openclaw-release-validation/scripts/release-validation.mts campaign --version v2026.8.1-beta.3
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

Before preparing a copied fixture, read `references/copied-fixture.md`
completely. It owns the exact staging, path normalization, plugin preflight,
single-owner channel check, and readiness sequence. Keep a run-owned `run.json`
ledger of every stopped gateway and fixture-only change; do not rely on chat or
tool memory for cleanup after a restart.

## 3. Candidate isolation

Published beta validation installs and verifies the exact package runtime
through OCM, then starts or upgrades with `--runtime <exact-runtime>` so OCM
reuses those verified bytes. Do not use `--version` after the runtime is
installed: it may try to replace bytes shared by another env. For a source
build, create a detached, run-owned checkout; install, check, and build there;
then create and verify an OCM package runtime with
`ocm runtime build-local`. Keep the active/shared checkout read-only.

```sh
ocm runtime install --version <tag-without-v>
ocm runtime verify <tag-without-v>
```

Preview the fixture plan before executing it. Every env, runtime, checkout,
and artifact path uses the run id.

## 4. Upgrade

For clean state, create the env from the verified candidate runtime and complete
onboarding. For copied state, import the staged state and upgrade that env with
the verified exact runtime. Run copy, import, and upgrade as separate
long-running commands; wait for each authoritative receipt and read back OCM
state before continuing. Verify service status, `--version`, logs, HTTP health,
and `gateway probe --json`; OCM `running` alone is not proof.

## 5. Subsystem missions

Load the complete checklist JSON, but use progressive disclosure:

1. Show a compact overview of all available subsystem names with one short
   sentence describing what each tests. Do not show procedures yet.
2. Ask: **Which subsystems do you want to test in this run?** Prefer a
   multiselect UI when available; otherwise accept names, numbers, or `all`.
3. Echo the selected scope and let the tester adjust it before continuing.
4. Mark unchosen missions `not selected`, not `skipped`, and omit them from the
   active checklist. The tester may add another mission later.
5. Start no mission until the tester confirms the selection. In particular,
   never start Pairing merely because it is first in the manifest.

After selection, create the visible checklist from only the chosen missions.
Then handle one selected mission at a time:

1. Show its fixture-specific steps, pass evidence, safety note, and docs.
2. Let the tester work through it; assist with commands and observation.
3. Record `pass`, `fail`, `blocked`, `skipped`, or `n/a` plus their note.
4. Count `fail` and `blocked` as completed coverage; require a useful note.
5. Update the visible checklist immediately.

Reveal the next mission's detailed procedure only when the tester chooses or
reaches it. Keep the compact overview available without dumping every mission's
instructions into the conversation.

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
