# NAC-78 Failed Gate Closure and Receipt-Boundary Redesign Plan

> **For Hermes:** Execute the archival/reset section exactly once, then run the design investigation without production implementation. Any later implementation requires approval of the design decision and a fresh TDD plan.

**Goal:** Preserve both failed NAC-78 candidate states, restore a clean active repair branch, and produce an approved design for lifecycle-linked Telegram delivery evidence before writing more production code.

**Architecture:** Treat lifecycle bookkeeping and Telegram transport settlement as separate authorities joined by one versioned receipt contract. Normal successful sends may complete only after synchronous durable settlement and canonical lifecycle linkage. A send whose platform outcome cannot be proven remains `delivery_uncertain`; it is never automatically resent without authoritative absence proof.

**Tech Stack:** Git plumbing/branches, Windows PowerShell 5.1, OpenClaw message and lifecycle paths, Linear NAC-78, JSON receipt/state schemas.

---

## Current state

- Active branch: `repair/nacho-stability-root-causes`
- Clean base: `7abacc64742feaa100e021732f2896aff6da6feb`
- Rejected independently reviewed staged tree: `bddc341a9d4aea27342100476c88b6a5e0281d7b`
- Current worktree: newer partial correction over the rejected index; two broad tests remain RED.
- RED gates:
  - `test-ordered-run-controller.ps1`: `FAIL exactly one final accepted notification`
  - `test-workboard-agent-loop-adapter.ps1`: `FAIL receipt-backed notify must target exact card and replay idempotently`
- No live `.openclaw`, Gateway, Telegram, Workboard, Linear, schedule, provider, or routing mutation was made.
- Containment must remain active.

## Decision

Execute all three requested outcomes in a non-conflicting order:

1. Preserve the rejected staged snapshot and partial correction snapshot on separate `archive/` branches.
2. Reset the active repair branch to the clean base and remove only the isolated `local-repair/` residue.
3. Conduct a fresh design-only lifecycle/receipt investigation from clean state.

Neither archive branch is deployable. Both branch descriptions/commit messages must say `DO NOT APPLY` and record the RED/review status.

---

### Task 1: Archive the independently reviewed rejected snapshot

**Objective:** Give the staged tree `bddc341...` a durable Git reference without altering its contents.

**Files:** None.

**Step 1: Verify scope**

Run:

```bash
git status --porcelain
```

Expected: every changed path is under `local-repair/`.

**Step 2: Create a commit directly from the reviewed tree**

Run:

```bash
REJECTED_COMMIT=$(printf '%s\n' \
  'archive: rejected NAC-78 reviewed candidate (DO NOT APPLY)' \
  '' \
  'Independent review failed. Tree bddc341a9d4aea27342100476c88b6a5e0281d7b.' \
  'Blocking findings: forged Workboard receipt acceptance, historical same-text reconciliation, fire-and-forget journal authority, missing canonical lifecycle linkage, unsafe activation/rollback claims.' \
  'No live application occurred.' \
  | git commit-tree bddc341a9d4aea27342100476c88b6a5e0281d7b -p 7abacc64742feaa100e021732f2896aff6da6feb)
git branch archive/nac-78-rejected-review-20260807 "$REJECTED_COMMIT"
```

**Step 3: Verify**

Run:

```bash
git show --no-patch --format=fuller archive/nac-78-rejected-review-20260807
git rev-parse 'archive/nac-78-rejected-review-20260807^{tree}'
```

Expected tree: `bddc341a9d4aea27342100476c88b6a5e0281d7b`.

---

### Task 2: Archive the newer partial RED correction

**Objective:** Preserve the current worktree separately from the rejected reviewed snapshot.

**Files:** Current `local-repair/` worktree only.

**Step 1: Stage the current isolated state**

Run:

```bash
git add -A -- local-repair
git diff --cached --check
PARTIAL_TREE=$(git write-tree)
```

Expected: clean diff check; plugin deletion and newer PowerShell corrections are represented in `PARTIAL_TREE`.

**Step 2: Create an explicit non-deployable archive commit**

Run:

```bash
PARTIAL_COMMIT=$(printf '%s\n' \
  'archive: partial NAC-78 correction after failed gate (DO NOT APPLY)' \
  '' \
  'Second bounded correction cycle remained RED.' \
  'Failing tests: test-ordered-run-controller.ps1 and test-workboard-agent-loop-adapter.ps1.' \
  'Controller/lifecycle/receipt schemas remain inconsistent; README and manifest are stale.' \
  'No live application occurred.' \
  | git commit-tree "$PARTIAL_TREE" -p 7abacc64742feaa100e021732f2896aff6da6feb)
git branch archive/nac-78-partial-red-20260807 "$PARTIAL_COMMIT"
```

**Step 3: Verify both archives differ and are reachable**

Run:

```bash
git rev-parse 'archive/nac-78-rejected-review-20260807^{tree}'
git rev-parse 'archive/nac-78-partial-red-20260807^{tree}'
git show --stat --oneline archive/nac-78-partial-red-20260807
```

Expected: two reachable archive branches with distinct trees and explicit `DO NOT APPLY` messages.

---

### Task 3: Restore the active branch to clean base

**Objective:** Remove the failed candidate from the active repair branch while retaining both archive branches.

**Files removed from active branch:** `local-repair/` only.

**Step 1: Confirm branch and base**

Run:

```bash
test "$(git branch --show-current)" = 'repair/nacho-stability-root-causes'
test "$(git rev-parse HEAD)" = '7abacc64742feaa100e021732f2896aff6da6feb'
```

