import { describe, expect, it } from "vitest";
import {
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  parseNodeRunnerInventoryDeclaration,
} from "./node-runner-inventory.js";

describe("node worker skill resource declaration", () => {
  const declaration = {
    protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
    workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
  };

  it.each([{}, { workspaceSkillResources: 1 }])("preserves optional support %#", (capability) => {
    const input = { ...declaration, workerHost: { ...declaration.workerHost, ...capability } };
    expect(parseNodeRunnerInventoryDeclaration(input)).toEqual(input);
  });

  it.each([0, 2, true, "1", null])("rejects unrecognized version %j", (workspaceSkillResources) => {
    expect(
      parseNodeRunnerInventoryDeclaration({
        ...declaration,
        workerHost: { ...declaration.workerHost, workspaceSkillResources },
      }),
    ).toBeNull();
  });

  it("keeps resource support out of disabled hosting declarations", () => {
    expect(
      parseNodeRunnerInventoryDeclaration({
        ...declaration,
        workerHost: { enabled: false, workspaceSkillResources: 1 },
      }),
    ).toBeNull();
  });
});
