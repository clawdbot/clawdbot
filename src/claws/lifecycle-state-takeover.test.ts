import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fsSafe from "../infra/fs-safe.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan } from "./lifecycle-state.js";
import { createClawRemoveTestFixtures } from "./lifecycle-state.test-helpers.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "claw-takeover-config-" });
  await state.writeConfig({});
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { addFixture } = createClawRemoveTestFixtures(tempDirs, () => state);

describe("Claw workspace deletion ownership", () => {
  it.each([
    ["SOUL.md", "discovery"],
    ["SOUL.md", "staged read"],
    ["SOUL.md", "staged replacement"],
    ["BOOTSTRAP.md", "discovery"],
    ["BOOTSTRAP.md", "staged read"],
  ] as const)("preserves %s after deletion takeover during %s", async (filename, boundary) => {
    const current = await addFixture({
      withFile: filename === "SOUL.md",
      withBootstrap: filename === "BOOTSTRAP.md",
    });
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    const originalRoot = fsSafe.root;
    let replaced = false;
    const replaceOwner = () => {
      const entry = readAgentDeletionJournal("worker", { env: current.env });
      if (!entry || replaced) {
        return;
      }
      beginAgentDeletionJournal({ ...entry, operationId: "replacement" }, { env: current.env });
      replaced = true;
    };
    const rootSpy = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const workspace = await originalRoot(...args);
      if (args[0] === current.plan.agent.workspace) {
        const exists = workspace.exists.bind(workspace);
        workspace.exists = async (path) => {
          const found = await exists(path);
          if (boundary === "discovery" && path === filename) {
            replaceOwner();
          }
          return found;
        };
        const readBytes = workspace.readBytes.bind(workspace);
        workspace.readBytes = async (path, options) => {
          const bytes = await readBytes(path, options);
          if (boundary !== "discovery" && path.startsWith(`${filename}.openclaw-claw-remove-`)) {
            if (boundary === "staged replacement") {
              await writeFile(join(current.plan.agent.workspace, filename), "replacement\n");
            }
            replaceOwner();
          }
          return bytes;
        };
      }
      return workspace;
    });
    try {
      await expect(
        applyClawRemovePlan(plan, {
          env: current.env,
          config,
          consentPlanIntegrity: plan.planIntegrity,
          monitorGateway: quiescentClawMonitorGateway,
        }),
      ).resolves.toMatchObject({
        status: "partial",
        agentRemoved: true,
        error: { message: expect.stringContaining("no longer owns") },
      });
      expect(replaced).toBe(true);
      await expect(readFile(join(current.plan.agent.workspace, filename), "utf8")).resolves.toBe(
        boundary === "staged replacement" ? "replacement\n" : "managed\n",
      );
      const staged = (await readdir(current.plan.agent.workspace)).filter((name) =>
        name.includes(".openclaw-claw-remove-"),
      );
      if (boundary === "staged replacement") {
        expect(staged).toHaveLength(1);
        await expect(
          readFile(join(current.plan.agent.workspace, staged[0]!), "utf8"),
        ).resolves.toBe("managed\n");
      } else {
        expect(staged).toEqual([]);
      }
      expect(readAgentDeletionJournal("worker", { env: current.env })?.operationId).toBe(
        "replacement",
      );
    } finally {
      rootSpy.mockRestore();
    }
  });
});
