import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const telegramSecrets = loadBundledChannelSecretContractApi("telegram");
if (!telegramSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Telegram secret contract api");
}
const telegramAssignments = telegramSecrets.collectRuntimeConfigAssignments;

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
