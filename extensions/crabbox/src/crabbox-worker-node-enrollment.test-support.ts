import type {
  CrabboxWorkerNodeEnrollment,
  CrabboxWorkerNodeRuntimePreparation,
} from "./crabbox-worker-node-enrollment.js";

export function createWorkerArchiveFixture(): CrabboxWorkerNodeRuntimePreparation["workerBundle"] {
  return {
    url: "https://gateway.example.test/__openclaw__/worker-bootstrap/artifacts/worker",
    token: "synthetic-worker-archive-token",
    sha256: "b".repeat(64),
    bytes: 100,
    packageRelativePath: `worker-artifacts/${"b".repeat(64)}.tgz`,
  };
}

export function createNodeBootstrapFixture(
  overrides: Partial<CrabboxWorkerNodeEnrollment["nodeBootstrap"]> = {},
): CrabboxWorkerNodeEnrollment["nodeBootstrap"] {
  return {
    url: "https://gateway.example.test/__openclaw__/node-bootstrap/v1/artifact",
    token: "synthetic-bootstrap-token",
    sha256: "a".repeat(64),
    bytes: 100,
    openclawVersion: "2026.8.1",
    enabledPluginIds: ["demo"],
    ...overrides,
  };
}
