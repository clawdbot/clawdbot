import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { listTaskRecordPage } from "./task-registry.js";
import { createTaskFixture, resetTaskRegistryForTests } from "./task-registry.test-support.js";

const stateDirEnvSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-page-"));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  resetTaskRegistryForTests({ persist: false });
});

afterEach(async () => {
  resetTaskRegistryForTests({ persist: false });
  stateDirEnvSnapshot.restore();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("listTaskRecordPage", () => {
  it("bounds activity sorts to the requested page window", () => {
    for (let index = 0; index < 20; index += 1) {
      createTaskFixture("cli", {
        requesterSessionKey: "agent:main:main",
        runId: `run-page-${index}`,
        task: `Task ${index}`,
      });
    }

    const sortSpy = vi.spyOn(Array.prototype, "sort");
    const toSortedSpy = vi.spyOn(Array.prototype, "toSorted");
    try {
      const page = listTaskRecordPage({ offset: 4, limit: 3 });
      const sortSizes = [
        ...sortSpy.mock.instances.map((values) => values.length),
        ...toSortedSpy.mock.instances.map((values) => values.length),
      ];

      expect(page.tasks).toHaveLength(3);
      expect(page.hasMore).toBe(true);
      expect(sortSizes.length).toBeGreaterThan(0);
      expect(Math.max(...sortSizes)).toBeLessThanOrEqual(14);
    } finally {
      sortSpy.mockRestore();
      toSortedSpy.mockRestore();
    }
  });
});
