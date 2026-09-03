import type { SessionEntry } from "../../config/sessions/types.js";

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
  sessionEntry?: ChatMetadataSessionEntry;
};

export type ChatMetadataResult = {
  commands?: unknown[];
  models?: unknown[];
  swarmEnabled: boolean;
};
