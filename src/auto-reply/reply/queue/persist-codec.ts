import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../../agents/tool-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeCronScheduledToolPolicy } from "../../../cron/scheduled-tool-policy.js";
import { resolveWorkspaceSkillPromptEntries } from "../../../skills/loading/workspace-skill-loader.js";
import {
  hasInvalidInputProvenance,
  hasInvalidRestrictiveExecOverrides,
  hasInvalidSessionPermissionPolicy,
  persistedFollowupItemCarriesInboundContext,
  persistedInputProvenanceCarriesSourceIdentity,
  persistedRunCarriesRawChannelIdentity,
  projectCliSessionBindingFacts,
  projectInputProvenance,
  projectRestrictiveExecOverrides,
  projectSessionPermissionPair,
} from "./persist-codec-policy.js";
import type { FollowupQueueState, FollowupRun, QueueDropPolicy } from "./types.js";

/**
 * Minimal recovery descriptor for FollowupRun["run"]. Persisted fields are the
 * per-message routing and intent inputs that cannot be recovered any other
 * way after a restart. Bulky or secret-bearing runtime state (config,
 * skillsSnapshot, extraSystemPrompt[Static]) is intentionally excluded — the
 * dispatcher reassigns `run.config` via resolveQueuedReplyExecutionConfig on the
 * next turn. Routing selectors (authProfileId[Source], originatingReplyToId)
 * are persisted because restored turns need the same reply target they were
 * queued with. `inputProvenance` is persisted only as a closed non-authoritative
 * `{ kind, sourceChannel, sourceTool }` descriptor; `originSessionId` and
 * `sourceSessionKey` are never written and are stripped from older rows so
 * restore cannot reuse raw source-session identifiers for requester-policy.
 *
 * Session policy and prepared routing captured at admission (`toolOverrides`,
 * `conversationToolPolicy`, `requestedRouteResolution`, `thinkingCatalog`) plus
 * top-level `toolsAllow` / `disableTools` (and the non-enumerable allowlist
 * intersection carrier) are included so a restart cannot broaden tools or
 * re-resolve models away from the queued turn's intent. `permissionMode` and
 * `sessionRoot` are persisted as one closed pair so a session-scoped execution
 * restriction cannot fall back to the default policy after restart. Restore
 * rehydrates the pair together; a half-written or invalid pair fail-closes.
 * `scheduledToolPolicy` is persisted in its closed JSON shape so restored
 * cron/scheduled turns keep their restricted tool authority instead of falling
 * back to sender/group policy.
 *
 * `skillWorkshopProposalRevision` is persisted as a closed
 * `{ agentId, workspaceDir, proposalId, expectedRevisionHash }` envelope so an
 * operator-reviewed Workshop turn cannot lose its proposal/action restriction
 * or revision hash across restart. Invalid persisted constraints fail-close.
 *
 * Delegated live authority (`trustedInternalHandoff`, `runtimePluginToolGrant`)
 * is never serialized. Those queued turns are marked `delegatedAuthority` and
 * fail-closed on restore: copied fields cannot prove the originating claim is
 * still live after a Gateway restart, and draining without them would silently
 * change tool policy. The skip is logged and the SQLite row is dropped so the
 * non-delivery is durable. `terminalReplyExpectation` is persisted so a required
 * reply cannot become optional after restart. Invalid persisted values fail-close.
 *
 * `cliSessionBindingFacts` persists only delivery flags (`sourceReplyDeliveryMode`,
 * `requireExplicitMessageTarget`). Nested `extraSystemPromptStatic` is secret-bearing
 * and is never written; restore also strips it from older rows.
 *
 * Raw channel identities (`senderId`, `senderName`, `senderUsername`,
 * `senderE164`, `channelContext`) are never persisted. Those values are
 * requester-policy inputs, not a closed delivery descriptor; restore strips
 * them from older rows and rewrites SQLite so channel tool-policy cannot reuse
 * stored sender or open-ended transport metadata. Delivery stays on the closed
 * originating route (`originatingChannel` / `originatingTo`). Restored
 * identity-less entries drain individually so collect cannot merge distinct
 * senders that now share an empty authorization key.
 *
 * Sender privilege bits (`senderIsOwner`, `traceAuthorized`, `ownerNumbers`)
 * are never persisted. Restore always fences them to explicit non-owner so
 * owner-only tools cannot reopen from a stored true/undefined default.
 *
 * Exec elevation (`elevatedLevel`, `bashElevated`) and broadening overlays
 * (`security: "full"`, `ask: "off"`, `host: "gateway"|"node"`) are never
 * persisted. Restrictive `execOverrides` (`security: "deny"|"allowlist"`,
 * `ask: "always"|"on-miss"`, `host: "sandbox"`) persist as a closed projection
 * so restart cannot widen exec authority. Restore rehydrates that projection;
 * unknown keys or invalid values fail-close. `node` / `nodeCwd` are never
 * written (they retarget execution).
 *
 * Live client-bound facts (`clientCaps`, `toolBindings`, `approvalReviewerDeviceId`)
 * are never persisted. Restore strips them even from older rows so a queued
 * turn cannot target a stale browser or approval device after restart.
 *
 * Host-minted `memberRoleIds` are never serialized. Role-dependent queued work
 * is marked `roleDependent` and fail-closed on restore: channel roles cannot be
 * revalidated in this persist layer, and draining without them would silently
 * change role-gated authorization. The skip is logged and the SQLite row is
 * dropped so the non-delivery is durable.
 *
 * Use Pick (allowlist), not Omit, so new fields added to FollowupRun["run"]
 * default to NOT persisted until explicitly opted in.
 */
