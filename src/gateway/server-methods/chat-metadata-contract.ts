import type { ChatAccountSelection } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";

export type ChatMetadataSessionEntry = {
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user" | "user-link";
  authProfileOverrideCompactionCount?: number;
};

export type ChatMetadataReadParams = {
  agentId: string;
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