**Step 2: Reset index/worktree and remove isolated residue**

Run:

```bash
git reset --hard 7abacc64742feaa100e021732f2896aff6da6feb
git clean -fdx -- local-repair
```

Do not run a repository-wide clean.

**Step 3: Verify**

Run:

```bash
git status --short --branch
git branch --list 'archive/nac-78-*'
test ! -e local-repair
```

Expected: clean active branch; both archive branches present; `local-repair/` absent.

---

### Task 4: Establish the redesign evidence map

**Objective:** Identify the real authority boundaries before proposing code.

**Read-only surfaces:**

- OpenClaw message CLI entry point and JSON result contract
- Telegram outbound provider call and returned `messageId`
- `message_sent` hook dispatch/await semantics
- Existing lifecycle record and active-followup writers/readers
- Workboard adapter commands and durable mutation limits
- Current tests for interrupted send, duplicate dispatch, and recovery

**Step 1: Map each fact to one owner**

Produce a table with:

- Fact: delivery intent, provider acceptance, message ID, receipt settlement, lifecycle linkage, visible closeout, Workboard completion
- Owning boundary
- Durable store
- Writer
- Readers
- Crash windows
- Replay semantics

**Step 2: Prove current impossibility boundary**

Document the exact interval between platform acceptance and durable local settlement. Determine whether current OpenClaw exposes either:

- Provider-supported idempotency, or
- Authoritative outbound readback/absence proof, or
- An awaited settlement callback at the owning send boundary

If none exists, record that automatic resend after this gap cannot simultaneously guarantee recovery and zero duplicates.

**Step 3: Existing-solutions preflight**

Check maintained OpenClaw plugin/core APIs and free/OSS durable-outbox patterns before custom design. Do not propose a paid service or Gateway restart.

---

### Task 5: Define the single receipt contract and state machine

**Objective:** Eliminate schema drift before implementation.

**Required receipt identity:**

- `schemaVersion`
- `authority`
- `jobId`
- `workboardTaskId`
- `idempotencyKey`
- `transport`
- canonical `receiptTarget`
- `accountId`
- `sourceSessionKey`
- `payloadSha256`
- `intentAt`
- `messageId`
- `receiptId`
- `sentAt`

**State sequence:**

1. Canonical lifecycle intent persisted.
2. Transport attempt begins once for the exact intent.
3. Successful provider response is synchronously settled to durable receipt storage.
4. Receipt is linked idempotently to lifecycle and active-followup records.
5. Workboard finalization reads canonical evidence; it never trusts caller-only JSON.
6. Lifecycle may become completed only after all prior steps verify.

**Uncertain outcome rule:**

- Missing exact durable receipt => `delivery_uncertain`.
- No automatic resend unless an authoritative absence proof exists.
- Without absence proof, exact next action is manual Telegram verification/reconciliation.
- A confirmed receipt is immutable and cannot be replaced.

---

### Task 6: Revise NAC-78 acceptance before implementation

**Objective:** Make requirements technically consistent and reviewable.

**Linear update:** Add a status comment; do not silently rewrite history.

Include:

- Independent review rejected the isolated candidate.
- Two bounded correction cycles failed broad gates.
- No live changes occurred.
- Normal-success receipt linkage remains required.
- Ambiguous send/persist gaps stay `delivery_uncertain` and require manual reconciliation unless authoritative absence proof exists.
- Automatic retry and zero-duplicate guarantees apply only where the transport boundary supplies idempotency or authoritative absence proof.
- Human verification must cover one successful receipt-linked closeout and one ambiguous/failed handoff that remains blocked without duplicate send.

Keep NAC-78 `In Progress` until the revised acceptance text is approved.

---

### Task 7: Produce a fresh implementation plan only after design approval

**Objective:** Prevent reuse of the inconsistent failed candidate.

**Rules:**

- Start from clean base, not either archive branch.
- Do not copy production code from the failed candidate wholesale.
- Reuse tests only after validating their contract against the approved receipt schema.
- Use TDD for canonical intent, synchronous settlement, lifecycle linkage, Workboard gating, uncertain recovery, and adversarial receipts.
- Maximum two correction cycles before returning to design.
- No Gateway restart, plugin activation, fallback-search activation, push, merge, deployment, or external canary until separately authorized.

**Required verification:**

- Every focused PowerShell 5.1 test RED then GREEN
- All broad Agent Loop suites green
- Parser and formatter checks
- Security scan
- Independent spec review
- Independent code-quality review
- Immutable reviewed Git tree before any application proposal

---

## Risks and tradeoffs

- **Exactly-once illusion:** A local idempotency key does not prevent duplicate Telegram sends unless the transport honors it or absence can be proven.
- **Manual recovery:** Keeping ambiguous sends blocked is less convenient but safer than duplicate closeouts.
- **Schema expansion:** Adding identity fields everywhere increases migration burden; one versioned schema and one validator must own it.
- **Archive misuse:** Archive branch names and commit messages must remain explicitly non-deployable.
- **Scope creep:** Do not reintroduce plugins, Gateway restart, provider changes, or fallback-search activation into NAC-78.

## Open design questions

1. Can the existing OpenClaw send boundary synchronously invoke a durable settlement writer before the CLI returns?
2. Is there any authoritative Telegram outbound readback or absence-proof mechanism available to the current account/runtime?
3. Which component owns canonical receipt validation and serialization?
4. How should existing `visibleCloseoutSent=true` records without evidence be represented during migration?
5. Should the ambiguous recovery case require Kevin confirmation, a directly inspected Telegram message ID, or both?
