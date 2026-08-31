/** Test bootstrap shim for Zalo runtime-secret surface coverage. */
import { vi } from "vitest";
import { loadChannelSecretContractApi } from "./channel-contract-api.js";

/** Test-only bootstrap registry mock for Zalo secret surface tests. */
const zaloSecrets = loadChannelSecretContractApi({ channelId: "zalo", config: {} });
if (!zaloSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Zalo secret contract api");
}
const zaloAssignments = zaloSecrets.collectRuntimeConfigAssignments;

// Use the real bundled Zalo secret contract while avoiding plugin bootstrap.
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
