// Delivery queue helper tests cover shared SQLite and temp-directory cleanup.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

const fixture = installDeliveryQueueTmpDirHooks();
let previousTmpDir = "";

describe("installDeliveryQueueTmpDirHooks", () => {
  it("tracks an open per-case state database", () => {
    previousTmpDir = fixture.tmpDir();
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: previousTmpDir } });

    expect(isOpenClawStateDatabaseOpen()).toBe(true);
    expect(fs.existsSync(previousTmpDir)).toBe(true);
  });

  it("closes handles and removes the previous case directory", () => {
    expect(isOpenClawStateDatabaseOpen()).toBe(false);
    expect(fs.existsSync(previousTmpDir)).toBe(false);
  });
});
