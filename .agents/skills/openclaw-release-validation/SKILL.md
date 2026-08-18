---
name: openclaw-release-validation
description: Guide a maintainer through a selectable OpenClaw beta validation campaign using OCM and a shared GitHub issue.
user-invocable: true
disable-model-invocation: true
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
6. On exit, collect feedback and the promotion vote, stop the fixture, and
   publish the run comment.
7. Restore the source when safe and destroy run-owned resources. Keep all
   operational cleanup evidence private in `run.json`.

Tell the tester near the beginning, exactly: **Reply exactly `finish
validation` to end the run.** This is the run's control phrase at any point,
including before a mission finishes.

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
`~/.openclaw`. Show each detected version, actual process/listener state,
desired service state, and health, then ask which gateway to copy. Never
silently choose the personal gateway. Re-read those facts immediately before
the first source-affecting action. If a desired-running source is already
unhealthy, disclose that baseline and promise restoration only to its safe
prior desired state, not to health the run did not inherit.

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
6. Say exactly: **Reply exactly `finish validation` to end the run.**

Reveal the next mission's detailed procedure only when the tester chooses or
reaches it. Keep the compact overview available without dumping every mission's
instructions into the conversation.

For Channels on copied state, first prove the inherited channel while the
source is stopped. Then remove that channel's configuration from the copied
fixture, configure it again from scratch, and repeat the round trip. Never
remove channel configuration from the source gateway.

## 6. Exit, feedback, and first publication

After each mission, retain concise notes and only the smallest relevant log
sample. Redact credentials, pairing codes, private endpoints, user identifiers,
secret-bearing config, and local paths. Keep successful rows quiet.

Keep two categories separate in `run.json`:

- `releaseIssues`: OpenClaw candidate problems observed as a direct result of
  the upgrade. These may be published.
- `operationalFindings`: OCM, setup, fixture, restoration, cleanup, and local
  tooling problems. These are private and must never appear in the GitHub
  comment.

Do not infer release feedback from operational failures. Publish only candidate
identity, the upgrade source version/commit (never its name or path), the list
of tested subsystem results, `releaseIssues`, feedback explicitly supplied by
the tester, and the yes/no vote. Never publish any local path, gateway name,
setup detail, cleanup state, restoration state, or retained artifact.

When the tester submits exactly `finish validation`, stop mission work. In one
prompt, ask for any final feedback and ask exactly: **Is this release polished
enough to promote?** Require a `yes` or `no`; the skill does not make the
release decision.

After recording both answers in `run.json`:

1. Stop the validation fixture and confirm its listener is gone.
2. Upsert the single marker-based, redacted run comment immediately, before
   source restoration or destructive cleanup. The comment is a release-feedback
   report only; operational details remain in the private ledger.

```sh
node .agents/skills/openclaw-release-validation/scripts/release-validation.mts comment \
  --run <run-root>/run.json
```

Comment publication is independent of restoration and cleanup: a blocker in
either must never delay or suppress the campaign record.

## 7. Restore and cleanup

With the fixture stopped, restore a source only when the exact recorded source,
lifecycle owner, and prior desired state still match. Destroy run-owned envs,
runtimes, and checkouts independently of whether source restoration succeeds.
Do not destroy the ledger or backup until restoration is confirmed.

If restoration is blocked, leave the source safely stopped; retain the ledger,
backup, and any recovery receipt; and record the blocker plus one exact next
action. Do not ask the tester to invent or select an unavailable runtime merely
to finish cleanup.

Finally, update cleanup state in private `run.json`. Report the source
disposition and exact retained artifact paths only to the tester in the local
session. Do not republish the comment because cleanup is not release feedback.
