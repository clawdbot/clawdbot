import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const zaloSecrets = loadBundledChannelSecretContractApi("zalo");
if (!zaloSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Zalo secret contract api");
}
const zaloAssignments = zaloSecrets.collectRuntimeConfigAssignments;

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "zalo"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: zaloAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "zalo"
      ? {
          collectRuntimeConfigAssignments: zaloAssignments,
        }
      : undefined,
}));
