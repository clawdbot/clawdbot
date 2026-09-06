/** Test bootstrap shim for LINE runtime-secret surface coverage. */
import { vi } from "vitest";
import { loadChannelSecretContractApi } from "./channel-contract-api.js";

/** Test-only bootstrap registry mock for LINE secret surface tests. */
const lineSecrets = loadChannelSecretContractApi({ channelId: "line", config: {} });
if (!lineSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing LINE secret contract api");
}
const lineAssignments = lineSecrets.collectRuntimeConfigAssignments;

// Use the real bundled LINE secret contract while avoiding plugin bootstrap.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "line"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: lineAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "line"
      ? {
          collectRuntimeConfigAssignments: lineAssignments,
        }
      : undefined,
}));