type PersistedRunFields = Pick<
  FollowupRun["run"],
  | "agentId"
  | "agentDir"
  | "sessionId"
  | "sessionKey"
  | "runtimePolicySessionKey"
  | "messageProvider"
  | "chatType"
  | "agentAccountId"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "spawnedBy"
  | "sessionFile"
  | "workspaceDir"
  | "cwd"
  | "permissionMode"
  | "sessionRoot"
  | "execOverrides"
  | "provider"
  | "model"
  | "hasSessionModelOverride"
  | "modelOverrideSource"
  | "hasAutoFallbackProvenance"
  | "autoFallbackPrimaryProbe"
  | "modelSelectionLocked"
  | "authProfileId"
  | "authProfileIdSource"
  | "toolOverrides"
  | "conversationToolPolicy"
  | "requestedRouteResolution"
  | "thinkingCatalog"
  | "scheduledToolPolicy"
  | "skillWorkshopProposalRevision"
  | "terminalReplyExpectation"
  | "thinkLevel"
  | "fastMode"
  | "fastModeAutoOnSeconds"
  | "fastModeOverride"
  | "fastModeAutoOnSecondsOverride"
  | "verboseLevel"
  | "reasoningLevel"
  | "timeoutMs"
  | "runTimeoutOverrideMs"
  | "blockReplyBreak"
  | "inputProvenance"
  | "sourceReplyDeliveryMode"
  | "taskSuggestionDeliveryMode"
  | "silentReplyPromptMode"
  | "cliSessionBindingFacts"
  | "enforceFinalTag"
  | "skipProviderRuntimeHints"
  | "silentExpected"
  | "allowEmptyAssistantReplyAsSilent"
  | "suppressNextUserMessagePersistence"
  | "suppressTranscriptOnlyAssistantPersistence"
>;

/**
 * Subset of FollowupRun that can be safely JSON-serialized across restarts.
 * Runtime-only fields (abortSignal, deliveryCorrelations, queuedLifecycle,
 * userTurnTranscriptRecorder, currentInboundContext) are intentionally excluded.
 * Bounded inbound flags (event kind, audio) are persisted so restored drains
 * keep routing shape; raw current-turn prompt context is never written and is
 * stripped from older rows.
 */
export type PersistedFollowupRun = Pick<
  FollowupRun,
  | "prompt"
  | "transcriptPrompt"
  | "messageId"
  | "summaryLine"
  | "enqueuedAt"
  | "imageOrder"
  | "media"
  | "currentInboundEventKind"
  | "currentInboundAudio"
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingThreadId"
  | "originatingReplyToId"
  | "originatingChatId"
  | "originatingReplyToMode"
  | "originatingChatType"
  | "disableCollectBatching"
  | "strandedReplyRetry"
  | "toolsAllow"
  | "disableTools"
  | "explicitSkillSelections"
