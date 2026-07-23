import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { createSelectedReadinessResolver } from "./selection.js";

function pluginCriterion(): PluginReadinessCriterionRegistration {
  return {
    id: "plugin.storage.backend",
    pluginId: "storage",
    source: "/plugins/storage/index.js",
    criterion: {
      id: "backend",
      description: "Reports storage backend availability.",
      check: vi.fn(() => ({
        status: "False" as const,
        reason: "StorageUnavailable",
        message: "Storage is unavailable.",
      })),
    },
  };
}

describe("createSelectedReadinessResolver", () => {
  it("does no provider work when no criteria are selected", async () => {
    const criterion = pluginCriterion();
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({ config: {}, registry: { readinessCriteria: [criterion] } }),
    ).resolves.toEqual([]);
    expect(criterion.criterion.check).not.toHaveBeenCalled();
  });

  it("promotes only operator-selected plugin criteria to required", async () => {
    const criterion = pluginCriterion();
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: {
          gateway: {
            readiness: {
              requiredCriteria: ["plugin.storage.backend"],
              advisoryCriteria: ["plugin.storage.backend"],
            },
          },
        },
        registry: { readinessCriteria: [criterion] },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "plugin.storage.backend",
        status: "False",
        requirement: "required",
        reason: "StorageUnavailable",
      }),
    ]);
  });

  it("maps the core selector id to its canonical condition type", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-selected-readiness-"));
    const resolve = createSelectedReadinessResolver();

    try {
      await expect(
        resolve({
          config: {
            agents: { defaults: { workspace } },
            gateway: { readiness: { requiredCriteria: ["openclaw.workspace-writable"] } },
          },
          registry: { readinessCriteria: [] },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          type: "WorkspaceWritable",
          status: "True",
          requirement: "required",
        }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed for an unregistered required criterion", async () => {
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: { gateway: { readiness: { requiredCriteria: ["plugin.missing.backend"] } } },
        registry: { readinessCriteria: [] },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "plugin.missing.backend",
        status: "Unknown",
        requirement: "required",
        reason: "CriterionNotRegistered",
      }),
    ]);
  });
});
