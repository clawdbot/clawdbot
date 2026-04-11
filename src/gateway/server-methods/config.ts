import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  createConfigIO,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import {
  redactConfigObject,
  redactConfigSnapshot,
  restoreRedactedValues,
} from "../../config/redact-snapshot.js";
import { loadGatewayRuntimeConfigSchema } from "../../config/runtime-schema.js";
import { lookupConfigSchema, type ConfigSchemaResponse } from "../../config/schema.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { prepareSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { resolveEffectiveSharedGatewayAuth } from "../auth.js";
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  resolveGatewayReloadSettings,
} from "../config-reload.js";
import {
  formatControlPlaneActor,
  resolveControlPlaneActor,
  summarizeChangedPaths,
} from "../control-plane-audit.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConfigApplyParams,
  validateConfigGetParams,
  validateConfigPatchParams,
  validateConfigSchemaLookupParams,
  validateConfigSchemaLookupResult,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "../protocol/index.js";
import { resolveBaseHashParam } from "./base-hash.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE = 3;

type ConfigOpenCommand = {
  command: string;
  args: string[];
};

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash unavailable; re-run config.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHashParam(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash required; re-run config.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config changed since last load; re-run config.get and retry",
      ),
    );
    return false;
  }
  return true;
}

function parseRawConfigOrRespond(
  params: unknown,
  requestName: string,
  respond: RespondFn,
): string | null {
  const rawValue = (params as { raw?: unknown }).raw;
  if (typeof rawValue !== "string") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${requestName} params: raw (string) required`,
      ),
    );
    return null;
  }
  return rawValue;
}

function sanitizeLookupPathForLog(path: string): string {
  const sanitized = Array.from(path, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "?" : char;
  }).join("");
  return sanitized.length > 120 ? `${sanitized.slice(0, 117)}...` : sanitized;
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replaceAll("'", "''");
}

export function resolveConfigOpenCommand(
  configPath: string,
  platform: NodeJS.Platform = process.platform,
): ConfigOpenCommand {
  if (platform === "win32") {
    // Use a PowerShell string literal so the path stays data, not code.
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -LiteralPath '${escapePowerShellSingleQuotedString(configPath)}'`,
      ],
    };
  }
  return {
    command: platform === "darwin" ? "open" : "xdg-open",
    args: [configPath],
  };
}

function execConfigOpenCommand(command: ConfigOpenCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command.command, command.args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function formatConfigOpenError(error: unknown): string {
  if (
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function parseValidateConfigFromRawOrRespond(
  params: unknown,
  requestName: string,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): { config: OpenClawConfig; schema: ConfigSchemaResponse } | null {
  const rawValue = parseRawConfigOrRespond(params, requestName, respond);
  if (!rawValue) {
    return null;
  }
  const parsedRes = parseConfigJson5(rawValue);
  if (!parsedRes.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
    return null;
  }
  const schema = loadSchemaWithPlugins();
  const restored = restoreRedactedValues(parsedRes.parsed, snapshot.config, schema.uiHints);
  if (!restored.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, restored.humanReadableMessage ?? "invalid config"),
    );
    return null;
  }
  const validated = validateConfigObjectWithPlugins(restored.result);
  if (!validated.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(validated.issues), {
        details: { issues: validated.issues },
      }),
    );
    return null;
  }
  return { config: validated.config, schema };
}

function didSharedGatewayAuthChange(prev: OpenClawConfig, next: OpenClawConfig): boolean {
  const prevAuth = resolveEffectiveSharedGatewayAuth({
    authConfig: prev.gateway?.auth,
    env: process.env,
    tailscaleMode: prev.gateway?.tailscale?.mode,
  });
  const nextAuth = resolveEffectiveSharedGatewayAuth({
    authConfig: next.gateway?.auth,
    env: process.env,
    tailscaleMode: next.gateway?.tailscale?.mode,
  });
  if (prevAuth === null || nextAuth === null) {
    return prevAuth !== nextAuth;
  }
  return prevAuth.mode !== nextAuth.mode || !isDeepStrictEqual(prevAuth.secret, nextAuth.secret);
}

