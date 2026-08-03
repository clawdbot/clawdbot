---
name: openclaw-testing
description: >-
  Must be used whenever an agent writes, adds, removes, refactors, reviews,
  chooses, runs, reruns, or debugs OpenClaw tests or evals; decides whether a
  change needs a test; selects test or product validation for a change; or
  chooses CI, package, Docker, E2E, live, or release proof. Forces the smallest
  set of tests that can detect the actual risk, prevents duplicate branch
  coverage, and requires installed-artifact proof when source tests cannot
  prove the product path. Do not use when the operator explicitly excludes test
  or validation work, including implementation-only, RCA-only, or review scopes
  that say not to add, run, select, or review tests.
---

# OpenClaw Testing

Use this skill before editing a test file or choosing a test command. The goal
is not more tests. The goal is the cheapest evidence that can fail for the
right reason.

## Load Only What The Task Needs

Always read the root and scoped `AGENTS.md` files for the paths in scope.

- For ordinary source or test work, use this skill and the scoped guides.
- Read `docs/reference/test.md` when command or harness details matter.
- Read the relevant part of `docs/ci.md` for CI, package acceptance, Docker,
  release, cross-platform, or live/E2E work.
- Use `$crabbox` only when this skill routes the proof to a remote backend.

Do not load all release and Docker documentation for a focused unit-test edit.

## Decide Whether A New Test Is Needed

Before writing a test, state:

1. The user-visible failure, security property, or owner contract at risk.
2. The production decision that controls it.
3. The closest existing test that already exercises that decision.
4. The one new failure the proposed test would detect.
5. The cheapest command that proves it.
6. The exact condition that would justify broader proof.

If item 4 cannot be named, do not add the test. Strengthen or reuse existing
coverage instead. A code change does not automatically require a new test.

It is correct to add no test when existing coverage already fails for the
regression, the change is behavior-neutral, and no new boundary is introduced.

## Put Each Test At The Cheapest Useful Level

| Risk                                                                       | Default proof                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Pure decision, parser, validator, or state transition                      | Unit test beside the owner                                                      |
| Mapping between two owned components                                       | Narrow integration test at that boundary                                        |
| Consumer of an already-tested decision                                     | One positive and one representative negative only when consumer wiring can fail |
| Security capability or authorization tuple                                 | Complete decision table at the owner, plus one fail-closed boundary test        |
| Concurrency, cleanup, retry, restart, or deduplication                     | One lifecycle test only when that behavior changed or is the reported failure   |
| Public API or plugin contract                                              | Owner contract test plus the smallest representative consumer                   |
| Build output, export map, lazy import, generated dist, or package contents | Build/package inspection and installed execution                                |
| Cross-platform behavior                                                    | Focused proof on the affected platform                                          |
| Live provider, channel, or external API behavior                           | A bounded real-path probe after deterministic checks                            |

Mocks can prove an owner's logic or a caller's wiring. They cannot prove that a
tarball contains a file, an export resolves after installation, a lazy chunk
loads, two separately packaged components interoperate, or a live service
accepts the request.

## Test Design Rules

### One Complete Decision Table At The Owner

Put exhaustive cases where the decision is implemented. Do not repeat the same
expired, missing, mismatch, revoked, or rejected table in every consumer.

A consumer normally needs:

- one successful wiring case; and
- at most one representative failure proving that invalid owner output is not
  widened, ignored, or restored.

Add another consumer failure only when it exercises different consumer code or
protects a separately named contract.

### Distinguish Policy Dimensions From Duplicate Inputs

Keep cases separate when account, actor, channel, thread, tenant, provider,
target kind, or permission scope are independent policy dimensions. Combine
cases when they only feed different values into the same comparison and have
the same externally observable result.

Do not use a parameterized table to make repeated cases look cheaper. Every row
must have a distinct reason to fail.

### Test Properties At Real Boundaries

Prefer one strong boundary property over many internal examples. Useful
properties include:

- concurrent requests cannot exchange authority or state;
- rejected input cannot reach the side-effect callback;
- a permission or secret cannot appear in model input, transcripts, logs, or
  stored records;
- restart ownership produces one terminal result;
- an installed core and plugin can execute the first lazy path together.

### Do Not Preserve Obsolete Internals

Tests protect current behavior, shipped migration boundaries, security
properties, and public contracts. Delete tests for removed fallback paths,
private implementation order, retired aliases, or impossible states.

### Keep Test Helpers Honest

Extract a helper only when two or more nearby tests share meaningful setup.
Keep the behavior and expected outcome visible at the call site. Do not hide
important authorization fields, failure reasons, or side effects inside a
generic fixture builder.

## Refactoring Existing Tests

For a test-only cleanup:

1. Run the directly affected files once to establish a green baseline.
2. Map each test or table row to the production decision and observable failure
   it protects.
3. Remove or combine cases that protect no unique decision or boundary.
4. Rerun only the changed file after each cleanup family.
5. Run all changed test files together once when the diff is frozen.
6. Run the relevant test TypeScript and targeted formatting/lint checks once.
7. Report cases and lines before and after, plus where removed coverage remains.

Do not run builds, package checks, live proof, or broad source suites for a
test-only refactor unless the test harness or generated/package surface itself
changed.

## Execution Ladder

### 1. Classify Source Trust

- Trusted source may run one or a few focused tests locally when dependencies
  are already ready.
- Untrusted contributor or fork source must not execute repository tooling
  locally. Follow the root `AGENTS.md` secretless CI or sanitized remote path.
- Do not reinstall or reconcile dependencies in a linked worktree merely to
  run proof locally.