> & {
  run: PersistedRunFields;
  /** Serializable form of the non-enumerable allowlist intersection carrier. */
  toolsAllowIntersection?: string[][];
  /**
   * True when the live run carried host-minted member roles. Restore fail-closes
   * these items instead of executing without role context or replaying stale IDs.
   */
  roleDependent?: true;
  /**
   * True when the live run carried delegated handoff or plugin-grant authority.
   * Restore fail-closes these items instead of replaying a copied claim.
   */
  delegatedAuthority?: true;
  /**
   * True when the live run was canceled before drain settled. Restore fail-closes
   * these items because abort signals are not serialized.
   */
  canceled?: true;
  /**
   * True when channel delivery already succeeded. Restore fail-closes these
   * items so a crash before the omit-ack cannot replay the follow-up.
   */
  delivered?: true;
  /**
   * True when execution finished but terminal delivery failed. Restore
   * fail-closes these items so a crash before omit cannot replay side effects.
   */
  discarded?: true;
  /**
   * True when the live run carried inline image payloads. Raw image bytes are
   * never written to shared SQLite; restore fail-closes marked items (and
   * legacy rows still carrying `images`) instead of replaying a turn whose
   * image content was deliberately not retained.
   */
  inlineImagesElided?: true;
};

type PersistedSummaryElision = {
  contextKey: string;
  count: number;
  sources: PersistedFollowupRun[];
  summaryLines: string[];
};

export type PersistedQueueEntry = {
  items: PersistedFollowupRun[];
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  summarySources?: PersistedFollowupRun[];
  summaryElisions?: PersistedSummaryElision[];
  evictedSummaryCount?: number;
  lastRun?: PersistedRunFields;
};

const PERSISTED_RUN_FIELDS = [
  "agentId",
  "agentDir",
  "sessionId",
  "sessionKey",
  "runtimePolicySessionKey",
  "messageProvider",
  "chatType",
  "agentAccountId",
  "groupId",
  "groupChannel",
  "groupSpace",
  "spawnedBy",
  "sessionFile",
  "workspaceDir",
  "cwd",
  "permissionMode",
  "sessionRoot",
  "execOverrides",
  "provider",
  "model",
  "hasSessionModelOverride",
  "modelOverrideSource",
  "hasAutoFallbackProvenance",
  "autoFallbackPrimaryProbe",
  "modelSelectionLocked",
  "authProfileId",
  "authProfileIdSource",
  "toolOverrides",
  "conversationToolPolicy",
  "requestedRouteResolution",
  "thinkingCatalog",
  "scheduledToolPolicy",
  "skillWorkshopProposalRevision",
  "terminalReplyExpectation",
  "thinkLevel",
  "fastMode",
  "fastModeAutoOnSeconds",
  "fastModeOverride",
  "fastModeAutoOnSecondsOverride",
  "verboseLevel",
  "reasoningLevel",
  "timeoutMs",
  "runTimeoutOverrideMs",
  "blockReplyBreak",
  "inputProvenance",
  "sourceReplyDeliveryMode",
  "taskSuggestionDeliveryMode",
  "silentReplyPromptMode",
  "cliSessionBindingFacts",
  "enforceFinalTag",
  "skipProviderRuntimeHints",
  "silentExpected",
  "allowEmptyAssistantReplyAsSilent",
  "suppressNextUserMessagePersistence",
  "suppressTranscriptOnlyAssistantPersistence",
] as const satisfies ReadonlyArray<keyof PersistedRunFields>;

function asWritableRecord(value: object): Record<string, unknown> {
  // SAFETY: persist copies JSON-shaped objects by closed allowlisted keys.
  return value as Record<string, unknown>;
}

function asCompletedPersistedRunFields(projected: Partial<PersistedRunFields>): PersistedRunFields {
  // SAFETY: every assigned key came from PERSISTED_RUN_FIELDS on a live FollowupRun.
  return projected as PersistedRunFields;
}

