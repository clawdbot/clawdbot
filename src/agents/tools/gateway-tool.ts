import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { parseConfigJson5, resolveConfigSnapshotHash } from "../../config/io.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildRestartSuccessContinuation,
  formatDoctorNonInteractiveHint,
  removeRestartSentinelFile,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { collectEnabledInsecureOrDangerousFlags } from "../../security/dangerous-config-flags.js";
import { normalizeOptionalString, readStringValue } from "../../shared/string-coerce.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { isOpenClawOwnerOnlyCoreToolName } from "./owner-only-tools.js";

const log = createSubsystemLogger("gateway-tool");

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;
// Security: the agent-facing `gateway` tool is owner-only, but per SECURITY.md the model/agent
// itself is not a trusted principal. `assertGatewayConfigMutationAllowed` is the explicit
// model -> operator trust-boundary control on `config.apply`/`config.patch`, so the runtime
// tool must fail closed and allow only a narrow set of agent-tunable paths.
const ALLOWED_GATEWAY_CONFIG_PATHS = [
  // Agent prompt/model tuning.
  "agents.defaults.systemPromptOverride",
  "agents.defaults.promptOverlays",
  "agents.defaults.model",
  "agents.defaults.thinkingDefault",
  "agents.defaults.subagents.thinking",
  "agents.defaults.reasoningDefault",
  "agents.defaults.fastModeDefault",
  "agents.list[].id",
  "agents.list[].systemPromptOverride",
  "agents.list[].model",
  "agents.list[].thinkingDefault",
  "agents.list[].subagents.thinking",
  "agents.list[].reasoningDefault",
  "agents.list[].fastModeDefault",
  // Mention gating is an agent-facing scope knob across channel adapters.
  // Depths here must cover the deepest `requireMention` path the channel
  // adapters use today — Telegram topic overrides live at
  // `channels.telegram.groups.<group>.topics.<topic>.requireMention`.
  "channels.*.requireMention",
  "channels.*.*.requireMention",
  "channels.*.*.*.requireMention",
  "channels.*.*.*.*.requireMention",
  "channels.*.*.*.*.*.requireMention",
  // Visible reply delivery mode is a bounded message UX setting, not a secret
  // or privilege boundary. Let agents repair silent group/channel rooms.
  "messages.visibleReplies",
  "messages.groupChat.visibleReplies",
  "messages.groupChat.unmentionedInbound",
] as const;

/** @internal Exposed for regression tests only; do not import from runtime code. */
export const ALLOWED_GATEWAY_CONFIG_PATHS_FOR_TEST = ALLOWED_GATEWAY_CONFIG_PATHS;

/** @internal Exposed for regression tests only; do not import from runtime code. */
export function assertGatewayConfigMutationAllowedForTest(params: {
  action: "config.apply" | "config.patch";
  currentConfig: Record<string, unknown>;
  raw: string;
}): void {
  assertGatewayConfigMutationAllowed(params);
}

function resolveBaseHashFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const hashValue = (snapshot as { hash?: unknown }).hash;
  const rawValue = (snapshot as { raw?: unknown }).raw;
  const hash = resolveConfigSnapshotHash({
    hash: readStringValue(hashValue),
    raw: readStringValue(rawValue),
  });
  return hash ?? undefined;
}

function getSnapshotConfig(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("config.get response is not an object.");
  }
  const config = (snapshot as { config?: unknown }).config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config.get response is missing a config object.");
  }
  return config as Record<string, unknown>;
}

// Direct RPC callers need the validated config echoed after writes; the
// agent-facing gateway tool does not, and replaying it bloats transcripts.
function stripConfigWriteResultPayload(result: unknown): unknown {
  if (!isPlainObject(result) || !Object.hasOwn(result, "config")) {
    return result;
  }
  const stripped = { ...result };
  delete stripped.config;
  return stripped;
}

function parseGatewayConfigMutationRaw(
  raw: string,
  action: "config.apply" | "config.patch",
): unknown {
  const parsedRes = parseConfigJson5(raw);
  if (!parsedRes.ok) {
    throw new Error(parsedRes.error);
  }
  if (
    !parsedRes.parsed ||
    typeof parsedRes.parsed !== "object" ||
    Array.isArray(parsedRes.parsed)
  ) {
    throw new Error(`${action} raw must be an object.`);
  }
  return parsedRes.parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeGatewayConfigPath(path: string): string {
  return path.startsWith("tools.bash.") ? path.replace(/^tools\.bash\./, "tools.exec.") : path;
}

function readKeyedArrayEntries(list: unknown): {
  duplicateIds: boolean;
  entries: Map<string, unknown>;
  hasUnkeyedEntries: boolean;
} | null {
  if (!Array.isArray(list)) {
    return null;
  }

  let duplicateIds = false;
  let hasUnkeyedEntries = false;
  const entries = new Map<string, unknown>();
  for (const entry of list) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      hasUnkeyedEntries = true;
      continue;
    }
    if (entries.has(entry.id)) {
      duplicateIds = true;
      continue;
    }
    entries.set(entry.id, entry);
  }
  return { duplicateIds, entries, hasUnkeyedEntries };
}