function queueSharedGatewayAuthDisconnect(
  shouldDisconnect: boolean,
  context?: GatewayRequestContext,
): void {
  if (!shouldDisconnect) {
    return;
  }
  queueMicrotask(() => {
    context?.disconnectClientsUsingSharedGatewayAuth?.();
  });
}

function queueSharedGatewayAuthGenerationRefresh(
  shouldRefresh: boolean,
  nextConfig: OpenClawConfig,
  context?: GatewayRequestContext,
): void {
  if (!shouldRefresh) {
    return;
  }
  queueMicrotask(() => {
    context?.enforceSharedGatewayAuthGenerationForConfigWrite?.(nextConfig);
  });
}

function summarizeConfigValidationIssues(issues: ReadonlyArray<ConfigValidationIssue>): string {
  const trimmed = issues.slice(0, MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE);
  const lines = formatConfigIssueLines(trimmed, "", { normalizeRoot: true })
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "invalid config";
  }
  const hiddenCount = Math.max(0, issues.length - lines.length);
  return `invalid config: ${lines.join("; ")}${
    hiddenCount > 0 ? ` (+${hiddenCount} more issue${hiddenCount === 1 ? "" : "s"})` : ""
  }`;
}

function shouldScheduleDirectConfigRestart(params: {
  changedPaths: string[];
  nextConfig: OpenClawConfig;
}): boolean {
  const reloadSettings = resolveGatewayReloadSettings(params.nextConfig);
  if (reloadSettings.mode === "off") {
    return true;
  }
  const plan = buildGatewayReloadPlan(params.changedPaths);
  if (reloadSettings.mode === "hot" && plan.restartGateway) {
    return true;
  }
  return false;
}