function projectRunForPersist(run: FollowupRun["run"]): PersistedRunFields {
  const projected: Partial<PersistedRunFields> = {};
  const writable = asWritableRecord(projected);
  // Project the closed pair before generic field filtering. A root-only live
  // run never visits permissionMode (value is undefined), so doing this inside
  // that iteration would drop sessionRoot and skip restore fail-closed.
  const sessionPermission = projectSessionPermissionPair(run);
  if (sessionPermission) {
    projected.permissionMode = sessionPermission.permissionMode;
    projected.sessionRoot = sessionPermission.sessionRoot;
  } else if (run.permissionMode !== undefined || run.sessionRoot !== undefined) {
    if (run.permissionMode !== undefined) {
      writable.permissionMode = run.permissionMode;
    }
    if (run.sessionRoot !== undefined) {
      writable.sessionRoot = run.sessionRoot;
    }
  }
  const restrictiveExecOverrides = projectRestrictiveExecOverrides(run.execOverrides);
  if (restrictiveExecOverrides) {
    projected.execOverrides = restrictiveExecOverrides;
  } else if (hasInvalidRestrictiveExecOverrides(run) && run.execOverrides !== undefined) {
    writable.execOverrides = run.execOverrides;
  }
  for (const key of PERSISTED_RUN_FIELDS) {
    if (key === "permissionMode" || key === "sessionRoot" || key === "execOverrides") {
      continue;
    }
    const value = run[key];
    if (value !== undefined) {
      // Field-by-field copy keeps each value in its source type without
      // forcing a single union onto the projected map's index type.
      if (key === "scheduledToolPolicy") {
        // Persist the closed envelope when valid. Keep a non-normalizable value
        // as-is so restore fail-closes instead of dropping the authority field.
        writable[key] = normalizeCronScheduledToolPolicy(value) ?? value;
        continue;
      }
      if (key === "skillWorkshopProposalRevision") {
        writable[key] = projectSkillWorkshopProposalRevision(value) ?? value;
        continue;
      }
      if (key === "terminalReplyExpectation") {
        writable[key] = projectTerminalReplyExpectation(value) ?? value;
        continue;
      }
      if (key === "inputProvenance") {
        writable[key] = projectInputProvenance(value) ?? value;
        continue;
      }
      if (key === "cliSessionBindingFacts") {
        const projectedFacts = projectCliSessionBindingFacts(run.cliSessionBindingFacts);
        if (projectedFacts) {
          projected.cliSessionBindingFacts = projectedFacts;
        }
        continue;
      }
      writable[key] = value;
    }
  }
  return asCompletedPersistedRunFields(projected);
}

export function isPersistedRunFields(value: unknown): value is PersistedRunFields {
  return (
    isRecord(value) &&
    typeof value.agentId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.sessionFile === "string" &&
    typeof value.workspaceDir === "string" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.timeoutMs === "number" &&
    (value.blockReplyBreak === "text_end" || value.blockReplyBreak === "message_end")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isToolsAllowIntersection(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every(isStringArray);
}

function parseToolsAllowIntersection(value: unknown): string[][] | undefined {
  return isToolsAllowIntersection(value) ? value.map((group) => group.slice()) : undefined;
}

function isPersistedFollowupRun(value: unknown): value is PersistedFollowupRun {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    typeof value.enqueuedAt === "number" &&
    isPersistedRunFields(value.run) &&
    (value.toolsAllow === undefined || isStringArray(value.toolsAllow)) &&
    (value.disableTools === undefined || typeof value.disableTools === "boolean") &&
    (value.toolsAllowIntersection === undefined ||
      isToolsAllowIntersection(value.toolsAllowIntersection)) &&
    (value.roleDependent === undefined || value.roleDependent === true) &&
    (value.delegatedAuthority === undefined || value.delegatedAuthority === true) &&
    (value.canceled === undefined || value.canceled === true) &&
    (value.delivered === undefined || value.delivered === true) &&
    (value.discarded === undefined || value.discarded === true) &&
    (value.explicitSkillSelections === undefined || Array.isArray(value.explicitSkillSelections))
  );
}

function isPersistedSummaryElision(value: unknown): value is PersistedSummaryElision {
  return (
    isRecord(value) &&
    typeof value.contextKey === "string" &&
    typeof value.count === "number" &&
    Array.isArray(value.sources) &&
    value.sources.every(isPersistedFollowupRun) &&
    Array.isArray(value.summaryLines) &&
    value.summaryLines.every((line) => typeof line === "string")
  );
}

export function isPersistedQueueEntry(value: unknown): value is PersistedQueueEntry {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isPersistedFollowupRun)
  ) {
    return false;
  }
  if (
    value.summarySources !== undefined &&
    (!Array.isArray(value.summarySources) || !value.summarySources.every(isPersistedFollowupRun))
  ) {
    return false;
  }
  if (
    value.summaryElisions !== undefined &&
    (!Array.isArray(value.summaryElisions) ||
      !value.summaryElisions.every(isPersistedSummaryElision))
  ) {
    return false;
  }
  if (value.evictedSummaryCount !== undefined && typeof value.evictedSummaryCount !== "number") {
    return false;
  }
  return true;
}

