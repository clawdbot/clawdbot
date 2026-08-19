// @vitest-environment node
import { describe, expect, it } from "vitest";
import { projectDevicePlacements } from "./device-placement.ts";
import type { DraftEnvironment } from "./discovery.ts";

const updateIssue = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

function node(overrides: Partial<DraftEnvironment>): DraftEnvironment {
  return {
    id: "node:runner",
    type: "node",
    label: "Build runner",
    status: "available",
    sessionHost: true,
    workerSlots: { total: 2, available: 1 },
    platform: "darwin",
    capabilities: ["camera.snap"],
    ...overrides,
  };
}

describe("device placement projection", () => {
  it.each([
    {
      name: "available host",
      environment: node({}),
      selectable: true,
      reason: undefined,
      facts: ["Worker slots 1/2", "macOS", "Camera"],
    },
    {
      name: "saturated host",
      environment: node({ workerSlots: { total: 2, available: 0 } }),
      selectable: false,
      reason: "No worker slots are available. Wait for a slot or pick another device.",
      facts: [
        "Worker slots 0/2",
        "No worker slots are available. Wait for a slot or pick another device.",
        "macOS",
        "Camera",
      ],
    },
    {
      name: "missing live capacity",
      environment: node({ workerSlots: undefined }),
      selectable: false,
      reason: "Worker capacity is unavailable. Restart the device session host and try again.",
      facts: [
        "Worker capacity is unavailable. Restart the device session host and try again.",
        "macOS",
        "Camera",
      ],
    },
    {
      name: "offline durable host",
      environment: node({ status: "unavailable", workerSlots: undefined }),
      selectable: false,
      reason: "Device unavailable. Reconnect it and try again.",
      facts: [
        "Never connected",
        "Device unavailable. Reconnect it and try again.",
        "macOS",
        "Camera",
      ],
    },
    {
      name: "connected non-host",
      environment: node({ sessionHost: false, workerSlots: undefined }),
      selectable: false,
      reason:
        "Session hosting is disabled. Run openclaw connect --service --session-host on the device.",
      facts: [
        "Session hosting is disabled. Run openclaw connect --service --session-host on the device.",
        "macOS",
        "Camera",
      ],
    },
    {
      name: "update required",
      environment: node({ issues: [updateIssue] }),
      selectable: false,
      reason:
        "Update required: run openclaw update, then reconnect. For a headless node, run openclaw node restart.",
      facts: [
        "Update required: run openclaw update, then reconnect. For a headless node, run openclaw node restart.",
        "Worker slots 1/2",
        "macOS",
        "Camera",
      ],
    },
  ])("projects $name with one canonical eligibility decision", (testCase) => {
    expect(projectDevicePlacements([testCase.environment])).toEqual([
      {
        deviceId: "runner",
        label: "Build runner",
        selectable: testCase.selectable,
        facts: testCase.facts,
        ...(testCase.reason ? { disabledReason: testCase.reason } : {}),
      },
    ]);
  });

  it("ignores non-node environment rows", () => {
    expect(
      projectDevicePlacements([
        { id: "gateway", type: "local", status: "available" },
        { id: "worker:cloud", type: "worker", status: "available" },
      ]),
    ).toEqual([]);
  });

  it("adds short device ids only when labels collide", () => {
    expect(
      projectDevicePlacements([
        node({ id: "node:unique", label: "Unique runner" }),
        node({ id: "node:alpha-device", label: "Duplicate runner" }),
        node({ id: "node:beta-device", label: "Duplicate runner" }),
      ]).map(({ deviceId, subtitle }) => ({ deviceId, subtitle })),
    ).toEqual([
      { deviceId: "alpha-device", subtitle: "alpha-de" },
      { deviceId: "beta-device", subtitle: "beta-dev" },
      { deviceId: "unique", subtitle: undefined },
    ]);
  });
});
