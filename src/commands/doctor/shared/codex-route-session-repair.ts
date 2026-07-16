import fs from "node:fs";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { loadSessionStore, updateSessionStore } from "../../../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isValidAgentHarnessSessionStoreEntry } from "../../../sessions/agent-harness-session-key.js";
import {
  isOpenAICodexAuthProfileRef,
  isOpenAICodexModelRef,
  isProviderlessModelRef,
  normalizeRuntimeString,
  toCanonicalOpenAIModelRef,
  toOpenAIModelId,
} from "./codex-route-model-ref.js";
import type {
  CodexSessionRouteRepairSummary,
  SessionRouteRepairResult,
} from "./codex-route-types.js";

function rewriteSessionModelPair(params: {
  entry: SessionEntry;
  providerKey: "modelProvider" | "providerOverride";
  modelKey: "model" | "modelOverride";
}): boolean {
  let changed = false;
  const provider = normalizeString(params.entry[params.providerKey]);
  const model =
    typeof params.entry[params.modelKey] === "string" ? params.entry[params.modelKey] : undefined;
  if (provider === "openai-codex") {
    params.entry[params.providerKey] = "openai";
    if (model) {
      const modelId = toOpenAIModelId(model);
      if (modelId) {
        params.entry[params.modelKey] = modelId;
      }
    }
    return true;
  }
  if (model && isOpenAICodexModelRef(model)) {
    const canonicalModel = toCanonicalOpenAIModelRef(model);
    if (canonicalModel) {
      params.entry[params.modelKey] = canonicalModel;
      changed = true;
    }
  }
  return changed;
}

function clearStaleCodexFallbackNotice(entry: SessionEntry): boolean {
  if (
    !isOpenAICodexModelRef(entry.fallbackNoticeSelectedModel) &&
    !isOpenAICodexModelRef(entry.fallbackNoticeActiveModel)
  ) {
    return false;
  }
  delete entry.fallbackNoticeSelectedModel;
  delete entry.fallbackNoticeActiveModel;
  delete entry.fallbackNoticeReason;
  return true;
}

function clearStaleSessionRuntimePins(entry: SessionEntry): boolean {
  const harnessRuntime = normalizeRuntimeString(entry.agentHarnessId);
  const overrideRuntime = normalizeRuntimeString(entry.agentRuntimeOverride);
  let changed = false;
  if (entry.agentHarnessId !== undefined && harnessRuntime !== "openclaw") {
    delete entry.agentHarnessId;
    changed = true;
  }
  if (entry.agentRuntimeOverride !== undefined && overrideRuntime !== "openclaw") {
    delete entry.agentRuntimeOverride;
    changed = true;
  }
  return changed;
}

function repairProviderlessCodexSessionOverride(entry: SessionEntry): boolean {
  if (
    !isProviderlessModelRef(entry.modelOverride) ||
    !isOpenAICodexAuthProfileRef(entry.authProfileOverride) ||
    entry.authProfileOverrideSource !== "auto" ||
    entry.modelOverrideSource !== "auto" ||
    normalizeString(entry.providerOverride)
  ) {
    return false;
  }

  entry.providerOverride = "openai";
  if (entry.model !== undefined || entry.modelProvider !== undefined) {
    delete entry.model;
    delete entry.modelProvider;
  }
  if (entry.contextTokens !== undefined) {
    delete entry.contextTokens;
  }
  if (entry.contextBudgetStatus !== undefined) {
    delete entry.contextBudgetStatus;
  }
  return true;
}

/** Rewrite stale Codex model/provider/session runtime fields inside one session store object. */
function repairCodexSessionStoreRoutes(params: {
  store: Record<string, SessionEntry>;
  now?: number;
}): SessionRouteRepairResult {
  const now = params.now ?? Date.now();
  const sessionKeys: string[] = [];
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (!entry || isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
      continue;
    }
    const changedRuntimeModelRoute = rewriteSessionModelPair({
      entry,
      providerKey: "modelProvider",
      modelKey: "model",
    });
    const changedOverrideModelRoute = rewriteSessionModelPair({
      entry,
      providerKey: "providerOverride",
      modelKey: "modelOverride",
    });
    const changedProviderlessOverride = repairProviderlessCodexSessionOverride(entry);
    const changedModelRoute =
      changedRuntimeModelRoute || changedOverrideModelRoute || changedProviderlessOverride;
    const changedFallbackNotice = clearStaleCodexFallbackNotice(entry);
    const changedRuntimePins =
      changedModelRoute || changedFallbackNotice ? clearStaleSessionRuntimePins(entry) : false;
    if (!changedModelRoute && !changedFallbackNotice && !changedRuntimePins) {
      continue;
    }
    entry.updatedAt = now;
    sessionKeys.push(sessionKey);
  }
  return {
    changed: sessionKeys.length > 0,
    sessionKeys,
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.codexRouteSessionRepairTestApi")
  ] = { repairCodexSessionStoreRoutes };
}

