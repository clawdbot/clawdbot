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
          bundleHashes: ["b".repeat(64), "a".repeat(64)],
          acknowledgedBundleGeneration: 3,
          bundleStatusHash: "a".repeat(64),
          retain: [{ ...entry, environmentId: "environment-2", manifestRefs: null }, entry],
        }),
      ),
    ).toEqual({
      version: 1,
      gatewayNamespace: "gateway-test",
      controllerId: "controller-1",
      sequence: 4,
      bundleHashes: ["a".repeat(64), "b".repeat(64)],
      acknowledgedBundleGeneration: 3,
      bundleStatusHash: "a".repeat(64),
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

  it("rejects a bundle status hash that is not retained", () => {
    expect(() =>
      parseNodeWorkerWorkspaceRetainInput(
        JSON.stringify({
          version: 1,
          gatewayNamespace: "gateway-test",
          controllerId: "controller-1",
          sequence: 1,
          retain: [],
          bundleHashes: ["a".repeat(64)],
          bundleStatusHash: "b".repeat(64),
        }),
      ),
    ).toThrow("must be retained");
  });

  it("rejects a bundle-generation acknowledgement without bundle hashes", () => {
    expect(() =>
      parseNodeWorkerWorkspaceRetainInput(
        JSON.stringify({
          version: 1,
          gatewayNamespace: "gateway-test",
          controllerId: "controller-1",
          sequence: 1,
          retain: [],
          acknowledgedBundleGeneration: 3,
        }),
      ),
    ).toThrow("requires bundleHashes");
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
      parseNodeWorkerWorkspaceRetainResult({
        applied: true,
        deleted: 2,
        hasMore: false,
        bundleDeleted: 3,
        bundleGeneration: 4,
        bundleStatus: { bundleHash: "a".repeat(64), status: "installed" },
      }),
    ).toEqual({
      applied: true,
      deleted: 2,
      hasMore: false,
      bundleDeleted: 3,
      bundleGeneration: 4,
      bundleStatus: { bundleHash: "a".repeat(64), status: "installed" },
    });
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
