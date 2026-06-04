/** Test bootstrap shim for Discord runtime-secret surface coverage. */
import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

/** Test-only bootstrap registry mock for Discord secret surface tests. */
const discordSecrets = loadBundledChannelSecretContractApi("discord");
if (!discordSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Discord secret contract api");
}
const discordAssignments = discordSecrets.collectRuntimeConfigAssignments;

// Use the real bundled Discord secret contract while avoiding plugin bootstrap.
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