/**
 * Drop restored items that cannot be safely reassociated with a session/route.
 * Keeps process-local and incomplete descriptors from hijacking the wrong delivery.
 */
function hasLegacyMemberRoleIds(run: PersistedRunFields): boolean {
  const ids = asWritableRecord(run).memberRoleIds;
  return Array.isArray(ids) && ids.length > 0;
}

export function isRoleDependentPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.roleDependent === true || hasLegacyMemberRoleIds(item.run);
}

function hasLegacyDelegatedAuthority(run: PersistedRunFields): boolean {
  const record = asWritableRecord(run);
  return record.trustedInternalHandoff !== undefined || record.runtimePluginToolGrant !== undefined;
}

export function isDelegatedAuthorityPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.delegatedAuthority === true || hasLegacyDelegatedAuthority(item.run);
}

export function isCanceledPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.canceled === true;
}

export function isDeliveredPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.delivered === true;
}

export function isDiscardedPersistedFollowup(item: PersistedFollowupRun): boolean {
  return item.discarded === true;
}

export function describeFollowupForLog(item: PersistedFollowupRun): string {
  const parts: string[] = [];
  if (typeof item.messageId === "string" && item.messageId.length > 0) {
    parts.push(`messageId=${item.messageId}`);
  }
  if (typeof item.originatingChannel === "string" && item.originatingChannel.length > 0) {
    parts.push(`channel=${item.originatingChannel}`);
  }
  return parts.length > 0 ? parts.join(" ") : "no-route-metadata";
}

const MAX_EXPLICIT_SKILL_SELECTIONS = 32;
const MAX_EXPLICIT_SKILL_NAME_LENGTH = 128;
const MAX_EXPLICIT_SKILL_PATH_LENGTH = 1024;

export type RestoredExplicitSkillSelections = NonNullable<FollowupRun["explicitSkillSelections"]>;
export type ExplicitSkillRestoreResolution =
  | { status: "absent" }
  | { status: "ok"; selections: RestoredExplicitSkillSelections }
  | { status: "invalid" };

function comparableSkillPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function projectExplicitSkillSelections(
  value: unknown,
): RestoredExplicitSkillSelections | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXPLICIT_SKILL_SELECTIONS) {
    return undefined;
  }
  const projected: RestoredExplicitSkillSelections = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const name = normalizeOptionalString(entry.name);
    const skillPath = normalizeOptionalString(entry.path);
    if (
      !name ||
      !skillPath ||
      name.length > MAX_EXPLICIT_SKILL_NAME_LENGTH ||
      skillPath.length > MAX_EXPLICIT_SKILL_PATH_LENGTH
    ) {
      return undefined;
    }
    projected.push({ name, path: skillPath });
  }
  return projected;
}

