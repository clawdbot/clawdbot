import type { ChatAccountSelection } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";

export type ChatMetadataSessionEntry = Partial<
  Pick<
    SessionEntry,
    | "sessionId"
    | "agentHarnessId"
    | "modelSelectionLocked"
    | "pluginOwnerId"
    | "providerOverride"
    | "modelOverride"
    | "authProfileOverride"
    | "authProfileOverrideSource"
    | "authProfileOverrideCompactionCount"
  >
>;

export type ChatMetadataReadParams = {
  agentId: string;
  sessionKey?: string;
  requesterProfileId?: string;
  sessionEntry?: ChatMetadataSessionEntry;
  draftAccountSelection?: UserModelAccountSelection;
};

export type ChatMetadataResult = {
  commands?: unknown[];
  models?: unknown[];
  swarmEnabled: boolean;
  accountSelection?: ChatAccountSelection;
};
