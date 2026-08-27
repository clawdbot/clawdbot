import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  EnvironmentsCreateResultSchema,
  EnvironmentsDestroyResultSchema,
  EnvironmentsListResultSchema,
  EnvironmentSummarySchema,
  validateEnvironmentsCreateParams,
  validateEnvironmentsDestroyParams,
  validateWorkerDesktopLaunchParams,
  validateWorkerDesktopLaunchResult,
  WorkerEnvironmentStateSchema,
} from "../index.js";
import { WorkerSlotSummarySchema } from "./environments.js";

const workerStates = [
  "requested",
  "provisioning",
  "bootstrapping",
  "ready",
  "attached",
  "idle",
  "draining",
  "destroying",
  "destroyed",
  "failed",
  "orphaned",
] as const;

function workerSummary(
  state: (typeof workerStates)[number],
  status: "available" | "unavailable" | "starting" = "starting",
) {
  return {
    id: "environment-1",
    type: "worker",
    label: "Development worker",
    status,
    worker: {
      providerId: "static-ssh",
      state,
      ageMs: 250,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
    },
  };
}

describe("worker environment protocol schemas", () => {
  it("accepts configured-profile create and environment-id destroy requests", () => {
    expect(
      validateEnvironmentsCreateParams({ profileId: "development", idempotencyKey: "request-1" }),
    ).toBe(true);
    expect(validateEnvironmentsDestroyParams({ environmentId: "environment-1" })).toBe(true);
  });

  it("rejects missing, empty, and unknown lifecycle request fields", () => {
    expect(validateEnvironmentsCreateParams({})).toBe(false);
    expect(validateEnvironmentsCreateParams({ profileId: "", idempotencyKey: "request-1" })).toBe(
      false,
    );
    expect(validateEnvironmentsCreateParams({ profileId: "development", idempotencyKey: "" })).toBe(
      false,
    );
    expect(
      validateEnvironmentsCreateParams({
        profileId: "development",
        idempotencyKey: "request-1",
        providerId: "ssh",
      }),
    ).toBe(false);
    expect(validateEnvironmentsDestroyParams({ environmentId: "" })).toBe(false);
    expect(validateEnvironmentsDestroyParams({ environmentId: "environment-1", force: true })).toBe(
      true,
    );
  });

  it("keeps the worker lifecycle state closed", () => {
    for (const state of workerStates) {
      expect(Value.Check(WorkerEnvironmentStateSchema, state)).toBe(true);
    }
    expect(Value.Check(WorkerEnvironmentStateSchema, "unknown")).toBe(false);
  });

  it("accepts worker metadata additively across summary and mutation results", () => {
    const requested = {
      ...workerSummary("requested"),
      platform: "linux",
      sessionHost: false,
      trust: "disposable",
    };
    const destroyedBase = workerSummary("destroyed", "unavailable");
    const destroyed = {
      ...destroyedBase,
      worker: {
        ...destroyedBase.worker,
        leaseId: "lease-1",
        idleMs: 50,
        error: "provider teardown failed",
      },
    };

    expect(Value.Check(EnvironmentSummarySchema, requested)).toBe(true);
    expect(Value.Check(EnvironmentsCreateResultSchema, requested)).toBe(true);
    expect(Value.Check(EnvironmentsDestroyResultSchema, destroyed)).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("ready", "available"),
        worker: {
          ...workerSummary("ready", "available").worker,
          desktop: true,
          desktopApps: ["browser", "terminal"],
        },
      }),
    ).toBe(true);
  });

  it("accepts only redacted node worker bundle status", () => {
    const node = {
      id: "node:build-mac",
      type: "node",
      status: "available",
    };
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        workerBundle: { status: "installed", version: "2026.8.9" },
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        workerBundle: { status: "missing" },
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        workerBundle: {
          status: "installed",
          version: "2026.8.9",
          bundleHash: "a".repeat(64),
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        workerBundle: { status: "installed", version: "" },
      }),
    ).toBe(false);
  });

  it("accepts only bounded closed worker slot summaries", () => {
    const slots = { total: 2, available: 1 };
    expect(Value.Check(WorkerSlotSummarySchema, slots)).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "node:build-mac",
        type: "node",
        status: "available",
        workerSlots: slots,
      }),
    ).toBe(true);
    expect(Value.Check(WorkerSlotSummarySchema, { total: 0, available: 0 })).toBe(false);
    expect(Value.Check(WorkerSlotSummarySchema, { total: 2, available: 3 })).toBe(false);
    expect(Value.Check(WorkerSlotSummarySchema, { total: 2, available: 1_025 })).toBe(false);
    expect(Value.Check(WorkerSlotSummarySchema, { ...slots, busy: 1 })).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "node:build-mac",
        type: "node",
        status: "available",
        workerSlots: { total: 2, available: 3 },
      }),
    ).toBe(false);
  });

  it("accepts only bounded, unique effective node command authority", () => {
    const node = {
      id: "node:build-mac",
      type: "node",
      status: "available",
    };

    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...node,
        invocableCommands: ["codex.exec-server.stdio.v1", "system.run"],
      }),
    ).toBe(true);
    expect(Value.Check(EnvironmentSummarySchema, { ...node, invocableCommands: [] })).toBe(true);

    for (const invocableCommands of [
      [""],
      ["system.run", "system.run"],
      ["x".repeat(129)],
      Array.from({ length: 129 }, (_, index) => `command.${index}`),
    ]) {
      expect(Value.Check(EnvironmentSummarySchema, { ...node, invocableCommands })).toBe(false);
    }
  });

  it("accepts bounded node lifecycle history and rejects malformed timestamps", () => {
    const node = {
      id: "node:build-mac",
      type: "node",
      status: "unavailable",
      lastConnectedAtMs: 1_000,
      lastDisconnectedAtMs: 2_000,
      lastSeenAtMs: 1_500,
      lastSeenReason: "silent_push",
    };
    expect(Value.Check(EnvironmentSummarySchema, node)).toBe(true);
    expect(Value.Check(EnvironmentSummarySchema, { ...node, lastDisconnectedAtMs: -1 })).toBe(
      false,
    );
    expect(Value.Check(EnvironmentSummarySchema, { ...node, lastSeenReason: "" })).toBe(false);
  });

  it("keeps desktop app launch requests, results, and projected ids closed", () => {
    expect(validateWorkerDesktopLaunchParams({ environmentId: "worker:one", app: "browser" })).toBe(
      true,
    );
    expect(validateWorkerDesktopLaunchResult({ app: "terminal", status: "ready" })).toBe(true);
    expect(validateWorkerDesktopLaunchParams({ environmentId: "worker:one", app: "editor" })).toBe(
      false,
    );
    expect(
      validateWorkerDesktopLaunchParams({
        environmentId: "worker:one",
        app: "browser",
        args: ["--incognito"],
      }),
    ).toBe(false);
    expect(validateWorkerDesktopLaunchResult({ app: "browser", status: "starting" })).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("ready", "available"),
        worker: {
          ...workerSummary("ready", "available").worker,
          desktopApps: ["editor"],
        },
      }),
    ).toBe(false);
  });

  it("lists configured worker profiles without provider settings", () => {
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [
          {
            id: "aws",
            providerId: "crabbox",
            trust: "disposable",
            executionMode: "worker-turn",
            executionModes: ["worker-turn", "remote-exec"],
            machines: [
              {
                id: "standard",
                label: "Standard",
                cpu: 32,
                memoryGb: 64,
                default: true,
              },
            ],
          },
          {
            id: "worker",
            providerId: "static-ssh",
            executionMode: "remote-exec",
            executionModes: ["remote-exec"],
          },
          { id: "legacy-primary", providerId: "static-ssh", executionMode: "worker-turn" },
          { id: "legacy", providerId: "static-ssh" },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox", settings: { token: "hidden" } }],
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox", trust: "temporary" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox", executionMode: "sandbox" }],
      }),
    ).toBe(false);
    for (const executionModes of [
      [],
      ["worker-turn", "worker-turn"],
      ["remote-exec", "worker-turn"],
      ["worker-turn", "sandbox"],
      ["worker-turn", "remote-exec", "worker-turn"],
    ]) {
      expect(
        Value.Check(EnvironmentsListResultSchema, {
          environments: [],
          profiles: [{ id: "aws", providerId: "crabbox", executionModes }],
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [
          {
            id: "aws",
            providerId: "crabbox",
            machines: [{ id: "standard", label: "Standard", cpu: 0 }],
          },
        ],
      }),
    ).toBe(false);
  });

  it("preserves summaries without worker metadata and rejects malformed worker metadata", () => {
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "gateway",
        type: "local",
        status: "available",
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "node:outdated",
        type: "node",
        status: "available",
        issues: [
          {
            code: "update-required",
            action: "update-and-reconnect",
            updateCommand: "openclaw update",
            headlessReconnectCommand: "openclaw node restart",
          },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "node:outdated",
        type: "node",
        status: "available",
        issues: [{ code: "update-required", action: "run-legacy-worker" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("ready", "available"),
        worker: { ...workerSummary("ready", "available").worker, ageMs: -1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("attached", "available"),
        worker: {
          ...workerSummary("attached", "available").worker,
          attachedSessionIds: [""],
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("failed"),
        worker: { ...workerSummary("failed").worker, error: "" },
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("ready", "available"),
        trust: "temporary",
      }),
    ).toBe(false);
  });
});
