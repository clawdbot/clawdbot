import type { FastMode } from "@openclaw/normalization-core/string-coerce";
/** Parameter contracts shared by directive-only and fast-lane directive handlers. */
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "./directives.js";

/** Core directive handler inputs that do not depend on the inbound message shape. */
type HandleDirectiveOnlyCoreParams = {
  cfg: OpenClawConfig;
  directives: InlineDirectives;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures?: Array<{ gate: string; key: string }>;
  messageProviderKey?: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Awaited<
    ReturnType<typeof import("../../agents/model-catalog.js").loadModelCatalog>
  >;
  thinkingCatalog?: ModelCatalogEntry[];
  resetModelOverride: boolean;
  provider: string;
  model: string;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
};

/** Full directive-only command handler inputs. */
export type HandleDirectiveOnlyParams = HandleDirectiveOnlyCoreParams & {
  ctx?: MsgContext;
  messageProvider?: string;
  currentThinkLevel?: ThinkLevel;
  currentFastMode?: FastMode;
  currentVerboseLevel?: VerboseLevel;
  currentReasoningLevel?: ReasoningLevel;
  currentElevatedLevel?: ElevatedLevel;
  workspaceDir?: string;
  surface?: string;
  gatewayClientScopes?: string[];
  commandAuthorized?: boolean;
  senderIsOwner?: boolean;
  /** Internal handoff for mixed inline directives to avoid retrying rejected writes. */
  persistenceState?: { sessionChangesApplied: boolean };
};

/** Inputs for applying inline directives before the full reply run is prepared. */
export type ApplyInlineDirectivesFastLaneParams = HandleDirectiveOnlyCoreParams & {
  commandAuthorized: boolean;
  senderIsOwner: boolean;
  ctx: MsgContext;
  workspaceDir?: string;
  agentId?: string;
  isGroup: boolean;
  agentCfg?: NonNullable<OpenClawConfig["agents"]>["defaults"];
  modelState: {
    resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
    resolveThinkingCatalog: () => Promise<ModelCatalogEntry[] | undefined>;
    allowedModelKeys: Set<string>;
    allowedModelCatalog: Awaited<
      ReturnType<typeof import("../../agents/model-catalog.js").loadModelCatalog>
    >;
    resetModelOverride: boolean;
  };
};