### 2. Reproduce Narrowly

Run the smallest existing test that demonstrates the failure. If no existing
test can do so, add one at the owning decision or real boundary, then confirm
that it fails for the intended reason.

### 3. Rerun The Same Proof

After the fix, rerun the exact failing command. If it passes, do not immediately
replace it with a broad suite.

### 4. Prove The Changed Cluster Once

Run the changed test files and the smallest directly affected consumer tests.
Run relevant static checks once after the code and tests are frozen.

### 5. Escalate Only For A Named Risk

Broaden only when one of these is true:

- a shared harness, test config, package manifest, workspace config, or public
  contract changed;
- the changed-target resolver cannot identify a safe focused set;
- multiple independent consumers implement the affected contract;
- cross-platform, installed-package, restart, concurrency, or live behavior is
  the actual risk;
- this is a frozen release candidate and the release workflow requires the
  broader matrix.

Review activity, elapsed time, a packaging-only change, or a desire for extra
confidence is not by itself a reason to rerun an unchanged source suite.

## No Duplicate Green Reruns

Treat the tuple below as already proven:

```text
candidate diff + command + relevant environment + artifact identity
```

Do not rerun a green command when that tuple has not changed. A review does not
invalidate test evidence. An edit that cannot reach the packed artifact (for
example, test-only or docs-only) does not invalidate an unchanged package
artifact test; a production source edit that can reach it does. A
packaging-only edit does not invalidate unchanged source behavior tests.

Rerun when:

- relevant files changed;
- the command or test selection changed;
- the runtime, platform, configuration, installed package, or external state
  changed;
- the prior run was flaky, interrupted, stale, or did not test the claimed
  artifact.

## Source Proof And Product Proof Are Different

When a change affects package contents, export maps, build entries, generated
files, lazy imports, plugin/core boundaries, installation, or runtime loading,
the minimum product proof is:

1. Typecheck the project containing the changed scripts or build configuration.
2. Run the focused static package/release contract test.
3. Produce a clean build.
4. Inspect the packed artifact, not the source directory.
5. Install the exact artifact or artifact pair in a disposable environment.
6. Execute the first lazy or runtime path that imports the changed surface.

For an external or official plugin, prove both package shape and trust shape.
When core and plugin are packaged separately, install and execute the exact pair
together. A mocked resolver, synthetic source file, discovery listing, or
successful plugin registration is not enough when the failing code is loaded
later.

Do not rerun broad source tests after a packaging-only correction unless source
behavior also changed.

## Commands

In a Codex worktree with ready dependencies, use the direct harness:

```bash
node scripts/run-vitest.mjs <path-or-filter>
```

In a trusted normal checkout or the selected remote backend:

```bash
pnpm test:changed
pnpm test <path-or-filter> -- --reporter=verbose
pnpm changed:lanes --json
pnpm check:changed
```

Command meanings:

- `check:changed` selects formatting, typecheck, lint, and guard lanes. It does
  not run Vitest.
- `test:changed` selects cheap changed Vitest targets.
- `verify` runs the full check and test paths. Use it only when full proof is
  actually required.
- In a Codex worktree, use `node scripts/check-changed.mjs` for changed-check
  classification and remote delegation; do not run direct local `pnpm check*`.
- Never use raw `vitest`. If unavoidable, use `vitest run`; bare `vitest`
  starts watch mode.

Do not run independent Vitest commands concurrently in one worktree.

## Remote, CI, Docker, And Release Work

Heavy proof belongs on the backend selected by source trust. Acquire it only
when the first heavy command is ready, reuse the same lease for the unchanged
candidate, and stop it before handoff.

For exact CI jobs, release workflows, package-acceptance profiles, Docker lane
selection, failure artifacts, rerun commands, runner policy, and current timing
expectations, read the relevant section of `docs/ci.md`. That document is the
canonical operational reference; do not duplicate its changing command matrix
inside this skill.

Rerun the failed job or named lane first. Do not restart a full umbrella after
a focused fix unless the candidate identity or required release evidence is no
longer valid.

## Failure Workflow

1. Identify the exact candidate, command, test, job, lane, and artifact.
2. Decide whether the failure is product, test, environment, or infrastructure.
3. Reproduce the smallest actionable failure.
4. Fix the owning cause.
5. Rerun the same proof.
6. Broaden only for a named risk from the escalation list.

Do not change production code merely to satisfy a bad test. Do not change a
test merely to make a real production failure green.

## Review And Handoff

Before review, provide:

- the changed behavior and risk;
- tests added, changed, removed, or deliberately not added;
- the unique failure each retained case detects;
- exact commands, results, durations, candidate identity, and artifact identity;
- broader tests deliberately skipped and the condition that would require them;
- installed or live proof when source tests cannot support the claim.

Use the minimum independent review required by repository and operator policy.
Assign test value, duplicate coverage, missed boundaries, and proof
proportionality to one reviewer. If policy requires additional reviewers, give
each a distinct question instead of having several lanes reread the same tests
under different labels. If review changes the candidate, rerun only invalidated
proof and review the corrected diff.

## Common Mistakes

- Adding a rejection table to every consumer of an already-tested validator.
- Counting parameterized rows instead of asking what unique failure they catch.
- Running restart, retry, dedupe, or broad security suites when those paths did
  not change.
- Treating mocked resolvers or source files as proof of an installed package.
- Running core typechecks while missing the changed scripts or test project.
- Repeating green suites after reviews or small packaging edits.
- Using broad runs to compensate for not identifying the owning decision.
- Reporting thousands of passing tests without proving the user path that
  previously failed.