function scanCodexSessionStoreRoutes(store: Record<string, SessionEntry>): string[] {
  return Object.entries(store).flatMap(([sessionKey, entry]) => {
    if (!entry || isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
      return [];
    }
    const hasLegacyRoute =
      normalizeString(entry.modelProvider) === "openai-codex" ||
      normalizeString(entry.providerOverride) === "openai-codex" ||
      isOpenAICodexModelRef(entry.model) ||
      isOpenAICodexModelRef(entry.modelOverride) ||
      (isProviderlessModelRef(entry.modelOverride) &&
        isOpenAICodexAuthProfileRef(entry.authProfileOverride) &&
        entry.authProfileOverrideSource === "auto" &&
        entry.modelOverrideSource === "auto" &&
        !normalizeString(entry.providerOverride)) ||
      isOpenAICodexModelRef(entry.fallbackNoticeSelectedModel) ||
      isOpenAICodexModelRef(entry.fallbackNoticeActiveModel);
    return hasLegacyRoute ? [sessionKey] : [];
  });
}

/** Scan or repair all configured agent session stores that still contain legacy Codex routes. */
export async function maybeRepairCodexSessionRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
}): Promise<CodexSessionRouteRepairSummary> {
  const targets = resolveAllAgentSessionStoreTargetsSync(params.cfg, {
    env: params.env ?? process.env,
  }).filter((target) => fs.existsSync(target.storePath));
  if (targets.length === 0) {
    return emptyRepairSummary();
  }
  if (!params.shouldRepair) {
    const stale = targets.flatMap((target) => {
      const sessionKeys = scanCodexSessionStoreRoutes(
        loadSessionStore(target.storePath, { skipCache: true, clone: false }),
      );
      return sessionKeys.map((sessionKey) => `${target.agentId}:${sessionKey}`);
    });
    return {
      scannedStores: targets.length,
      repairedStores: 0,
      repairedSessions: 0,
      warnings:
        stale.length > 0
          ? [
              [
                "- Legacy `openai-codex/*` session route state detected.",
                `- Affected sessions: ${stale.length}.`,
                "- Run `openclaw doctor --fix` to rewrite stale session model/provider pins across all agent session stores.",
              ].join("\n"),
            ]
          : [],
      changes: [],
    };
  }
  let repairedStores = 0;
  let repairedSessions = 0;
  for (const target of targets) {
    const staleSessionKeys = scanCodexSessionStoreRoutes(
      loadSessionStore(target.storePath, { skipCache: true, clone: false }),
    );
    if (staleSessionKeys.length === 0) {
      continue;
    }
    const result = await updateSessionStore(
      target.storePath,
      (store) => repairCodexSessionStoreRoutes({ store }),
      { skipMaintenance: true },
    );
    if (!result.changed) {
      continue;
    }
    repairedStores += 1;
    repairedSessions += result.sessionKeys.length;
  }
  return {
    scannedStores: targets.length,
    repairedStores,
    repairedSessions,
    warnings: [],
    changes:
      repairedSessions > 0
        ? [
            `Repaired Codex session routes: moved ${repairedSessions} session${
              repairedSessions === 1 ? "" : "s"
            } across ${repairedStores} store${repairedStores === 1 ? "" : "s"} to openai/* while preserving auth-profile pins.`,
          ]
        : [],
  };
}

function emptyRepairSummary(): CodexSessionRouteRepairSummary {
  return {
    scannedStores: 0,
    repairedStores: 0,
    repairedSessions: 0,
    warnings: [],
    changes: [],
  };
}
