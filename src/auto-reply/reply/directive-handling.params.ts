import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { AgentModelPrimaryWriteTarget } from "../../agents/agent-scope.js";
/** Parameter contracts for the canonical directive transaction handler. */
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { ModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
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
  policyAliasIndex?: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  modelPolicy?: ModelVisibilityPolicy;
  allowedModelCatalog: Awaited<
    ReturnType<typeof import("../../agents/prepared-model-catalog.js").loadPreparedModelCatalog>
  >;
  thinkingCatalog?: ModelCatalogEntry[];
  resetModelOverride: boolean;
  provider: string;
  model: string;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  canPersistStickyModelSelection?: boolean;
  stickyModelSelectionTarget?: AgentModelPrimaryWriteTarget;
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
  /** Mixed messages consume the transaction outcome without repeating persistence. */
  persistenceState?: {
    outcome:
      | {
          kind: "pending" | "applied";
          provider: string;
          model: string;
          modelCatalog?: ModelCatalogEntry[];
        }
      | { kind: "rejected"; errorText: string };
  };
};
