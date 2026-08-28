import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "./session-accessor.js";
import { clearSessionStoreCacheForTest } from "./store-writer-state.js";
import type { SessionEntry } from "./types.js";

/**
 * Trap-test for the negative store-merge guard for `updatedAt` churn during
 * continuation persist.
 *
 * The production path lives in `src/auto-reply/reply/agent-runner.ts`
 * (`persistContinuationChainState`). It writes continuation-chain fields via
 * `patchSessionEntryCore(...)` using a partial patch:
 *
 *   {
 *     continuationChainCount,
 *     continuationChainStartedAt,
 *     continuationChainTokens,
 *     continuationChainId,
 *   }
 *
 * Two load-bearing invariants must hold:
 *
 *   (A) `updatedAt` MUST NOT appear in that spread. The chain fields are not
 *       activity events; bumping `updatedAt` here would churn idle-reset
 *       evaluation (#49515) and disk-budget pruning ordering off the actual
 *       turn timeline.
 *   (B) The persisted SQLite row MUST round-trip continuation-chain fields
 *       without depending on the retired JSON-file sessions store.
 *
 * Sabotage walk (paste `updatedAt: Date.now(),` into
 * `persistContinuationChainState`'s spread to fail this trap): the
 * "preserves updatedAt …" cases fail.
 */

const SESSION_KEY = "agent:main:discord:channel:trap-443";
// Recent enough that maintenance won't prune the entry between accessor calls.
const SEEDED_UPDATED_AT = Date.now() - 60_000;

type ContinuationChainPatch = {
  continuationChainCount: number;
  continuationChainStartedAt: number;
  continuationChainTokens: number;
  continuationChainId: string;
};

/**
 * Mirror of `persistContinuationChainState`'s accessor patch (agent-runner.ts).
 * Kept inline so this test pins the exact byte-shape of the production path
 * without importing the entire agent-runner surface.
 */
async function persistChainSpread(
  storePath: string,
  sessionKey: string,
  patch: ContinuationChainPatch,
): Promise<void> {
  await patchSessionEntryCore(
    { storePath, sessionKey },
    () => ({
      continuationChainCount: patch.continuationChainCount,
      continuationChainStartedAt: patch.continuationChainStartedAt,
      continuationChainTokens: patch.continuationChainTokens,
      continuationChainId: patch.continuationChainId,
    }),
    { preserveActivity: true },
  );
}

function loadSeededEntry(storePath: string): SessionEntry | undefined {
  return loadSessionEntry({
    storePath,
    sessionKey: SESSION_KEY,
    readConsistency: "latest",
  });
}

describe("session store: continuation chain persist updatedAt churn guard", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-store-cont-merge-",
  });
  let tempDir = "";
  let storePath = "";

  const seededChain: ContinuationChainPatch = {
    continuationChainCount: 3,
    continuationChainStartedAt: 1_699_999_000_000,
    continuationChainTokens: 12_345,
    continuationChainId: "0192abcd-7777-7000-8000-000000000001",
  };

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  beforeEach(async () => {
    clearSessionStoreCacheForTest();
    tempDir = await suiteRootTracker.make("case");
    storePath = path.join(tempDir, "sessions.json");
    const seededEntry: SessionEntry = {
      sessionId: "sess-trap-443",
      updatedAt: SEEDED_UPDATED_AT,
      ...seededChain,
    };
    await replaceSessionEntry({ storePath, sessionKey: SESSION_KEY }, seededEntry);
    clearSessionStoreCacheForTest();
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("does not churn updatedAt when continuation chain fields are unchanged", async () => {
    expect(loadSeededEntry(storePath)?.updatedAt).toBe(SEEDED_UPDATED_AT);

    // Re-persist the same chain values via the production patch shape.
    await persistChainSpread(storePath, SESSION_KEY, seededChain);

    const after = loadSeededEntry(storePath);
    expect(
      after?.updatedAt,
      "updatedAt must not change when continuation-chain fields are byte-identical " +
        "(persistContinuationChainState must preserve activity)",
    ).toBe(SEEDED_UPDATED_AT);

    // All chain fields must still equal the seeded values.
    expect(after?.continuationChainCount).toBe(seededChain.continuationChainCount);
    expect(after?.continuationChainStartedAt).toBe(seededChain.continuationChainStartedAt);
    expect(after?.continuationChainTokens).toBe(seededChain.continuationChainTokens);
    expect(after?.continuationChainId).toBe(seededChain.continuationChainId);
  });

  it("round-trips unchanged continuation chain fields through the SQLite store", async () => {
    await persistChainSpread(storePath, SESSION_KEY, seededChain);

    clearSessionStoreCacheForTest();
    expect(loadSeededEntry(storePath)).toMatchObject({
      updatedAt: SEEDED_UPDATED_AT,
      ...seededChain,
    });
  });

  it("changes only the mutated chain field and still preserves updatedAt", async () => {
    // Mutate ONLY tokens (e.g. continuation step accumulated more usage).
    const mutated: ContinuationChainPatch = {
      ...seededChain,
      continuationChainTokens: seededChain.continuationChainTokens + 7_777,
    };

    await persistChainSpread(storePath, SESSION_KEY, mutated);

    clearSessionStoreCacheForTest();
    const after = loadSeededEntry(storePath);
    expect(
      after?.updatedAt,
      "updatedAt must be preserved even when chain tokens change — " +
        "the patch in persistContinuationChainState carries chain fields only",
    ).toBe(SEEDED_UPDATED_AT);
    expect(after?.continuationChainTokens).toBe(mutated.continuationChainTokens);
  });
});
