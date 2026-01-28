import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";

import type { MoltbotConfig } from "../../config/config.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { setCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import { setContextPruningRuntime } from "../pi-extensions/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-extensions/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-extensions/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

function resolvePiExtensionPath(id: string): string {
  const self = fileURLToPath(import.meta.url);
  const dir = path.dirname(self);
  // In dev this file is `.ts` (tsx), in production it's `.js`.
  const ext = path.extname(self) === ".ts" ? "ts" : "js";
  return path.join(dir, "..", "pi-extensions", `${id}.${ext}`);
}

function resolveContextWindowTokens(params: {
  cfg: MoltbotConfig | undefined;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    modelContextWindow: params.model?.contextWindow,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  }).tokens;
}

function buildContextPruningExtension(params: {
  cfg: MoltbotConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): { additionalExtensionPaths?: string[] } {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") return {};
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) return {};

  const settings = computeEffectiveSettings(raw);
  if (!settings) return {};

  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens: resolveContextWindowTokens(params),
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager),
  });

  return {
    additionalExtensionPaths: [resolvePiExtensionPath("context-pruning")],
  };
}

function resolveCompactionMode(cfg?: MoltbotConfig): "default" | "safeguard" {
  return cfg?.agents?.defaults?.compaction?.mode === "safeguard" ? "safeguard" : "default";
}

export function buildEmbeddedExtensionPaths(params: {
  cfg: MoltbotConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: Model<Api> | undefined;
}): string[] {
  const paths: string[] = [];
  if (resolveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
    });
    paths.push(resolvePiExtensionPath("compaction-safeguard"));
  }
  const pruning = buildContextPruningExtension(params);
  if (pruning.additionalExtensionPaths) {
    paths.push(...pruning.additionalExtensionPaths);
  }
  return paths;
}

export { ensurePiCompactionReserveTokens };
