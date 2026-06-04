/** Shared Nextcloud Talk secrets runtime fixtures. */
import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

/** Test-only bootstrap registry mock for Nextcloud Talk secret surface tests. */
const nextcloudTalkSecrets = loadBundledChannelSecretContractApi("nextcloud-talk");
if (!nextcloudTalkSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Nextcloud Talk secret contract api");
}
const nextcloudTalkAssignments = nextcloudTalkSecrets.collectRuntimeConfigAssignments;

// Use the real bundled Nextcloud Talk contract while avoiding plugin bootstrap.
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
