import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import { waitForMatrixInboundDedupeEntry } from "./scenario-runtime-state-files.js";

const dedupeStoreRuntime = {
  openMatrixInboundDedupeStoreOptions(params: { stateDir?: string }) {
    return {
      namespace: "inbound-dedupe",
      maxEntries: 20_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    };
  },
};

function buildDedupeKey(params: { accountId: string; eventId: string; roomId: string }) {
  return `${params.accountId}:${createHash("sha256")
    .update(params.accountId)
    .update("\0")
    .update(params.roomId)
    .update("\0")
    .update(params.eventId)
    .digest("hex")}`;
}

describe("Matrix QA persisted state probes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("observes inbound dedupe entries through the canonical plugin-state store", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-dedupe-"));
    tempDirs.push(stateDir);
    const accountRoot = path.join(stateDir, "matrix", "accounts", "sut", "server", "token");
    const accountId = "sut";
    const eventId = "$event";
    const roomId = "!room:matrix-qa.test";
    const options = dedupeStoreRuntime.openMatrixInboundDedupeStoreOptions({
      stateDir: accountRoot,
    });
    const runtimeAccountId = "runtime-default";
    createPluginStateSyncKeyedStoreForTests("matrix", options).register(
      buildDedupeKey({ accountId: runtimeAccountId, eventId, roomId }),
      { eventId, roomId, ts: Date.now() },
    );
    resetPluginStateStoreForTests();

    await expect(
      waitForMatrixInboundDedupeEntry({
        context: { sutAccountId: accountId } as MatrixQaScenarioContext,
        dedupeStoreRuntime,
        eventId,
        roomId,
        stateDir,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(path.join(accountRoot, "state", "openclaw.sqlite"));
  });
});
