import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const matrixSecrets = loadBundledChannelSecretContractApi("matrix");
if (!matrixSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Matrix secret contract api");
}
const matrixAssignments = matrixSecrets.collectRuntimeConfigAssignments;

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