export function createExplicitSkillRestoreResolver(
  currentConfig: OpenClawConfig,
): (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution {
  const catalogs = new Map<string, Array<{ name: string; path: string }> | null>();
  const loadCatalog = (workspaceDir: string, agentId: string | undefined) => {
    const key = `${workspaceDir}\0${agentId ?? ""}`;
    if (catalogs.has(key)) {
      return catalogs.get(key) ?? null;
    }
    try {
      const eligible = resolveWorkspaceSkillPromptEntries(workspaceDir, {
        config: currentConfig,
        agentId,
      }).eligible.map((entry) => ({
        name: entry.skill.name,
        path: entry.skill.filePath,
      }));
      catalogs.set(key, eligible);
      return eligible;
    } catch {
      catalogs.set(key, null);
      return null;
    }
  };

  return (item: PersistedFollowupRun): ExplicitSkillRestoreResolution => {
    if (item.explicitSkillSelections === undefined) {
      return { status: "absent" };
    }
    const projected = projectExplicitSkillSelections(item.explicitSkillSelections);
    if (!projected) {
      return { status: "invalid" };
    }
    const workspaceDir = normalizeOptionalString(item.run.workspaceDir);
    if (!workspaceDir) {
      return { status: "invalid" };
    }
    const catalog = loadCatalog(workspaceDir, normalizeOptionalString(item.run.agentId));
    if (!catalog) {
      return { status: "invalid" };
    }
    const resolved: RestoredExplicitSkillSelections = [];
    for (const selection of projected) {
      const selectedPath = comparableSkillPath(selection.path);
      const skill = catalog.find(
        (candidate) => comparableSkillPath(candidate.path) === selectedPath,
      );
      if (!skill) {
        return { status: "invalid" };
      }
      resolved.push({ name: skill.name, path: skill.path });
    }
    return { status: "ok", selections: resolved };
  };
}

export function hasInvalidExplicitSkillSelections(
  item: PersistedFollowupRun,
  resolveExplicitSkillSelections: (item: PersistedFollowupRun) => ExplicitSkillRestoreResolution,
): boolean {
  return resolveExplicitSkillSelections(item).status === "invalid";
}

export function hasInvalidScheduledToolPolicy(run: PersistedRunFields): boolean {
  return (
    run.scheduledToolPolicy !== undefined &&
    normalizeCronScheduledToolPolicy(run.scheduledToolPolicy) === undefined
  );
}

export {
  hasInvalidInputProvenance,
  hasInvalidRestrictiveExecOverrides,
  hasInvalidSessionPermissionPolicy,
  persistedFollowupItemCarriesInboundContext,
  persistedInputProvenanceCarriesSourceIdentity,
  persistedRunCarriesRawChannelIdentity,
};

const SKILL_WORKSHOP_REVISION_HASH = /^[0-9a-f]{64}$/i;

function projectSkillWorkshopProposalRevision(
  value: unknown,
): FollowupRun["run"]["skillWorkshopProposalRevision"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const agentId = normalizeOptionalString(value.agentId);
  const workspaceDir = normalizeOptionalString(value.workspaceDir);
  const proposalId = normalizeOptionalString(value.proposalId);
  const expectedRevisionHash = normalizeOptionalString(value.expectedRevisionHash);
  if (!agentId || !workspaceDir || !proposalId || !expectedRevisionHash) {
    return undefined;
  }
  if (!SKILL_WORKSHOP_REVISION_HASH.test(expectedRevisionHash)) {
    return undefined;
  }
  return { agentId, workspaceDir, proposalId, expectedRevisionHash };
}

export function hasInvalidSkillWorkshopProposalRevision(run: PersistedRunFields): boolean {
  return (
    run.skillWorkshopProposalRevision !== undefined &&
    projectSkillWorkshopProposalRevision(run.skillWorkshopProposalRevision) === undefined
  );
}

function projectTerminalReplyExpectation(
  value: unknown,
): FollowupRun["run"]["terminalReplyExpectation"] | undefined {
  return value === "required" || value === "optional" ? value : undefined;
}

export function hasInvalidTerminalReplyExpectation(run: PersistedRunFields): boolean {
  return (
    run.terminalReplyExpectation !== undefined &&
    projectTerminalReplyExpectation(run.terminalReplyExpectation) === undefined
  );
}

export function hasInvalidToolsAllowIntersection(item: PersistedFollowupRun): boolean {
  return item.toolsAllowIntersection !== undefined && item.toolsAllow === undefined;
}

const LEGACY_PERSISTED_RUN_OVERLAYS = [
  "memberRoleIds",
  "elevatedLevel",
  "bashElevated",
  "clientCaps",
  "toolBindings",
  "approvalReviewerDeviceId",
  "trustedInternalHandoff",
  "runtimePluginToolGrant",
  "senderId",
  "senderName",
  "senderUsername",
  "senderE164",
  "channelContext",
] as const;

/** Closed envelopes are re-projected; raw values must not leak through `...rest`. */
const CLOSED_PERSISTED_RUN_FIELDS = [
  "permissionMode",
  "sessionRoot",
  "execOverrides",
  "scheduledToolPolicy",
  "skillWorkshopProposalRevision",
  "terminalReplyExpectation",
  "inputProvenance",
  "cliSessionBindingFacts",
] as const;

export function rehydrateRun(
  run: PersistedRunFields,
  currentConfig: OpenClawConfig,
): FollowupRun["run"] {
  const rest: PersistedRunFields = { ...run };
  const overlays = asWritableRecord(rest);
  for (const key of LEGACY_PERSISTED_RUN_OVERLAYS) {
    delete overlays[key];
  }
  const sessionPermission = projectSessionPermissionPair(rest);
  const execOverrides = projectRestrictiveExecOverrides(rest.execOverrides);
  const scheduledToolPolicy = normalizeCronScheduledToolPolicy(rest.scheduledToolPolicy);
  const skillWorkshopProposalRevision = projectSkillWorkshopProposalRevision(
    rest.skillWorkshopProposalRevision,
  );
  const terminalReplyExpectation = projectTerminalReplyExpectation(rest.terminalReplyExpectation);
  const inputProvenance = projectInputProvenance(rest.inputProvenance);
  const cliSessionBindingFacts = projectCliSessionBindingFacts(rest.cliSessionBindingFacts);
  for (const key of CLOSED_PERSISTED_RUN_FIELDS) {
    delete overlays[key];
  }
  return {
    ...rest,
    config: currentConfig,
    // Owner-only conversation tools deny only explicit false. Fence privilege
    // bits even if an older SQLite row still serialized them.
    senderIsOwner: false,
    traceAuthorized: false,
    ownerNumbers: [],
    ...(sessionPermission
      ? {
          permissionMode: sessionPermission.permissionMode,
          sessionRoot: sessionPermission.sessionRoot,
        }
      : {}),
    ...(execOverrides ? { execOverrides } : {}),
    ...(scheduledToolPolicy ? { scheduledToolPolicy } : {}),
    ...(skillWorkshopProposalRevision ? { skillWorkshopProposalRevision } : {}),
    ...(terminalReplyExpectation ? { terminalReplyExpectation } : {}),
    ...(inputProvenance ? { inputProvenance } : {}),
    ...(cliSessionBindingFacts
      ? { cliSessionBindingFacts }
      : { cliSessionBindingFacts: undefined }),
  };
}
function toPersistedRun(item: FollowupRun): PersistedFollowupRun {
  const toolsAllowIntersection = item.toolsAllow
    ? readToolAllowlistIntersection(item.toolsAllow)
    : undefined;
  const explicitSkillSelections = projectExplicitSkillSelections(item.explicitSkillSelections);
  const carriesInlineImages = (item.images?.length ?? 0) > 0;
  return {
    prompt: item.prompt,
    ...(item.transcriptPrompt !== undefined ? { transcriptPrompt: item.transcriptPrompt } : {}),
    ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
    ...(item.summaryLine !== undefined ? { summaryLine: item.summaryLine } : {}),
    enqueuedAt: item.enqueuedAt,
    // Inline image bytes never reach shared SQLite; the marker fail-closes on
    // restore instead of retaining payload content across restarts.
    ...(carriesInlineImages ? { inlineImagesElided: true as const } : {}),
    ...(!carriesInlineImages && item.imageOrder !== undefined
      ? { imageOrder: item.imageOrder }
      : {}),
    ...(item.media !== undefined ? { media: item.media } : {}),
    ...(item.currentInboundEventKind !== undefined
      ? { currentInboundEventKind: item.currentInboundEventKind }
      : {}),
    ...(item.currentInboundAudio === true ? { currentInboundAudio: true } : {}),
    ...(item.originatingChannel !== undefined
      ? { originatingChannel: item.originatingChannel }
      : {}),
    ...(item.originatingTo !== undefined ? { originatingTo: item.originatingTo } : {}),
    ...(item.originatingAccountId !== undefined
      ? { originatingAccountId: item.originatingAccountId }
      : {}),
    ...(item.originatingThreadId !== undefined
      ? { originatingThreadId: item.originatingThreadId }
      : {}),
    ...(item.originatingReplyToId !== undefined
      ? { originatingReplyToId: item.originatingReplyToId }
      : {}),
    ...(item.originatingChatId !== undefined ? { originatingChatId: item.originatingChatId } : {}),
    ...(item.originatingReplyToMode !== undefined
      ? { originatingReplyToMode: item.originatingReplyToMode }
      : {}),
    ...(item.originatingChatType !== undefined
      ? { originatingChatType: item.originatingChatType }
      : {}),
    ...(item.disableCollectBatching === true ? { disableCollectBatching: true } : {}),
    ...(item.strandedReplyRetry === true ? { strandedReplyRetry: true } : {}),
    ...(item.toolsAllow !== undefined ? { toolsAllow: [...item.toolsAllow] } : {}),
    ...(item.disableTools === true ? { disableTools: true } : {}),
    ...(explicitSkillSelections ? { explicitSkillSelections } : {}),
    ...(toolsAllowIntersection
      ? { toolsAllowIntersection: toolsAllowIntersection.map((group) => group.slice()) }
      : {}),
    ...(Array.isArray(item.run.memberRoleIds) && item.run.memberRoleIds.length > 0
      ? { roleDependent: true as const }
      : {}),
    ...(item.run.trustedInternalHandoff !== undefined ||
    item.run.runtimePluginToolGrant !== undefined
      ? { delegatedAuthority: true as const }
      : {}),
    ...(item.canceled === true ? { canceled: true as const } : {}),
    ...(item.delivered === true ? { delivered: true as const } : {}),
    ...(item.discarded === true ? { discarded: true as const } : {}),
    run: projectRunForPersist(item.run),
  };
}

export function toPersistedQueueEntry(queue: FollowupQueueState): PersistedQueueEntry {
  return {
    // Keep in-flight identities in SQLite until channel delivery succeeds (or
    // fail-closed discard). Memory inFlight is overflow protection only.
    items: queue.items.map(toPersistedRun),
    lastEnqueuedAt: queue.lastEnqueuedAt,
    mode: queue.mode,
    debounceMs: queue.debounceMs,
    cap: queue.cap,
    dropPolicy: queue.dropPolicy,
    droppedCount: queue.droppedCount,
    summaryLines: queue.summaryLines,
    summarySources: queue.summarySources.map(toPersistedRun),
    summaryElisions: queue.summaryElisions.map((entry) => ({
      contextKey: entry.contextKey,
      count: entry.count,
      sources: entry.sources.map(toPersistedRun),
      summaryLines: entry.summaryLines,
    })),
    evictedSummaryCount: queue.evictedSummaryCount,
    ...(queue.lastRun !== undefined ? { lastRun: projectRunForPersist(queue.lastRun) } : {}),
  };
}

export function rehydratePersistedFollowupRun(
  persisted: PersistedFollowupRun,
  currentConfig: OpenClawConfig,
  explicitSkillSelections?: RestoredExplicitSkillSelections,
): FollowupRun {
  const {
    toolsAllowIntersection: persistedIntersection,
    roleDependent: _roleDependent,
    delegatedAuthority: _delegatedAuthority,
    canceled: _canceled,
    delivered: _delivered,
    discarded: _discarded,
    inlineImagesElided: _inlineImagesElided,
    explicitSkillSelections: _persistedSkillSelections,
    ...rest
  } = persisted;
  delete asWritableRecord(rest).currentInboundContext;
  // Image-bearing rows fail-close before rehydrate; strip legacy payloads
  // defensively so raw bytes can never flow into a restored run.
  delete asWritableRecord(rest).images;
  const restored: FollowupRun = {
    ...rest,
    run: rehydrateRun(persisted.run, currentConfig),
  };
  // Restore always drops raw sender identity. Collect grouping still keys on
  // those fields, so identity-less entries must not share a batch.
  restored.disableCollectBatching = true;
  if (explicitSkillSelections) {
    restored.explicitSkillSelections = explicitSkillSelections;
  }
  if (restored.toolsAllow) {
    restored.toolsAllow = [...restored.toolsAllow];
    const intersection = parseToolsAllowIntersection(persistedIntersection);
    if (intersection) {
      attachToolAllowlistIntersection(restored.toolsAllow, intersection);
    }
  }
  return restored;
}
