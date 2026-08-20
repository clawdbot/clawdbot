// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readDraftCloudProfiles, readDraftEnvironments } from "./discovery.ts";
describe("readDraftCloudProfiles", () => {
  it("keeps closed profile summaries in stable order", () => {
    expect(
      readDraftCloudProfiles([
        null,
        42,
        {
          id: " zeta ",
          providerId: " static-ssh ",
          trust: "disposable",
          executionMode: "worker-turn",
          settings: { token: "hidden" },
        },
        {
          id: "aws",
          providerId: "crabbox",
          trust: "persistent",
          executionMode: "remote-exec",
          machines: [
            {
              id: "standard",
              label: "Standard",
              cpu: 32,
              memoryGb: 64,
              default: true,
            },
            { id: "fast", label: "Fast", cpu: 0, memoryGb: 127.5 },
            { id: "fast", label: "Duplicate" },
            { id: "", label: "Invalid" },
          ],
        },
        { id: "legacy", providerId: "static-ssh" },
        {
          id: "invalid-trust",
          providerId: "crabbox",
          trust: "temporary",
          executionMode: "sandbox",
        },
        { id: "", providerId: "crabbox" },
        { id: "missing-provider" },
      ]),
    ).toEqual([
      {
        id: "aws",
        providerId: "crabbox",
        trust: "persistent",
        executionMode: "remote-exec",
        machines: [
          {
            id: "standard",
            label: "Standard",
            cpu: 32,
            memoryGb: 64,
            default: true,
          },
          { id: "fast", label: "Fast" },
        ],
      },
      {
        id: "invalid-trust",
        providerId: "crabbox",
        trust: undefined,
        executionMode: undefined,
      },
      {
        id: "legacy",
        providerId: "static-ssh",
        trust: undefined,
        executionMode: undefined,
      },
      {
        id: "zeta",
        providerId: "static-ssh",
        trust: "disposable",
        executionMode: "worker-turn",
      },
    ]);
  });
});

describe("readDraftEnvironments", () => {
  it("keeps only the exact update-required issue contract", () => {
    const issue = {
      code: "update-required",
      action: "update-and-reconnect",
      updateCommand: "openclaw update",
      headlessReconnectCommand: "openclaw node restart",
    };
    expect(
      readDraftEnvironments([
        {
          id: "node:outdated",
          type: "node",
          status: "available",
          issues: [issue, { ...issue, headlessReconnectCommand: "legacy restart" }],
        },
      ])[0]?.issues,
    ).toEqual([issue]);
  });

  it("keeps the closed environment types while rejecting malformed entries", () => {
    expect(
      readDraftEnvironments([
        { id: "gateway", type: "local", label: "Gateway", status: "available" },
        { id: "node:macbook", type: "node", status: "unavailable" },
        { id: "worker:aws", type: "worker", status: "starting" },
        { id: "future", type: "future", status: "available" },
        { id: "", type: "node", status: "available" },
        { id: "missing-type", status: "available" },
        { id: "missing-status", type: "node" },
        { id: "unknown-status", type: "node", status: "online" },
      ]),
    ).toEqual([
      { id: "gateway", type: "local", label: "Gateway", status: "available" },
      { id: "node:macbook", type: "node", status: "unavailable" },
      { id: "worker:aws", type: "worker", status: "starting" },
    ]);
  });

  it("preserves valid environment facts and safely drops malformed optional shapes", () => {
    expect(
      readDraftEnvironments([
        {
          id: "node:macbook",
          type: "node",
          label: " Build Mac ",
          status: "available",
          platform: " darwin ",
          sessionHost: false,
          workerSlots: { total: 4, available: 2 },
          lastConnectedAtMs: 1_000.9,
          lastDisconnectedAtMs: 2_000,
          lastSeenAtMs: 1_500,
          lastSeenReason: " silent_push ",
          trust: "persistent",
          capabilities: [" camera.snap ", 42, "custom.unknown", "system.run", null],
        },
        {
          id: "node:malformed",
          type: "node",
          status: "error",
          platform: { name: "linux" },
          sessionHost: "yes",
          trust: "temporary",
          capabilities: "camera",
        },
      ]),
    ).toEqual([
      {
        id: "node:macbook",
        type: "node",
        label: "Build Mac",
        status: "available",
        platform: "darwin",
        sessionHost: false,
        workerSlots: { total: 4, available: 2 },
        lastConnectedAtMs: 1_000,
        lastDisconnectedAtMs: 2_000,
        lastSeenAtMs: 1_500,
        lastSeenReason: "silent_push",
        trust: "persistent",
        capabilities: ["camera.snap", "custom.unknown", "system.run"],
      },
      { id: "node:malformed", type: "node", status: "error" },
    ]);
  });

  it.each([
    ["fractional", { total: 2.5, available: 1 }],
    ["zero total", { total: 0, available: 0 }],
    ["oversized", { total: 1_025, available: 1 }],
    ["overcommitted", { total: 2, available: 3 }],
    ["extra key", { total: 2, available: 1, queued: 1 }],
  ])("retains the environment while dropping %s worker slots", (_name, workerSlots) => {
    expect(
      readDraftEnvironments([
        {
          id: "node:runner",
          type: "node",
          label: "Runner",
          status: "available",
          sessionHost: true,
          workerSlots,
        },
      ]),
    ).toEqual([
      {
        id: "node:runner",
        type: "node",
        label: "Runner",
        status: "available",
        sessionHost: true,
      },
    ]);
  });
});