async function ensureResolvableSecretRefsOrRespond(params: {
  config: OpenClawConfig;
  respond: RespondFn;
}): Promise<boolean> {
  try {
    await prepareSecretsRuntimeSnapshot({
      config: params.config,
      includeAuthStoreRefs: false,
    });
    return true;
  } catch (error) {
    const details = formatErrorMessage(error);
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid config: active SecretRef resolution failed (${details})`,
      ),
    );
    return false;
  }
}

function resolveConfigRestartRequest(params: unknown): {
  sessionKey: string | undefined;
  note: string | undefined;
  restartDelayMs: number | undefined;
  deliveryContext: ReturnType<typeof extractDeliveryInfo>["deliveryContext"];
  threadId: ReturnType<typeof extractDeliveryInfo>["threadId"];
} {
  const {
    sessionKey,
    deliveryContext: requestedDeliveryContext,
    threadId: requestedThreadId,
    note,
    restartDelayMs,
  } = parseRestartRequestParams(params);

  // Extract deliveryContext + threadId for routing after restart.
  // Uses generic :thread: parsing plus plugin-owned session grammars.
  const { deliveryContext: sessionDeliveryContext, threadId: sessionThreadId } =
    extractDeliveryInfo(sessionKey);

  return {
    sessionKey,
    note,
    restartDelayMs,
    deliveryContext: requestedDeliveryContext ?? sessionDeliveryContext,
    threadId: requestedThreadId ?? sessionThreadId,
  };
}

function buildConfigRestartSentinelPayload(params: {
  kind: RestartSentinelPayload["kind"];
  mode: string;
  sessionKey: string | undefined;
  deliveryContext: ReturnType<typeof extractDeliveryInfo>["deliveryContext"];
  threadId: ReturnType<typeof extractDeliveryInfo>["threadId"];
  note: string | undefined;
}): RestartSentinelPayload {
  const configPath = createConfigIO().configPath;
  return {
    kind: params.kind,
    status: "ok",
    ts: Date.now(),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    threadId: params.threadId,
    message: params.note ?? null,
    doctorHint: formatDoctorNonInteractiveHint(),
    stats: {
      mode: params.mode,
      root: configPath,
    },
  };
}

async function tryWriteRestartSentinelPayload(
  payload: RestartSentinelPayload,
): Promise<string | null> {
  try {
    return await writeRestartSentinel(payload);
  } catch {
    return null;
  }
}

function loadSchemaWithPlugins(): ConfigSchemaResponse {
  // Note: We can't easily cache this, as there are no callback that can invalidate
  // our cache. However, loadConfig() and loadOpenClawPlugins() (called inside
  // loadGatewayRuntimeConfigSchema) already cache their results, and buildConfigSchema()
  // is just a cheap transformation.
  return loadGatewayRuntimeConfigSchema();
}

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) {
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    const schema = loadSchemaWithPlugins();
    respond(true, redactConfigSnapshot(snapshot, schema.uiHints), undefined);
  },
  "config.schema": ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSchemaParams, "config.schema", respond)) {
      return;
    }
    respond(true, loadSchemaWithPlugins(), undefined);
  },
  "config.schema.lookup": ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateConfigSchemaLookupParams, "config.schema.lookup", respond)
    ) {
      return;
    }
    const path = (params as { path: string }).path;
    const schema = loadSchemaWithPlugins();
    const result = lookupConfigSchema(schema, path);
    if (!result) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config schema path not found"),
      );
      return;
    }
    if (!validateConfigSchemaLookupResult(result)) {
      const errors = validateConfigSchemaLookupResult.errors ?? [];
      context.logGateway.warn(
        `config.schema.lookup produced invalid payload for ${sanitizeLookupPathForLog(path)}: ${formatValidationErrors(errors)}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "config.schema.lookup returned invalid payload", {
          details: { errors },
        }),
      );
      return;
    }
    respond(true, result, undefined);
  },
  "config.set": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigSetParams, "config.set", respond)) {
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.set", snapshot, respond);
    if (!parsed) {
      return;
    }
    if (!(await ensureResolvableSecretRefsOrRespond({ config: parsed.config, respond }))) {
      return;
    }
    await writeConfigFile(parsed.config, writeOptions);
    respond(
      true,
      {
        ok: true,
        path: createConfigIO().configPath,
        config: redactConfigObject(parsed.config, parsed.schema.uiHints),
      },
      undefined,
    );
    queueSharedGatewayAuthGenerationRefresh(true, parsed.config, context);
  },
  "config.patch": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigPatchParams, "config.patch", respond)) {
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"),
      );
      return;
    }
    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid config.patch params: raw (string) required",
        ),
      );
      return;
    }
    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }
    if (
      !parsedRes.parsed ||
      typeof parsedRes.parsed !== "object" ||
      Array.isArray(parsedRes.parsed)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config.patch raw must be an object"),
      );
      return;
    }
    const merged = applyMergePatch(snapshot.config, parsedRes.parsed, {
      mergeObjectArraysById: true,
    });
    const schemaPatch = loadSchemaWithPlugins();
    const restoredMerge = restoreRedactedValues(merged, snapshot.config, schemaPatch.uiHints);
    if (!restoredMerge.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          restoredMerge.humanReadableMessage ?? "invalid config",
        ),
      );
      return;
    }
    const validated = validateConfigObjectWithPlugins(restoredMerge.result);
    if (!validated.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(validated.issues), {
          details: { issues: validated.issues },
        }),
      );
      return;
    }
    if (!(await ensureResolvableSecretRefsOrRespond({ config: validated.config, respond }))) {
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.config, validated.config);
    const actor = resolveControlPlaneActor(client);

    // No-op: if the validated config is identical to the current config,
    // skip the file write and SIGUSR1 restart entirely. This avoids a full
    // gateway restart (and the resulting connection drop) when a control-plane
    // client re-sends the same config (e.g. hot-apply with no actual changes).
    if (changedPaths.length === 0) {
      context?.logGateway?.info(
        `config.patch noop ${formatControlPlaneActor(actor)} (no changed paths)`,
      );
      respond(
        true,
        {
          ok: true,
          noop: true,
          path: createConfigIO().configPath,
          config: redactConfigObject(validated.config, schemaPatch.uiHints),
        },
        undefined,
      );
      return;
    }

    context?.logGateway?.info(
      `config.patch write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.patch`,
    );
    // Compare before the write so we invalidate clients authenticated against the
    // previous shared secret immediately after the config update succeeds.
    const disconnectSharedAuthClients = didSharedGatewayAuthChange(
      snapshot.config,
      validated.config,
    );
    await writeConfigFile(validated.config, writeOptions);

    const { sessionKey, note, restartDelayMs, deliveryContext, threadId } =
      resolveConfigRestartRequest(params);
    const payload = buildConfigRestartSentinelPayload({
      kind: "config-patch",
      mode: "config.patch",
      sessionKey,
      deliveryContext,
      threadId,
      note,
    });
    const sentinelPath = await tryWriteRestartSentinelPayload(payload);
    const restart = shouldScheduleDirectConfigRestart({
      changedPaths,
      nextConfig: validated.config,
    })
      ? scheduleGatewaySigusr1Restart({
          delayMs: restartDelayMs,
          reason: "config.patch",
          audit: {
            actor: actor.actor,
            deviceId: actor.deviceId,
            clientIp: actor.clientIp,
            changedPaths,
          },
        })
      : undefined;
    if (restart?.coalesced) {
      context?.logGateway?.warn(
        `config.patch restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }
    respond(
      true,
      {
        ok: true,
        path: createConfigIO().configPath,
        config: redactConfigObject(validated.config, schemaPatch.uiHints),
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
    queueSharedGatewayAuthGenerationRefresh(true, validated.config, context);
    queueSharedGatewayAuthDisconnect(disconnectSharedAuthClients, context);
  },
  "config.apply": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) {
      return;
    }
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.apply", snapshot, respond);
    if (!parsed) {
      return;
    }
    if (!(await ensureResolvableSecretRefsOrRespond({ config: parsed.config, respond }))) {
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.config, parsed.config);
    const actor = resolveControlPlaneActor(client);
    context?.logGateway?.info(
      `config.apply write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.apply`,
    );
    // Compare before the write so we invalidate clients authenticated against the
    // previous shared secret immediately after the config update succeeds.
    const disconnectSharedAuthClients = didSharedGatewayAuthChange(snapshot.config, parsed.config);
    await writeConfigFile(parsed.config, writeOptions);

    const { sessionKey, note, restartDelayMs, deliveryContext, threadId } =
      resolveConfigRestartRequest(params);
    const payload = buildConfigRestartSentinelPayload({
      kind: "config-apply",
      mode: "config.apply",
      sessionKey,
      deliveryContext,
      threadId,
      note,
    });
    const sentinelPath = await tryWriteRestartSentinelPayload(payload);
    const restart = shouldScheduleDirectConfigRestart({
      changedPaths,
      nextConfig: parsed.config,
    })
      ? scheduleGatewaySigusr1Restart({
          delayMs: restartDelayMs,
          reason: "config.apply",
          audit: {
            actor: actor.actor,
            deviceId: actor.deviceId,
            clientIp: actor.clientIp,
            changedPaths,
          },
        })
      : undefined;
    if (restart?.coalesced) {
      context?.logGateway?.warn(
        `config.apply restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }
    respond(
      true,
      {
        ok: true,
        path: createConfigIO().configPath,
        config: redactConfigObject(parsed.config, parsed.schema.uiHints),
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
    queueSharedGatewayAuthGenerationRefresh(true, parsed.config, context);
    queueSharedGatewayAuthDisconnect(disconnectSharedAuthClients, context);
  },
  "config.openFile": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.openFile", respond)) {
      return;
    }
    const configPath = createConfigIO().configPath;
    try {
      await execConfigOpenCommand(resolveConfigOpenCommand(configPath));
      respond(true, { ok: true, path: configPath }, undefined);
    } catch (error) {
      context?.logGateway?.warn(
        `config.openFile failed path=${sanitizeLookupPathForLog(configPath)}: ${formatConfigOpenError(error)}`,
      );
      respond(
        true,
        { ok: false, path: configPath, error: "failed to open config file" },
        undefined,
      );
    }
  },
};
