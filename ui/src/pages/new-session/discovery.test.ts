// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readDraftCloudProfiles, readDraftNodes } from "./discovery.ts";

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
        { id: " zeta ", providerId: " static-ssh ", settings: { token: "hidden" } },
        { id: "aws", providerId: "crabbox" },
        { id: "", providerId: "crabbox" },
        { id: "missing-provider" },
      ]),
    ).toEqual([
      { id: "aws", providerId: "crabbox" },
      { id: "zeta", providerId: "static-ssh" },
    ]);
  });
});
