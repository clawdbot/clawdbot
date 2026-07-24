import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import {
  applySelectedCanonicalRequirements,
  createSelectedReadinessResolver,
} from "./selection.js";

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
    ).resolves.toEqual({ conditions: [], subjects: [] });
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
    ).resolves.toMatchObject({
      conditions: [
        expect.objectContaining({
          type: "plugin.storage.backend",
          status: "False",
          requirement: "required",
          reason: "StorageUnavailable",
        }),
      ],
    });
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
      ).resolves.toMatchObject({
        conditions: [
          expect.objectContaining({
            type: "WorkspaceWritable",
            status: "True",
            requirement: "required",
          }),
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("projects requirements onto canonical plugin and event-loop conditions", () => {
    expect(
      applySelectedCanonicalRequirements(
        {
          gateway: {
            readiness: {
              requiredCriteria: ["openclaw.plugins-loaded"],
              advisoryCriteria: ["openclaw.event-loop-healthy"],
            },
          },
        },
        [
          {
            type: "PluginsLoaded",
            status: "False",
            requirement: "advisory",
            reason: "PluginLoadFailures",
            message: "A plugin failed to load.",
          },
          {
            type: "EventLoopHealthy",
            status: "False",
            requirement: "advisory",
            reason: "EventLoopDegraded",
            message: "The event loop is degraded.",
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({ type: "PluginsLoaded", requirement: "required" }),
      expect.objectContaining({ type: "EventLoopHealthy", requirement: "advisory" }),
    ]);
  });

  it("does not synthesize duplicate conditions for canonical selectors", async () => {
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: {
          gateway: {
            readiness: {
              requiredCriteria: ["openclaw.plugins-loaded"],
              advisoryCriteria: ["openclaw.event-loop-healthy"],
            },
          },
        },
        registry: { readinessCriteria: [] },
      }),
    ).resolves.toEqual({ conditions: [], subjects: [] });
  });

  it("reports a selected canonical condition as unknown when its producer did not run", () => {
    expect(
      applySelectedCanonicalRequirements(
        {
          gateway: {
            readiness: { requiredCriteria: ["openclaw.plugins-loaded"] },
          },
        },
        [],
      ),
    ).toEqual([
      {
        type: "PluginsLoaded",
        subjectRef: "openclaw/plugins/active",
        status: "Unknown",
        requirement: "required",
        reason: "CriterionEvaluationUnavailable",
        message: "Readiness criterion PluginsLoaded was selected but could not be evaluated.",
      },
    ]);
  });

  it("maps activation selector ids and preserves the selected requirement", async () => {
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: { gateway: { readiness: { requiredCriteria: ["openclaw.config-current"] } } },
        registry: { readinessCriteria: [] },
      }),
    ).resolves.toMatchObject({
      conditions: [
        expect.objectContaining({
          type: "ConfigCurrent",
          subjectRef: "openclaw/config/active",
          status: "Unknown",
          requirement: "required",
          reason: "ConfigGenerationUnavailable",
        }),
      ],
    });
  });

  it("maps an execution capability selector to its canonical condition type", async () => {
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: {
          gateway: { readiness: { requiredCriteria: ["openclaw.harness-ready"] } },
        },
        registry: { readinessCriteria: [] },
      }),
    ).resolves.toMatchObject({
      conditions: [
        expect.objectContaining({
          type: "HarnessReady",
          subjectRef: "openclaw/harness/active",
          status: "True",
          requirement: "required",
        }),
      ],
    });
  });

  it("fails closed for an unregistered required criterion", async () => {
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: { gateway: { readiness: { requiredCriteria: ["plugin.missing.backend"] } } },
        registry: { readinessCriteria: [] },
      }),
    ).resolves.toMatchObject({
      conditions: [
        expect.objectContaining({
          type: "plugin.missing.backend",
          status: "Unknown",
          requirement: "required",
          reason: "CriterionNotRegistered",
        }),
      ],
    });
  });

  it("adds profile advisories without demoting required operator criteria", async () => {
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: {
          gateway: { readiness: { requiredCriteria: ["openclaw.scheduler-ready"] } },
        },
        registry: { readinessCriteria: [] },
        stateServices: {
          scheduler: { enabled: false, phase: "disabled", recoveryPending: false },
        },
        additionalAdvisoryCriteria: ["openclaw.scheduler-ready", "openclaw.state-ready"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ type: "SchedulerReady", requirement: "required" }),
      expect.objectContaining({ type: "StateReady", requirement: "advisory" }),
    ]);
  });

  it("promotes selected scheduler lifecycle evidence to required", async () => {
    const resolve = createSelectedReadinessResolver();

    await expect(
      resolve({
        config: {
          gateway: { readiness: { requiredCriteria: ["openclaw.scheduler-ready"] } },
        },
        registry: { readinessCriteria: [] },
        stateServices: {
          scheduler: { enabled: true, phase: "starting", recoveryPending: false },
        },
      }),
    ).resolves.toMatchObject({
      conditions: [
        expect.objectContaining({
          type: "SchedulerReady",
          subjectRef: "openclaw/scheduler/active",
          status: "False",
          requirement: "required",
          reason: "SchedulerStarting",
        }),
      ],
    });
  });

  it("maps selected session storage evidence to its canonical condition", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-selected-state-"));
    const resolve = createSelectedReadinessResolver();

    try {
      await expect(
        resolve({
          config: {
            gateway: {
              readiness: { requiredCriteria: ["openclaw.session-storage-ready"] },
            },
          },
          registry: { readinessCriteria: [] },
          env: { OPENCLAW_STATE_DIR: stateDir },
        }),
      ).resolves.toMatchObject({
        conditions: [
          expect.objectContaining({
            type: "SessionStorageReady",
            subjectRef: "openclaw/session-storage/active",
            status: "True",
            requirement: "required",
          }),
        ],
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