function collectConfigLeafPaths(value: unknown, basePath: string, out: Set<string>): void {
  const canonicalPath = normalizeGatewayConfigPath(basePath);
  if (value === undefined) {
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  if (Array.isArray(value)) {
    const keyedEntries = readKeyedArrayEntries(value);
    if (
      keyedEntries &&
      !keyedEntries.duplicateIds &&
      !keyedEntries.hasUnkeyedEntries &&
      keyedEntries.entries.size > 0
    ) {
      for (const entryValue of keyedEntries.entries.values()) {
        collectConfigLeafPaths(entryValue, `${basePath}[]`, out);
      }
      return;
    }
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  if (!isPlainObject(value)) {
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    if (canonicalPath) {
      out.add(canonicalPath);
    }
    return;
  }

  for (const [key, child] of entries) {
    collectConfigLeafPaths(child, basePath ? `${basePath}.${key}` : key, out);
  }
}

function collectChangedConfigPaths(
  currentValue: unknown,
  nextValue: unknown,
  basePath = "",
  out = new Set<string>(),
): Set<string> {
  if (isDeepStrictEqual(currentValue, nextValue)) {
    return out;
  }

  if (currentValue === undefined || nextValue === undefined) {
    collectConfigLeafPaths(currentValue ?? nextValue, basePath, out);
    return out;
  }

  if (Array.isArray(currentValue) || Array.isArray(nextValue)) {
    if (!Array.isArray(currentValue) || !Array.isArray(nextValue)) {
      collectConfigLeafPaths(currentValue, basePath, out);
      collectConfigLeafPaths(nextValue, basePath, out);
      return out;
    }

    const currentEntries = readKeyedArrayEntries(currentValue);
    const nextEntries = readKeyedArrayEntries(nextValue);
    if (
      !currentEntries ||
      !nextEntries ||
      currentEntries.duplicateIds ||
      nextEntries.duplicateIds ||
      currentEntries.hasUnkeyedEntries ||
      nextEntries.hasUnkeyedEntries
    ) {
      out.add(normalizeGatewayConfigPath(basePath));
      return out;
    }

    const ids = new Set([...currentEntries.entries.keys(), ...nextEntries.entries.keys()]);
    for (const id of ids) {
      collectChangedConfigPaths(
        currentEntries.entries.get(id),
        nextEntries.entries.get(id),
        `${basePath}[]`,
        out,
      );
    }
    return out;
  }

  if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
    const keys = new Set([...Object.keys(currentValue), ...Object.keys(nextValue)]);
    for (const key of keys) {
      collectChangedConfigPaths(
        currentValue[key],
        nextValue[key],
        basePath ? `${basePath}.${key}` : key,
        out,
      );
    }
    return out;
  }

  out.add(normalizeGatewayConfigPath(basePath));
  return out;
}

function pathSegmentMatches(patternSegment: string, pathSegment: string): boolean {
  return patternSegment === "*" || patternSegment === pathSegment;
}

function isAllowedGatewayConfigPath(path: string): boolean {
  const pathSegments = path.split(".");
  return ALLOWED_GATEWAY_CONFIG_PATHS.some((pattern) => {
    const patternSegments = pattern.split(".");
    if (patternSegments.length > pathSegments.length) {
      return false;
    }
    for (let i = 0; i < patternSegments.length; i += 1) {
      if (!pathSegmentMatches(patternSegments[i], pathSegments[i])) {
        return false;
      }
    }
    return true;
  });
}

function assertGatewayConfigMutationAllowed(params: {
  action: "config.apply" | "config.patch";
  currentConfig: Record<string, unknown>;
  raw: string;
}): void {
  const parsed = parseGatewayConfigMutationRaw(params.raw, params.action);
  const nextConfig =
    params.action === "config.apply"
      ? (parsed as Record<string, unknown>)
      : (applyMergePatch(params.currentConfig, parsed, {
          mergeObjectArraysById: true,
        }) as Record<string, unknown>);
  const changedPaths = [...collectChangedConfigPaths(params.currentConfig, nextConfig)].toSorted();
  const disallowedPaths = changedPaths.filter((path) => !isAllowedGatewayConfigPath(path));
  if (disallowedPaths.length > 0) {
    throw new Error(
      `gateway ${params.action} cannot change protected config paths: ${disallowedPaths.join(", ")}`,
    );
  }

  // Block writes that newly enable any dangerous config flag.
  // Uses the same flag enumeration as `openclaw security audit`.
  const currentFlags = new Set(
    collectEnabledInsecureOrDangerousFlags(params.currentConfig as OpenClawConfig),
  );
  const nextFlags = collectEnabledInsecureOrDangerousFlags(nextConfig as OpenClawConfig);
  const newlyEnabled = nextFlags.filter((f) => !currentFlags.has(f));
  if (newlyEnabled.length > 0) {
    throw new Error(
      `gateway ${params.action} cannot enable dangerous config flags: ${newlyEnabled.join(", ")}`,
    );
  }
}

const GATEWAY_ACTIONS = [
  "restart",
  "config.get",
  "config.schema.lookup",
  "config.apply",
  "config.patch",
  "update.run",
] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  // restart
  delayMs: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  continuationMessage: Type.Optional(Type.String()),
  // config.get, config.schema.lookup, config.apply, update.run
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  // config.schema.lookup
  path: Type.Optional(Type.String()),
  // config.apply, config.patch
  raw: Type.Optional(Type.String()),
  baseHash: Type.Optional(Type.String()),
  // config.apply, config.patch, update.run
  sessionKey: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  restartDelayMs: Type.Optional(Type.Number()),
});
// NOTE: We intentionally avoid top-level `allOf`/`anyOf`/`oneOf` conditionals here:
// - OpenAI rejects tool schemas that include these keywords at the *top-level*.
// - Claude/Vertex has other JSON Schema quirks.
// Conditional requirements (like `raw` for config.apply) are enforced at runtime.

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    ownerOnly: isOpenClawOwnerOnlyCoreToolName("gateway"),
    description:
      "Gateway restart/config/update. Before config edits, use config.schema.lookup with targeted dot path. Prefer config.patch for partial merge; config.apply only full replace. Writes hot-reload or restart as needed. Always pass human `note` for post-restart delivery. If still owe the user a reply, pass one-shot `continuationMessage`; do not write restart sentinel files directly.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "restart") {
        if (!isRestartEnabled(opts?.config)) {
          throw new Error("Gateway restart is disabled (commands.restart=false).");
        }
        const sessionKey =
          normalizeOptionalString(params.sessionKey) ??
          normalizeOptionalString(opts?.agentSessionKey);
        const delayMs =
          typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
            ? Math.floor(params.delayMs)
            : undefined;
        const reason = normalizeOptionalString(params.reason)?.slice(0, 200);
        const note = normalizeOptionalString(params.note);
        const continuationMessage = normalizeOptionalString(params.continuationMessage);
        // Extract channel + threadId for routing after restart.
        // Uses generic :thread: parsing plus plugin-owned session grammars.
        const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
        const payload: RestartSentinelPayload = {
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          continuation: buildRestartSuccessContinuation({
            sessionKey,
            continuationMessage,
          }),
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
          },
        };
        log.info(
          `gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`,
        );
        let sentinelPath: string | null = null;
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
          emitHooks: {
            beforeEmit: async () => {
              sentinelPath = await writeRestartSentinel(payload);
            },
            afterEmitRejected: async () => {
              await removeRestartSentinelFile(sentinelPath);
            },
          },
        });
        return jsonResult(scheduled);
      }

      const gatewayOpts = readGatewayCallOptions(params);

      const resolveGatewayWriteMeta = (): {
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      } => {
        const sessionKey =
          normalizeOptionalString(params.sessionKey) ??
          normalizeOptionalString(opts?.agentSessionKey);
        const note = normalizeOptionalString(params.note);
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        return { sessionKey, note, restartDelayMs };
      };

      const resolveConfigWriteParams = async (): Promise<{
        raw: string;
        baseHash: string;
        snapshotConfig: Record<string, unknown>;
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      }> => {
        const raw = readStringParam(params, "raw", { required: true });
        const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
        // Always fetch config.get so we can compare protected exec settings
        // against the current snapshot before forwarding any write RPC.
        const snapshotConfig = getSnapshotConfig(snapshot);
        let baseHash = readStringParam(params, "baseHash");
        if (!baseHash) {
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        if (!baseHash) {
          throw new Error("Missing baseHash from config snapshot.");
        }
        return { raw, baseHash, snapshotConfig, ...resolveGatewayWriteMeta() };
      };

      if (action === "config.get") {
        const result = await callGatewayTool("config.get", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema.lookup") {
        const path = readStringParam(params, "path", {
          required: true,
          label: "path",
        });
        const result = await callGatewayTool("config.schema.lookup", gatewayOpts, { path });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.apply") {
        const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        assertGatewayConfigMutationAllowed({
          action: "config.apply",
          currentConfig: snapshotConfig,
          raw,
        });
        const result = await callGatewayTool("config.apply", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result: stripConfigWriteResultPayload(result) });
      }
      if (action === "config.patch") {
        const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        assertGatewayConfigMutationAllowed({
          action: "config.patch",
          currentConfig: snapshotConfig,
          raw,
        });
        const result = await callGatewayTool("config.patch", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result: stripConfigWriteResultPayload(result) });
      }
      if (action === "update.run") {
        const { sessionKey, note, restartDelayMs } = resolveGatewayWriteMeta();
        const continuationMessage = normalizeOptionalString(params.continuationMessage);
        const updateTimeoutMs = gatewayOpts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
        const updateGatewayOpts = {
          ...gatewayOpts,
          timeoutMs: updateTimeoutMs,
        };
        const result = await callGatewayTool("update.run", updateGatewayOpts, {
          sessionKey,
          note,
          continuationMessage,
          restartDelayMs,
          timeoutMs: updateTimeoutMs,
        });
        return jsonResult({ ok: true, result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
