/** Shared fixtures for secrets runtime matrix tests. */
import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

/** Test-only bootstrap registry mock for Matrix secret surface tests. */
const matrixSecrets = loadBundledChannelSecretContractApi("matrix");
if (!matrixSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Matrix secret contract api");
}
const matrixAssignments = matrixSecrets.collectRuntimeConfigAssignments;

// Use the real bundled Matrix secret contract while avoiding plugin bootstrap.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "matrix"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: matrixAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "matrix"
      ? {
          collectRuntimeConfigAssignments: matrixAssignments,
        }
      : undefined,
}));
