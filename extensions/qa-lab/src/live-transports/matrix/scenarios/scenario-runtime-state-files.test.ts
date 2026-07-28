// Qa Matrix tests cover persisted runtime state probes.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { waitForMatrixInboundDedupeEntry } from "./scenario-runtime-state-files.js";

describe("Matrix QA persisted state probes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("observes inbound dedupe entries committed through the core claimable dedupe", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-dedupe-"));
    tempDirs.push(stateDir);
    const accountRoot = path.join(stateDir, "matrix", "accounts", "sut", "server", "token");
    const eventId = "$event";
    const roomId = "!room:matrix-qa.test";
    // Mirrors the matrix monitor's guard configuration so the probe is proven
    // against the exact persisted row shape the runtime writes, including the
    // account-scoped key the probe must match by suffix.
    const guard = createClaimableDedupe({
      pluginId: "matrix",
      namespacePrefix: "matrix.inbound-dedupe",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      memoryMaxSize: 100,
      stateMaxEntries: 100,
      env: { ...process.env, OPENCLAW_STATE_DIR: accountRoot },
    });
    const key = `runtime-default\0${roomId}\0${eventId}`;
    await guard.claim(key);
    await guard.commit(key);
    resetPluginStateStoreForTests();

    await expect(
      waitForMatrixInboundDedupeEntry({
        eventId,
        roomId,
        stateDir,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(path.join(accountRoot, "state", "openclaw.sqlite"));
  });
});
