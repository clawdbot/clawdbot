import { describe, expect, it } from "vitest";
import {
  parseNodeWorkerWorkspaceRetainInput,
  parseNodeWorkerWorkspaceRetainResult,
} from "./node-workspace-retain-protocol.js";

const entry = {
  environmentId: "environment-1",
  sessionId: "session-1",
  generation: 3,
  manifestRefs: [`sha256:${"a".repeat(64)}`],
};

describe("node workspace retain protocol", () => {
  it("parses and canonicalizes a bounded full snapshot", () => {
    expect(
      parseNodeWorkerWorkspaceRetainInput(
        JSON.stringify({
          version: 1,
          gatewayNamespace: "gateway-test",
          controllerId: "controller-1",
          sequence: 4,
          retain: [{ ...entry, environmentId: "environment-2", manifestRefs: null }, entry],
        }),
      ),
    ).toEqual({
      version: 1,
      gatewayNamespace: "gateway-test",
      controllerId: "controller-1",
      sequence: 4,
      retain: [entry, { ...entry, environmentId: "environment-2", manifestRefs: null }],
    });
  });

  it.each([
    { ...entry, extra: true },
    { ...entry, generation: 0 },
    { ...entry, manifestRefs: ["not-a-ref"] },
  ])("rejects an invalid retain entry %#", (invalid) => {
    expect(() =>
      parseNodeWorkerWorkspaceRetainInput(
        JSON.stringify({
          version: 1,
          gatewayNamespace: "gateway-test",
          controllerId: "controller-1",
          sequence: 1,
          retain: [invalid],
        }),
      ),
    ).toThrow("INVALID_REQUEST");
  });

  it("rejects duplicate generation ownership", () => {
    expect(() =>
      parseNodeWorkerWorkspaceRetainInput(
        JSON.stringify({
          version: 1,
          gatewayNamespace: "gateway-test",
          controllerId: "controller-1",
          sequence: 1,
          retain: [entry, entry],
        }),
      ),
    ).toThrow("must be unique");
  });

  it("parses only the exact bounded result", () => {
    expect(
      parseNodeWorkerWorkspaceRetainResult({ applied: true, deleted: 2, hasMore: false }),
    ).toEqual({ applied: true, deleted: 2, hasMore: false });
    expect(
      parseNodeWorkerWorkspaceRetainResult({
        applied: true,
        deleted: 2,
        hasMore: false,
        extra: true,
      }),
    ).toBeNull();
  });
});
