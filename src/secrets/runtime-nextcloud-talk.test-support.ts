import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const nextcloudTalkSecrets = loadBundledChannelSecretContractApi("nextcloud-talk");
if (!nextcloudTalkSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Nextcloud Talk secret contract api");
}
const nextcloudTalkAssignments = nextcloudTalkSecrets.collectRuntimeConfigAssignments;

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "nextcloud-talk"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: nextcloudTalkAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "nextcloud-talk"
      ? {
          collectRuntimeConfigAssignments: nextcloudTalkAssignments,
        }
      : undefined,
}));
