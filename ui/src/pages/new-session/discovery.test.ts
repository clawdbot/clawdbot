// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isDraftNodeSessionEligible,
  readDraftCloudProfiles,
  readDraftEnvironments,
  readDraftNodes,
} from "./discovery.ts";

describe("readDraftNodes", () => {
  it("ignores non-record array entries without throwing", () => {
    expect(
      readDraftNodes([
        null,
        undefined,
        42,
        "node",
        [],
        [[{ nodeId: "nested", connected: true, commands: ["system.run"] }]],
        { nodeId: " valid ", connected: true, commands: ["system.run", "fs.listDir"] },
      ]),
    ).toEqual([
      {
        nodeId: "valid",
        displayName: "valid",
        platform: undefined,
        deviceFamily: undefined,
        modelIdentifier: undefined,
        remoteIp: undefined,
        connected: true,
        canExec: true,
        canBrowse: true,
      },
    ]);
  });

  it("keeps execution capability independent from connectivity", () => {
    expect(
      readDraftNodes([
        {
          nodeId: "offline",
          connected: false,
          commands: ["system.run", "fs.listDir"],
        },
      ]),
    ).toEqual([
      {
        nodeId: "offline",
        displayName: "offline",
        platform: undefined,
        deviceFamily: undefined,
        modelIdentifier: undefined,
        remoteIp: undefined,
        connected: false,
        canExec: true,
        canBrowse: false,
      },
    ]);
  });

  it("keeps only the exact structured update-required issue", () => {
    const issue = {
      code: "update-required",
      action: "update-and-reconnect",
      updateCommand: "openclaw update",
      headlessReconnectCommand: "openclaw node restart",
    };
    expect(
      readDraftNodes([
        {
          nodeId: "outdated",
          connected: true,
          commands: ["system.run"],
          issues: [issue, { ...issue, headlessReconnectCommand: "legacy restart" }],
        },
      ])[0]?.issues,
    ).toEqual([issue]);
    expect(
      readDraftEnvironments([{ id: "node:outdated", type: "node", issues: [issue] }])[0]?.issues,
    ).toEqual([issue]);
  });

  it("uses capability, connection, and update state for session eligibility", () => {
    const nodes = readDraftNodes([
      { nodeId: "eligible", connected: true, commands: ["system.run"] },
      { nodeId: "offline", connected: false, commands: ["system.run"] },
      { nodeId: "no-exec", connected: true, commands: ["fs.listDir"] },
      {
        nodeId: "outdated",
        connected: true,
        commands: ["system.run"],
        issues: [
          {
            code: "update-required",
            action: "update-and-reconnect",
            updateCommand: "openclaw update",
            headlessReconnectCommand: "openclaw node restart",
          },
        ],
      },
    ]);
    const eligibility = Object.fromEntries(
      nodes.map((node) => [node.nodeId, isDraftNodeSessionEligible(node)]),
    );

    expect(eligibility).toEqual({
      eligible: true,
      "no-exec": false,
      offline: false,
      outdated: false,
    });
  });
});
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
          settings: { token: "hidden" },
        },
        { id: "aws", providerId: "crabbox", trust: "persistent" },
        { id: "legacy", providerId: "static-ssh" },
        { id: "invalid-trust", providerId: "crabbox", trust: "temporary" },
        { id: "", providerId: "crabbox" },
        { id: "missing-provider" },
      ]),
    ).toEqual([
      { id: "aws", providerId: "crabbox", trust: "persistent" },
      { id: "invalid-trust", providerId: "crabbox", trust: undefined },
      { id: "legacy", providerId: "static-ssh", trust: undefined },
      { id: "zeta", providerId: "static-ssh", trust: "disposable" },
    ]);
  });
});

describe("readDraftEnvironments", () => {
  it("keeps the closed environment types while rejecting malformed entries", () => {
    expect(
      readDraftEnvironments([
        { id: "gateway", type: "local", label: "Gateway" },
        { id: "node:macbook", type: "node" },
        { id: "worker:aws", type: "worker" },
        { id: "future", type: "future" },
        { id: "", type: "node" },
        { id: "missing-type" },
      ]),
    ).toEqual([
      { id: "gateway", type: "local" },
      { id: "node:macbook", type: "node" },
      { id: "worker:aws", type: "worker" },
    ]);
  });

  it("preserves valid environment facts and safely drops malformed optional shapes", () => {
    expect(
      readDraftEnvironments([
        {
          id: "node:macbook",
          type: "node",
          platform: " darwin ",
          sessionHost: false,
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
        platform: "darwin",
        sessionHost: false,
        lastConnectedAtMs: 1_000,
        lastDisconnectedAtMs: 2_000,
        lastSeenAtMs: 1_500,
        lastSeenReason: "silent_push",
        trust: "persistent",
        capabilities: ["camera.snap", "custom.unknown", "system.run"],
      },
      { id: "node:malformed", type: "node" },
    ]);
  });
});
