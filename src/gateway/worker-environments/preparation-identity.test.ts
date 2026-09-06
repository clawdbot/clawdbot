import { describe, expect, it } from "vitest";
import { createWorkerProjectPreparationIdentity } from "./preparation-identity.js";

const input: Parameters<typeof createWorkerProjectPreparationIdentity>[0] = {
  namespace: "gateway-one",
  providerId: "fake",
  profileId: "development",
  profileSnapshot: {
    install: "bundle",
    settings: { region: "test", disk: 20 },
    executionMode: "worker-turn",
  },
  project: { key: "a".repeat(64), root: "/source/first-worktree", baseCommit: "b".repeat(40) },
  target: { machineClass: "small", platform: "linux", arch: "x64" },
  artifacts: {
    nodeBootstrapSha256: "c".repeat(64),
    enabledPluginIds: ["second", "first"],
    workerBundleHash: "d".repeat(64),
    workerArchiveSha256: "e".repeat(64),
    openclawVersion: "2026.8.1",
    protocolFeatures: ["worker-inference-v1"],
  },
  setupRecipe: "f".repeat(40),
};

describe("worker preparation identity", () => {
  it("shares identity across linked source paths, JSON field order and plugin order", () => {
    const equivalent = structuredClone(input);
    equivalent.project.root = "/source/second-worktree";
    equivalent.profileSnapshot = {
      executionMode: "worker-turn",
      settings: { disk: 20, region: "test" },
      install: "bundle",
      machineClass: "small",
    };
    equivalent.artifacts.enabledPluginIds.reverse();
    expect(createWorkerProjectPreparationIdentity(equivalent)).toEqual(
      createWorkerProjectPreparationIdentity(input),
    );
  });

  it.each([
    [
      "namespace",
      (value: typeof input) => {
        value.namespace = "gateway-two";
      },
    ],
    [
      "commit",
      (value: typeof input) => {
        value.project.baseCommit = "1".repeat(40);
      },
    ],
    [
      "recipe",
      (value: typeof input) => {
        value.setupRecipe = "2".repeat(40);
      },
    ],
    [
      "profile",
      (value: typeof input) => {
        value.profileSnapshot = { ...value.profileSnapshot, settings: { region: "elsewhere" } };
      },
    ],
    [
      "target",
      (value: typeof input) => {
        value.target.arch = "arm64";
      },
    ],
    [
      "mode",
      (value: typeof input) => {
        value.profileSnapshot = { ...value.profileSnapshot, executionMode: "remote-exec" };
      },
    ],
    [
      "runtime",
      (value: typeof input) => {
        value.artifacts.nodeBootstrapSha256 = "3".repeat(64);
      },
    ],
    [
      "plugins",
      (value: typeof input) => {
        value.artifacts.enabledPluginIds.push("third");
      },
    ],
    [
      "bundle",
      (value: typeof input) => {
        value.artifacts.workerBundleHash = "4".repeat(64);
      },
    ],
    [
      "protocol",
      (value: typeof input) => {
        value.artifacts.protocolFeatures.push("worker-computer-v1");
      },
    ],
  ] as const)("invalidates a changed %s before allocation", (label, change) => {
    const changed = structuredClone(input);
    change(changed);
    const original = createWorkerProjectPreparationIdentity(input);
    const next = createWorkerProjectPreparationIdentity(changed);
    expect(next.key).not.toBe(original.key);
    expect(next.cacheKey).toMatch(/^[a-f0-9]{64}$/u);
    if (label === "commit") {
      expect(next.cacheKey).toBe(original.cacheKey);
    } else {
      expect(next.cacheKey).not.toBe(original.cacheKey);
    }
  });
});
