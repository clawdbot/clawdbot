// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readDraftCloudProfiles, readDraftEnvironments, readDraftNodes } from "./discovery.ts";

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
        trust: "persistent",
        capabilities: ["camera.snap", "custom.unknown", "system.run"],
      },
      { id: "node:malformed", type: "node" },
    ]);
  });
});
