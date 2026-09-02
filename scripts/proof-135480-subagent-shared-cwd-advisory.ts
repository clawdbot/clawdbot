/**
 * Real-behavior proof for the subagent shared-working-directory advisory
 * (PR #135480).
 *
 * What is REAL here (no vitest, no mocks of the seam under test):
 *   - `resolveExplicitSpawnedCwd()` — the one explicit-cwd contract both the
 *     native and the ACP spawn owner now persist through.
 *   - `upsertSessionEntryCore()` — the exact session writer `acp-spawn.ts`
 *     calls, invoked with the exact creation patch the ACP owner now builds,
 *     against a real on-disk session store in a temp OPENCLAW_HOME.
 *   - `buildSubagentList()` — the changed production owner.
 *   - `handleSubagentsListAction()` — the real `/subagents` text renderer that
 *     consumes it.
 *   - Real directories, a real symlink, and a real deleted directory on disk;
 *     canonicalization runs against the actual filesystem.
 *
 * What is NOT executed: the ACP dispatch itself. `spawnAcpDirect()` launches an
 * external ACP agent through a live Gateway, which this offline script cannot
 * stand up. The ACP owner's own patch assembly is pinned instead by
 * `src/agents/subagents/spawn/acp-spawn.test.ts` ("persists an explicit ACP cwd
 * so working-directory readers see it like a native child"); what this script
 * proves is that an ACP-shaped child session written through the production
 * writer is grouped and reported by the production readers, and that the same
 * child WITHOUT the persisted field — i.e. current `main` — is not.
 *
 * Scenarios:
 *   1. Pre-fix control: two ACP children in one directory, no `spawnedCwd`
 *      persisted (current `main`) — no advisory. This is the reported bug.
 *   2. Post-fix: the same two ACP children with the field persisted — both
 *      flagged as peers, in the tool JSON and in the `/subagents` text.
 *   3. Cross-runtime: one native child and one ACP child in one directory —
 *      each names the other.
 *   4. Symlink alias: two children reach one checkout by different paths —
 *      grouped, and the canonical directory is reported.
 *   5. Inherited workspace (no explicit cwd) — silent.
 *   6. Distinct directories — silent.
 *   7. Deleted directory — canonicalization fails, lexical fallback still
 *      groups rather than throwing or dropping the row.
 *   8. Model-context bound at the supported child maximum: 20 live children in
 *      one long-pathed directory. Measures the real model-visible payload the
 *      `subagents` tool emits for `action: "list"` and asserts the advisory's
 *      per-row contribution is capped — the P0 regression. Also re-measures at
 *      50 (the swarm `maxChildrenPerGroup` default) to show the growth is
 *      linear rather than quadratic, and pins that a long path is still grouped
 *      on its full value while only its display form is truncated.
 *
 * Run: pnpm tsx scripts/proof-135480-subagent-shared-cwd-advisory.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type SpawnedContextModule = typeof import("../src/agents/spawned-context.js");
type SessionAccessorModule = typeof import("../src/config/sessions/session-accessor.js");
type SubagentListModule = typeof import("../src/agents/subagents/registry/subagent-list.js");
type SubagentsCommandModule =
  typeof import("../src/auto-reply/reply/commands-subagents/action-list.js");
type SubagentRunRecord =
  import("../src/agents/subagents/registry/subagent-registry.types.js").SubagentRunRecord;
type OpenClawConfig = import("../src/config/types.openclaw.js").OpenClawConfig;

let failures = 0;

function check(label: string, run: () => void): void {
  try {
    run();
    console.log(`   ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`   ✗ ${label}`);
    console.log(`     ${error instanceof Error ? error.message : String(error)}`);
  }
}

function makeRun(suffix: string, now: number, options?: { ended?: boolean }): SubagentRunRecord {
  return {
    runId: `run-${suffix}`,
    childSessionKey: `agent:main:subagent:${suffix}`,
    controllerSessionKey: "agent:main:main",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: `work inside ${suffix}`,
    cleanup: "keep",
    createdAt: now - 120_000,
    execution: options?.ended
      ? {
          status: "terminal",
          startedAt: now - 120_000,
          endedAt: now - 60_000,
          outcome: { status: "ok" },
        }
      : { status: "running", startedAt: now - 120_000 },
  } as SubagentRunRecord;
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-135480-"));
  process.env.OPENCLAW_HOME = path.join(root, "home");
  await fs.mkdir(process.env.OPENCLAW_HOME, { recursive: true });

  const { resolveExplicitSpawnedCwd } =
    (await import("../src/agents/spawned-context.js")) as SpawnedContextModule;
  const { upsertSessionEntryCore } =
    (await import("../src/config/sessions/session-accessor.js")) as SessionAccessorModule;
  const { buildSubagentList } =
    (await import("../src/agents/subagents/registry/subagent-list.js")) as SubagentListModule;
  const { handleSubagentsListAction } =
    (await import("../src/auto-reply/reply/commands-subagents/action-list.js")) as SubagentsCommandModule;

  /**
   * Writes a child session entry through the production writer using the exact
   * creation patch `acp-spawn.ts` now builds for an ACP child (or the native
   * equivalent — both owners resolve `spawnedCwd` through the same contract).
   */
  const createChildSession = async (params: {
    storePath: string;
    sessionKey: string;
    requestedCwd?: string;
    /** Set false to reproduce current `main`, which persists nothing for ACP. */
    persistCwd?: boolean;
  }) => {
    const spawnedCwd = resolveExplicitSpawnedCwd(params.requestedCwd);
    await upsertSessionEntryCore({ storePath: params.storePath, sessionKey: params.sessionKey }, {
      spawnedBy: "agent:main:main",
      completionOwnerSessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      ...(spawnedCwd && params.persistCwd !== false ? { spawnedCwd } : {}),
      inheritedToolPolicyVersion: 1,
    } as never);
    return spawnedCwd;
  };

  const listFor = (storePath: string, runs: SubagentRunRecord[]) => {
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const list = buildSubagentList({ cfg, runs, recentMinutes: 30 });
    // The `/subagents` command surface, driven for real off the same build.
    const text = handleSubagentsListAction({
      params: { cfg },
      runs,
    } as never);
    return { list, text };
  };

  const advisoryFor = (list: ReturnType<SubagentListModule["buildSubagentList"]>, runId: string) =>
    list.active.find((item) => item.runId === runId)?.sharedCwd;

  const now = Date.now();

  console.log("── scenario 1: PRE-FIX CONTROL — ACP children with no persisted cwd ──");
  {
    const store = path.join(root, "sessions-acp-prefix.json");
    const dir = path.join(root, "acp-shared");
    await fs.mkdir(dir, { recursive: true });
    const runs = [makeRun("acp-prefix-a", now), makeRun("acp-prefix-b", now)];
    for (const run of runs) {
      await createChildSession({
        storePath: store,
        sessionKey: run.childSessionKey,
        requestedCwd: dir,
        persistCwd: false,
      });
    }
    const { list } = listFor(store, runs);
    console.log(`   two live ACP children in ${dir}, field not persisted`);
    check("no advisory — this is the false negative the PR fixes", () => {
      assert.equal(list.active.length, 2);
      for (const run of runs) {
        assert.equal(advisoryFor(list, run.runId), undefined);
      }
    });
  }

  console.log("── scenario 2: POST-FIX — the same ACP children, cwd persisted ──");
  {
    const store = path.join(root, "sessions-acp-postfix.json");
    const dir = path.join(root, "acp-shared-post");
    await fs.mkdir(dir, { recursive: true });
    const runs = [makeRun("acp-post-a", now), makeRun("acp-post-b", now)];
    for (const run of runs) {
      await createChildSession({
        storePath: store,
        sessionKey: run.childSessionKey,
        requestedCwd: dir,
      });
    }
    const { list, text } = listFor(store, runs);
    const first = advisoryFor(list, runs[0]!.runId);
    console.log(`   run ${runs[0]!.runId} advisory: ${JSON.stringify(first)}`);
    check("both ACP rows are flagged and name each other", () => {
      assert.deepEqual(advisoryFor(list, runs[0]!.runId), {
        path: dir,
        peerCount: 1,
        peerRunIds: [runs[1]!.runId],
      });
      assert.deepEqual(advisoryFor(list, runs[1]!.runId), {
        path: dir,
        peerCount: 1,
        peerRunIds: [runs[0]!.runId],
      });
    });
    check("the /subagents text surface carries the suffix", () => {
      const rendered = JSON.stringify(text);
      assert.ok(
        rendered.includes(`[shared cwd with 1 other run: ${dir}]`),
        `command text did not carry the advisory: ${rendered.slice(0, 400)}`,
      );
    });
  }

  console.log("── scenario 3: cross-runtime — one native child, one ACP child ──");
  {
    const store = path.join(root, "sessions-cross-runtime.json");
    const dir = path.join(root, "cross-runtime-shared");
    await fs.mkdir(dir, { recursive: true });
    const nativeRun = makeRun("native-child", now);
    const acpRun = makeRun("acp-child", now);
    for (const run of [nativeRun, acpRun]) {
      await createChildSession({
        storePath: store,
        sessionKey: run.childSessionKey,
        requestedCwd: dir,
      });
    }
    const { list } = listFor(store, [nativeRun, acpRun]);
    check("the native row names the ACP run and vice versa", () => {
      assert.deepEqual(advisoryFor(list, nativeRun.runId)?.peerRunIds, [acpRun.runId]);
      assert.deepEqual(advisoryFor(list, acpRun.runId)?.peerRunIds, [nativeRun.runId]);
    });
  }

  console.log("── scenario 4: symlink alias to one real checkout ──");
  {
    const store = path.join(root, "sessions-alias.json");
    const realDir = path.join(root, "alias-real");
    const linkDir = path.join(root, "alias-link");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, linkDir, "dir");
    const canonical = await fs.realpath(realDir);
    const realRun = makeRun("alias-real-run", now);
    const linkRun = makeRun("alias-link-run", now);
    await createChildSession({
      storePath: store,
      sessionKey: realRun.childSessionKey,
      requestedCwd: realDir,
    });
    await createChildSession({
      storePath: store,
      sessionKey: linkRun.childSessionKey,
      requestedCwd: linkDir,
    });
    const { list } = listFor(store, [realRun, linkRun]);
    console.log(`   ${linkDir} -> ${canonical}`);
    console.log(`   alias row advisory: ${JSON.stringify(advisoryFor(list, linkRun.runId))}`);
    check("aliased runs group together and report the canonical directory", () => {
      assert.deepEqual(advisoryFor(list, realRun.runId), {
        path: canonical,
        peerCount: 1,
        peerRunIds: [linkRun.runId],
      });
      assert.deepEqual(advisoryFor(list, linkRun.runId), {
        path: canonical,
        peerCount: 1,
        peerRunIds: [realRun.runId],
      });
    });
  }

  console.log("── scenario 5: inherited workspace stays silent ──");
  {
    const store = path.join(root, "sessions-inherited.json");
    const runs = [makeRun("inherited-a", now), makeRun("inherited-b", now)];
    for (const run of runs) {
      await createChildSession({ storePath: store, sessionKey: run.childSessionKey });
    }
    const { list } = listFor(store, runs);
    check("no advisory for children that named no directory", () => {
      assert.equal(list.active.length, 2);
      for (const run of runs) {
        assert.equal(advisoryFor(list, run.runId), undefined);
      }
    });
  }

  console.log("── scenario 6: distinct directories stay silent ──");
  {
    const store = path.join(root, "sessions-distinct.json");
    const runA = makeRun("distinct-a", now);
    const runB = makeRun("distinct-b", now);
    const dirA = path.join(root, "distinct-a-dir");
    const dirB = path.join(root, "distinct-b-dir");
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await createChildSession({
      storePath: store,
      sessionKey: runA.childSessionKey,
      requestedCwd: dirA,
    });
    await createChildSession({
      storePath: store,
      sessionKey: runB.childSessionKey,
      requestedCwd: dirB,
    });
    const { list } = listFor(store, [runA, runB]);
    check("two different checkouts are not reported as a collision", () => {
      assert.equal(advisoryFor(list, runA.runId), undefined);
      assert.equal(advisoryFor(list, runB.runId), undefined);
    });
  }

  console.log("── scenario 7: deleted directory falls back to lexical grouping ──");
  {
    const store = path.join(root, "sessions-deleted.json");
    const dir = path.join(root, "deleted-tree");
    await fs.mkdir(dir, { recursive: true });
    const runs = [makeRun("deleted-a", now), makeRun("deleted-b", now)];
    for (const run of runs) {
      await createChildSession({
        storePath: store,
        sessionKey: run.childSessionKey,
        requestedCwd: dir,
      });
    }
    await fs.rm(dir, { recursive: true, force: true });
    const { list } = listFor(store, runs);
    console.log(`   ${dir} removed after spawn; advisory still resolves`);
    check("grouping survives an unresolvable directory without throwing", () => {
      for (const run of runs) {
        assert.equal(advisoryFor(list, run.runId)?.path, dir);
        assert.equal(advisoryFor(list, run.runId)?.peerRunIds.length, 1);
      }
    });
  }

  console.log("── scenario 8: model-context bound at the supported child maximum ──");
  {
    // The advisory attaches to every row of `subagents list` AND to the rendered
    // text view, so naming every peer made one ordinary call grow as O(runs^2).
    // This scenario drives the real tool payload shape and measures it.
    const SAMPLE_MAX = 3;
    const PATH_MAX = 72;
    // A realistically long checkout path, as the finding calls out.
    const deepDir = path.join(
      root,
      "home/operator/projects/worktrees/openclaw-feat-subagent-shared-cwd-advisory/packages/agent-core",
    );
    await fs.mkdir(deepDir, { recursive: true });
    assert.ok(deepDir.length > PATH_MAX, "scenario needs a path longer than the display cap");

    const measure = async (childCount: number) => {
      const store = path.join(root, `sessions-bound-${childCount}.json`);
      const runs = Array.from({ length: childCount }, (_unused, i) =>
        makeRun(`bound-${childCount}-${String(i).padStart(2, "0")}`, now),
      );
      for (const run of runs) {
        await createChildSession({
          storePath: store,
          sessionKey: run.childSessionKey,
          requestedCwd: deepDir,
        });
      }
      const { list } = listFor(store, runs);
      // Exactly what subagents-tool.ts emits for `action: "list"`: structured
      // rows with `line` stripped, plus the rendered text view.
      const modelVisible = JSON.stringify({
        active: list.active.map(({ line: _line, ...view }) => view),
        recent: list.recent.map(({ line: _line, ...view }) => view),
        text: list.text,
      });
      const emittedPeerIds = list.active.reduce(
        (sum, item) => sum + (item.sharedCwd?.peerRunIds.length ?? 0),
        0,
      );
      return { list, runs, modelVisible, emittedPeerIds };
    };

    const at20 = await measure(20);
    const at50 = await measure(50);
    for (const [childCount, m] of [
      [20, at20],
      [50, at50],
    ] as const) {
      console.log(
        `   ${String(childCount).padStart(2)} children sharing one cwd: ${m.modelVisible.length} B model-visible, ${m.emittedPeerIds} peer ids emitted (pre-fix would be ${childCount * (childCount - 1)})`,
      );
    }

    check("every row reports the exact peer count, not the sample size", () => {
      for (const item of at20.list.active) {
        assert.equal(item.sharedCwd?.peerCount, 19);
      }
    });
    check(`no row emits more than ${SAMPLE_MAX} peer ids`, () => {
      for (const item of at20.list.active) {
        const ids = item.sharedCwd?.peerRunIds ?? [];
        assert.ok(ids.length <= SAMPLE_MAX, `row emitted ${ids.length} peer ids`);
        assert.ok(!ids.includes(item.runId), "a row listed itself as its own peer");
      }
    });
    check("total peer ids grow linearly, not quadratically", () => {
      // min(SAMPLE_MAX, n-1) * n, versus n*(n-1) before the fix.
      assert.equal(at20.emittedPeerIds, 60);
      assert.equal(at50.emittedPeerIds, 150);
    });
    check(`the reported directory is capped at ${PATH_MAX} characters`, () => {
      for (const item of at20.list.active) {
        const reported = item.sharedCwd?.path ?? "";
        assert.ok(
          reported.length <= PATH_MAX,
          `reported path was ${reported.length} characters: ${reported}`,
        );
        assert.ok(reported.startsWith("..."), `expected a truncation marker: ${reported}`);
        // The tail is what identifies the checkout, so it must survive.
        assert.ok(reported.endsWith("packages/agent-core"), `lost the path tail: ${reported}`);
      }
      // The untruncated path must not leak into the payload anywhere.
      assert.ok(
        !at20.modelVisible.includes(deepDir),
        "the full path reached the model-visible payload",
      );
    });
    check("the text view reports the true group size", () => {
      assert.ok(
        at20.list.text.includes("[shared cwd with 19 other runs: "),
        "the text view did not report the real peer count",
      );
      assert.ok(
        !at20.list.text.includes(`[shared cwd with ${SAMPLE_MAX} other runs`),
        "the text view reported the sample size instead of the real count",
      );
    });
    // Sibling checkouts identical for their first 100+ characters, differing
    // only past the display cap: grouping must still keep them apart.
    const alphaDir = path.join(deepDir, "openclaw-worktree-alpha");
    const betaDir = path.join(deepDir, "openclaw-worktree-beta");
    await fs.mkdir(alphaDir, { recursive: true });
    await fs.mkdir(betaDir, { recursive: true });
    const siblingStore = path.join(root, "sessions-bound-siblings.json");
    const alphaRuns = ["sib-alpha-a", "sib-alpha-b"].map((suffix) => makeRun(suffix, now));
    const betaRuns = ["sib-beta-a", "sib-beta-b"].map((suffix) => makeRun(suffix, now));
    for (const [runs, dir] of [
      [alphaRuns, alphaDir],
      [betaRuns, betaDir],
    ] as const) {
      for (const run of runs) {
        await createChildSession({
          storePath: siblingStore,
          sessionKey: run.childSessionKey,
          requestedCwd: dir,
        });
      }
    }
    const siblingList = listFor(siblingStore, [...alphaRuns, ...betaRuns]).list;
    const alphaAdvisory = advisoryFor(siblingList, alphaRuns[0]!.runId);
    const betaAdvisory = advisoryFor(siblingList, betaRuns[0]!.runId);
    console.log(`   sibling alpha reports: ${alphaAdvisory?.path}`);
    console.log(`   sibling beta  reports: ${betaAdvisory?.path}`);
    check("sibling checkouts past the display cap remain distinct groups", () => {
      assert.equal(alphaAdvisory?.peerCount, 1);
      assert.equal(betaAdvisory?.peerCount, 1);
      assert.deepEqual(alphaAdvisory?.peerRunIds, [alphaRuns[1]!.runId]);
      assert.deepEqual(betaAdvisory?.peerRunIds, [betaRuns[1]!.runId]);
      assert.notEqual(
        alphaAdvisory?.path,
        betaAdvisory?.path,
        "the display cap collapsed two distinct directories into one label",
      );
    });
  }

  await fs.rm(root, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\n${failures} runtime assertion(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll runtime assertions passed.");
  process.exit(0);
}

await main();
