import { describe, expect, it } from "vitest";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../shared/worker-bundle-limits.js";
import {
  nodeWorkerBundleTransferPath,
  parseNodeWorkerBundleInstallInput,
  parseNodeWorkerBundleInstallResult,
} from "./node-bundle-install-protocol.js";

const build = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.1",
  protocolFeatures: ["worker-execution-context-v2"],
};
const input = {
  gatewayNamespace: "gateway-test",
  build,
  archive: {
    token: "A".repeat(43),
    sha256: "b".repeat(64),
    bytes: 123,
  },
};

describe("node worker bundle install protocol", () => {
  it("parses the closed exact-build install request", () => {
    expect(parseNodeWorkerBundleInstallInput(JSON.stringify(input))).toEqual(input);
    expect(parseNodeWorkerBundleInstallResult(build)).toEqual(build);
    expect(nodeWorkerBundleTransferPath(build.bundleHash)).toBe(
      `/__openclaw__/worker-bundle/v1/bundles/${build.bundleHash}`,
    );
  });

  it("accepts only the mutually supported prewarm form", () => {
    const prewarmInput = { ...input, bundlePrewarm: 1 };
    expect(parseNodeWorkerBundleInstallInput(JSON.stringify(prewarmInput))).toEqual(prewarmInput);
    expect(() =>
      parseNodeWorkerBundleInstallInput(JSON.stringify({ ...input, bundlePrewarm: 2 })),
    ).toThrow("INVALID_REQUEST");
  });

  it.each([
    { ...input, extra: true },
    { ...input, gatewayNamespace: "../escape" },
    { ...input, build: { ...build, bundleHash: "bad" } },
    { ...input, archive: { ...input.archive, token: "short" } },
    { ...input, archive: { ...input.archive, bytes: 0 } },
    { ...input, archive: { ...input.archive, bytes: MAX_WORKER_BUNDLE_ARCHIVE_BYTES + 1 } },
  ])("rejects malformed install input %#", (candidate) => {
    expect(() => parseNodeWorkerBundleInstallInput(JSON.stringify(candidate))).toThrow(
      "INVALID_REQUEST",
    );
  });

  it("rejects malformed install results", () => {
    expect(parseNodeWorkerBundleInstallResult({ ...build, extra: true })).toBeNull();
    expect(parseNodeWorkerBundleInstallResult({ ...build, protocolFeatures: [""] })).toBeNull();
  });
});
