import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const discordSecrets = loadBundledChannelSecretContractApi("discord");
if (!discordSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Discord secret contract api");
}
const discordAssignments = discordSecrets.collectRuntimeConfigAssignments;

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "discord"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: discordAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "discord"
      ? {
          collectRuntimeConfigAssignments: discordAssignments,
        }
      : undefined,
}));
