/** Test bootstrap shim for Telegram runtime-secret surface coverage. */
import { vi } from "vitest";
import { loadChannelSecretContractApi } from "./channel-contract-api.js";

/** Test-only bootstrap registry mock for Telegram secret surface tests. */
const telegramSecrets = loadChannelSecretContractApi({ channelId: "telegram", config: {} });
if (!telegramSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Telegram secret contract api");
}
const telegramAssignments = telegramSecrets.collectRuntimeConfigAssignments;

// Use the real bundled Telegram secret contract while avoiding plugin bootstrap.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "telegram"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: telegramAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "telegram"
      ? {
          collectRuntimeConfigAssignments: telegramAssignments,
        }
      : undefined,
}));
