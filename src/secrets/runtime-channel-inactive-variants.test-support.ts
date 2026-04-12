import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const googleChatSecrets = loadBundledChannelSecretContractApi("googlechat");
const ircSecrets = loadBundledChannelSecretContractApi("irc");
const slackSecrets = loadBundledChannelSecretContractApi("slack");

if (
  !googleChatSecrets?.collectRuntimeConfigAssignments ||
  !ircSecrets?.collectRuntimeConfigAssignments ||
  !slackSecrets?.collectRuntimeConfigAssignments
) {
  throw new Error("Missing channel secret contract api");
}

const googleChatAssignments = googleChatSecrets.collectRuntimeConfigAssignments;
const ircAssignments = ircSecrets.collectRuntimeConfigAssignments;
const slackAssignments = slackSecrets.collectRuntimeConfigAssignments;

function resolveAssignments(id: string) {
  if (id === "irc") {
    return ircAssignments;
  }
  if (id === "slack") {
    return slackAssignments;
  }
  if (id === "googlechat") {
    return googleChatAssignments;
  }
  return undefined;
}

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) => {
    const collectRuntimeConfigAssignments = resolveAssignments(id);
    return collectRuntimeConfigAssignments
      ? {
          secrets: { collectRuntimeConfigAssignments },
        }
      : undefined;
  },
  getBootstrapChannelSecrets: (id: string) => {
    const collectRuntimeConfigAssignments = resolveAssignments(id);
    return collectRuntimeConfigAssignments ? { collectRuntimeConfigAssignments } : undefined;
  },
}));
