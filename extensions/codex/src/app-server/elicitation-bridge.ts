// Codex plugin module implements elicitation bridge behavior.
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatCodexDisplayText } from "../command-formatters.js";
import {
  approvalRequestExplicitlyUnavailable,
  mapExecDecisionToOutcome,
  requestPluginApproval,
  type AppServerApprovalOutcome,
  type ExecApprovalDecision,
  waitForPluginApprovalDecision,
} from "./plugin-approval-roundtrip.js";
import type {
  CodexAppPolicyContextEntry,
  PluginAppPolicyContext,
  PluginAppPolicyContextEntry,
} from "./plugin-thread-config.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

type ApprovalPropertyContext = {
  name: string;
  schema: JsonObject;
  required: boolean;
};

type BridgeableApprovalElicitation = {
  title: string;
  description: string;
  requestedSchema: JsonObject;
  meta: JsonObject;
  persistHintsMode?: "legacy" | "explicit";
  allowedDecisions?: ExecApprovalDecision[];
};

type PluginElicitationResolution =
  | { kind: "not_plugin" }
  | { kind: "matched"; entry: CodexAppPolicyContextEntry }
  | { kind: "decline"; reason: string };

const MCP_TOOL_APPROVAL_KIND = "mcp_tool_call";
const MCP_TOOL_APPROVAL_KIND_KEY = "codex_approval_kind";
const MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY = "connector_name";
const MCP_TOOL_APPROVAL_TOOL_TITLE_KEY = "tool_title";
const MCP_TOOL_APPROVAL_TOOL_DESCRIPTION_KEY = "tool_description";
const MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY = "tool_params_display";
const MCP_TOOL_APPROVAL_SOURCE_KEY = "source";
const MCP_TOOL_APPROVAL_CONNECTOR_SOURCE = "connector";
const CODEX_APPS_SERVER_NAME = "codex_apps";
const COMPUTER_USE_APPROVAL_TITLE = "Computer Use approval";
const EMPTY_OBJECT_SCHEMA: JsonObject = { type: "object", properties: {} };
const PLUGIN_APP_ID_META_KEYS = ["app_id", "appId", "codex_app_id", "codexAppId"];
const PLUGIN_CONNECTOR_ID_META_KEYS = ["connector_id", "connectorId"];
const PLUGIN_NAME_META_KEYS = ["plugin_name", "pluginName", "codex_plugin_name", "codexPluginName"];
const PLUGIN_CONFIG_KEY_META_KEYS = ["config_key", "configKey", "codex_config_key"];
const PLUGIN_MARKETPLACE_NAME_META_KEYS = [
  "marketplace_name",
  "marketplaceName",
  "codex_marketplace_name",
  "codexMarketplaceName",
];
const MAX_DISPLAY_PARAM_ENTRIES = 8;
const MAX_DISPLAY_PARAM_VALUE_LENGTH = 120;
const MAX_DISPLAY_VALUE_ARRAY_ITEMS = 8;
const MAX_DISPLAY_VALUE_OBJECT_KEYS = 8;
const MAX_DISPLAY_VALUE_DEPTH = 3;
const DISPLAY_TEXT_SCAN_MAX_LENGTH = 4096;
const ANSI_OSC_SEQUENCE_RE = new RegExp(
  String.raw`(?:\u001b]|\u009d)[^\u001b\u009c\u0007]*(?:\u0007|\u001b\\|\u009c)`,
  "g",
);
const ANSI_CONTROL_SEQUENCE_RE = new RegExp(
  String.raw`(?:\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_])`,
  "g",
);
const CONTROL_CHARACTER_RE = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]+`, "g");
const INVISIBLE_FORMATTING_CONTROL_RE = new RegExp(
  String.raw`[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]`,
  "gu",
);
const DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE = new RegExp(
  String.raw`(?:\u001b\][^\u001b\u009c\u0007]*|\u009d[^\u001b\u009c\u0007]*|\u001b\[[0-?]*[ -/]*|\u009b[0-?]*[ -/]*|\u001b)$`,
);

export async function handleCodexAppServerElicitationRequest(params: {
  requestParams: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  pluginAppPolicyContext?: PluginAppPolicyContext;
  computerUseMcpServerName?: string;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  const requestParams = isJsonObject(params.requestParams) ? params.requestParams : undefined;
  if (!requestParams) {
    return undefined;
  }
  if (!matchesCurrentThread(requestParams, params.threadId)) {
    return undefined;
  }
  if (turnIdMismatches(requestParams, params.turnId)) {
    return undefined;
  }
  const pluginResolution = resolvePluginElicitation({
    requestParams,
    pluginAppPolicyContext: params.pluginAppPolicyContext,
  });
  if (pluginResolution.kind !== "not_plugin") {
    if (pluginResolution.kind === "decline") {
      logPluginElicitationDecline(pluginResolution.reason, requestParams);
      return declineElicitationResponse();
    }
    if (!hasExactTurnId(requestParams, params.turnId)) {
      logPluginElicitationDecline("missing_active_turn", requestParams);
      return declineElicitationResponse();
    }
    return await buildPluginPolicyElicitationResponse({
      entry: pluginResolution.entry,
      requestParams,
      paramsForRun: params.paramsForRun,
      signal: params.signal,
    });
  }

  const approvalPrompt =
    readComputerUseApprovalElicitation(requestParams, params.computerUseMcpServerName) ??
    readBridgeableApprovalElicitation(requestParams);
  if (!approvalPrompt) {
    return undefined;
  }

  const outcome = await requestPluginApprovalOutcome({
    paramsForRun: params.paramsForRun,
    title: approvalPrompt.title,
    description: approvalPrompt.description,
    allowedDecisions: approvalPrompt.allowedDecisions,
    signal: params.signal,
  });
  return buildElicitationResponse(approvalPrompt, outcome);
}

function matchesCurrentThread(requestParams: JsonObject | undefined, threadId: string): boolean {
  if (!requestParams) {
    return false;
  }
  const requestThreadId = readString(requestParams, "threadId");
  return requestThreadId === threadId;
}

function turnIdMismatches(requestParams: JsonObject | undefined, turnId: string): boolean {
  const rawTurnId = requestParams?.turnId;
  return rawTurnId !== null && rawTurnId !== undefined && rawTurnId !== turnId;
}

function hasExactTurnId(requestParams: JsonObject | undefined, turnId: string): boolean {
  return requestParams?.turnId === turnId;
}

function resolvePluginElicitation(params: {
  requestParams: JsonObject | undefined;
  pluginAppPolicyContext?: PluginAppPolicyContext;
}): PluginElicitationResolution {
  const requestParams = params.requestParams;
  if (!requestParams) {
    return { kind: "not_plugin" };
  }
  const meta = isJsonObject(requestParams["_meta"]) ? requestParams["_meta"] : {};
  const context = params.pluginAppPolicyContext;
  const entries = context ? Object.values(context.apps) : [];
  const pluginEntries = entries.filter(isPluginAppPolicyContextEntry);

  const appId =
    readFirstString(meta, PLUGIN_APP_ID_META_KEYS) ??
    readFirstString(requestParams, PLUGIN_APP_ID_META_KEYS);
  const connectorId = readFirstString(meta, PLUGIN_CONNECTOR_ID_META_KEYS);
  const isCodexConnectorApproval = isCodexConnectorApprovalElicitation(requestParams, meta);
  if (isCodexConnectorApproval && appId && connectorId && appId !== connectorId) {
    return { kind: "decline", reason: "app_id_connector_id_mismatch" };
  }
  if (appId) {
    if (!context) {
      return { kind: "decline", reason: "missing_policy_context" };
    }
    const entry = context.apps[appId];
    if (entry?.source === "account" && !isCodexConnectorApproval) {
      return { kind: "decline", reason: "account_app_source_mismatch" };
    }
    return uniquePluginMatch(entry ? [entry] : [], "app_id");
  }
  if (isCodexConnectorApproval && connectorId) {
    if (!context) {
      return { kind: "decline", reason: "missing_policy_context" };
    }
    const entry = context.apps[connectorId];
    return uniquePluginMatch(entry ? [entry] : [], "connector_id");
  }

  const serverName = readString(requestParams, "serverName");
  if (serverName && context) {
    const matches = entries.filter((entry) => entry.mcpServerNames.includes(serverName));
    if (matches.length > 0) {
      return uniquePluginMatch(matches, "server_name");
    }
  }

  const metadataResolution = resolvePluginStableMetadataMatch({
    meta,
    requestParams,
    entries: pluginEntries,
    context,
  });
  if (metadataResolution.kind !== "not_plugin") {
    return metadataResolution;
  }

  if (context && hasDisplayNameOnlyPluginMatch(meta, entries)) {
    return { kind: "decline", reason: "display_name_only" };
  }

  return { kind: "not_plugin" };
}

function isCodexConnectorApprovalElicitation(requestParams: JsonObject, meta: JsonObject): boolean {
  return (
    readString(requestParams, "serverName") === CODEX_APPS_SERVER_NAME &&
    readString(meta, MCP_TOOL_APPROVAL_KIND_KEY) === MCP_TOOL_APPROVAL_KIND &&
    readString(meta, MCP_TOOL_APPROVAL_SOURCE_KEY) === MCP_TOOL_APPROVAL_CONNECTOR_SOURCE
  );
}

function resolvePluginStableMetadataMatch(params: {
  meta: JsonObject;
  requestParams: JsonObject;
  entries: PluginAppPolicyContextEntry[];
  context?: PluginAppPolicyContext;
}): PluginElicitationResolution {
  const pluginName =
    readFirstString(params.meta, PLUGIN_NAME_META_KEYS) ??
    readFirstString(params.requestParams, PLUGIN_NAME_META_KEYS);
  const configKey =
    readFirstString(params.meta, PLUGIN_CONFIG_KEY_META_KEYS) ??
    readFirstString(params.requestParams, PLUGIN_CONFIG_KEY_META_KEYS);
  const marketplaceName =
    readFirstString(params.meta, PLUGIN_MARKETPLACE_NAME_META_KEYS) ??
    readFirstString(params.requestParams, PLUGIN_MARKETPLACE_NAME_META_KEYS);
  if (!pluginName && !configKey) {
    return { kind: "not_plugin" };
  }
  if (!params.context) {
    return { kind: "decline", reason: "missing_policy_context" };
  }
  const matches = params.entries.filter((entry) => {
    if (marketplaceName && entry.marketplaceName !== marketplaceName) {
      return false;
    }
    if (pluginName && entry.pluginName !== pluginName) {
      return false;
    }
    if (configKey && entry.configKey !== configKey) {
      return false;
    }
    return true;
  });
  return uniquePluginMatch(matches, "metadata");
}

function uniquePluginMatch(
  matches: CodexAppPolicyContextEntry[],
  source: string,
): PluginElicitationResolution {
  if (matches.length === 1 && matches[0]) {
    return { kind: "matched", entry: matches[0] };
  }
  return {
    kind: "decline",
    reason: matches.length === 0 ? `${source}_not_enabled` : `${source}_ambiguous`,
  };
}

function hasDisplayNameOnlyPluginMatch(
  meta: JsonObject,
  entries: CodexAppPolicyContextEntry[],
): boolean {
  const connectorName = readString(meta, MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY);
  if (!connectorName) {
    return false;
  }
  const normalized = normalizePluginIdentityText(connectorName);
  return entries.some(
    (entry) =>
      normalizePluginIdentityText(appPolicyDisplayName(entry)) === normalized ||
      (isPluginAppPolicyContextEntry(entry) &&
        normalizePluginIdentityText(entry.configKey) === normalized),
  );
}

function isPluginAppPolicyContextEntry(
  entry: CodexAppPolicyContextEntry,
): entry is PluginAppPolicyContextEntry {
  return entry.source !== "account";
}

function appPolicyDisplayName(entry: CodexAppPolicyContextEntry): string {
  return isPluginAppPolicyContextEntry(entry) ? entry.pluginName : entry.appName;
}

function normalizePluginIdentityText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function buildPluginPolicyElicitationResponse(params: {
  entry: CodexAppPolicyContextEntry;
  requestParams: JsonObject;
  paramsForRun: EmbeddedRunAttemptParams;
  signal?: AbortSignal;
}): Promise<JsonValue> {
  const mode = resolvePluginDestructiveApprovalMode(params.entry);
  if (mode === "deny") {
    logPluginElicitationDecline("destructive_actions_disabled", params.requestParams);
    return declineElicitationResponse();
  }
  const approvalPrompt = readPluginApprovalElicitation(params.entry, params.requestParams);
  if (!approvalPrompt) {
    logPluginElicitationDecline("unsupported_schema", params.requestParams);
    return declineElicitationResponse();
  }
  const response = buildElicitationResponse(approvalPrompt, "approved-once");
  if (isJsonObject(response) && response.action === "accept") {
    if (mode === "allow") {
      return response;
    }
    const outcome = await requestPluginApprovalOutcome({
      paramsForRun: params.paramsForRun,
      title: approvalPrompt.title,
      description: approvalPrompt.description,
      allowedDecisions: allowedPluginPolicyApprovalDecisions(mode, approvalPrompt),
      signal: params.signal,
    });
    return buildElicitationResponse(
      approvalPrompt,
      oneShotPluginPolicyApprovalOutcome(mode, outcome),
    );
  }
  logPluginElicitationDecline("unmappable_schema", params.requestParams);
  return declineElicitationResponse();
}

function resolvePluginDestructiveApprovalMode(
  entry: CodexAppPolicyContextEntry,
): "allow" | "deny" | "auto" | "ask" {
  return entry.destructiveApprovalMode ?? (entry.allowDestructiveActions ? "allow" : "deny");
}

function allowedPluginPolicyApprovalDecisions(
  mode: "allow" | "deny" | "auto" | "ask",
  approvalPrompt: BridgeableApprovalElicitation,
): ExecApprovalDecision[] {
  const allowedDecisions = approvalPrompt.allowedDecisions ?? ["allow-once", "deny"];
  if (mode !== "ask") {
    return allowedDecisions;
  }
  return allowedDecisions.filter((decision) => decision !== "allow-always");
}

function oneShotPluginPolicyApprovalOutcome(
  mode: "allow" | "deny" | "auto" | "ask",
  outcome: AppServerApprovalOutcome,
): AppServerApprovalOutcome {
  return mode === "ask" && outcome === "approved-session" ? "approved-once" : outcome;
}

function readPluginApprovalElicitation(
  entry: CodexAppPolicyContextEntry,
  requestParams: JsonObject,
): BridgeableApprovalElicitation | undefined {
  if (
    readString(requestParams, "mode") !== "form" ||
    !isJsonObject(requestParams.requestedSchema)
  ) {
    return undefined;
  }
  const requestedSchema = requestParams.requestedSchema;
  if (
    readString(requestedSchema, "type") !== "object" ||
    !isJsonObject(requestedSchema.properties)
  ) {
    return undefined;
  }

  const meta = isJsonObject(requestParams["_meta"]) ? requestParams["_meta"] : {};
  const title =
    sanitizeDisplayText(readString(requestParams, "message") ?? "") || "Codex plugin approval";
  const descriptionMeta: JsonObject = { ...meta };
  if (!readString(descriptionMeta, MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY)) {
    descriptionMeta[MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY] = appPolicyDisplayName(entry);
  }
  return {
    title,
    description: buildApprovalDescription({
      title,
      meta: descriptionMeta,
      requestedSchema,
      serverName: sanitizeOptionalDisplayText(readString(requestParams, "serverName")),
    }),
    requestedSchema,
    meta,
    persistHintsMode: "explicit",
    allowedDecisions: buildApprovalAllowedDecisions(requestedSchema, meta),
  };
}

function buildApprovalAllowedDecisions(
  requestedSchema: JsonObject,
  meta: JsonObject,
): ExecApprovalDecision[] {
  return canMapPersistentApproval(requestedSchema, meta)
    ? ["allow-once", "allow-always", "deny"]
    : ["allow-once", "deny"];
}

function canMapPersistentApproval(requestedSchema: JsonObject, meta: JsonObject): boolean {
  const persistHints = readPersistHints(meta, "explicit");
  if (persistHints.length > 0) {
    return persistHints.includes("always");
  }
  const properties = isJsonObject(requestedSchema.properties) ? requestedSchema.properties : {};
  return Object.entries(properties).some(([name, value]) => {
    const schema = isJsonObject(value) ? value : undefined;
    if (!schema) {
      return false;
    }
    return (
      isPersistField({ name, schema, required: false }) &&
      chooseAlwaysPersistOptionValue(readEnumOptions(schema)) !== undefined
    );
  });
}

function declineElicitationResponse(): JsonValue {
  return { action: "decline", content: null, _meta: null };
}

function logPluginElicitationDecline(reason: string, requestParams: JsonObject | undefined): void {
  embeddedAgentLog.debug("codex plugin elicitation declined", {
    reason,
    serverName: readString(requestParams, "serverName"),
    mode: readString(requestParams, "mode"),
  });
}

function readBridgeableApprovalElicitation(
  requestParams: JsonObject | undefined,
): BridgeableApprovalElicitation | undefined {
  if (
    !requestParams ||
    readString(requestParams, "mode") !== "form" ||
    !isJsonObject(requestParams["_meta"]) ||
    requestParams["_meta"][MCP_TOOL_APPROVAL_KIND_KEY] !== MCP_TOOL_APPROVAL_KIND ||
    !isJsonObject(requestParams.requestedSchema)
  ) {
    return undefined;
  }

  const requestedSchema = requestParams.requestedSchema;
  if (
    readString(requestedSchema, "type") !== "object" ||
    !isJsonObject(requestedSchema.properties)
  ) {
    return undefined;
  }

  const title =
    sanitizeDisplayText(readString(requestParams, "message") ?? "") || "Codex MCP tool approval";
  return {
    title,
    description: buildApprovalDescription({
      title,
      meta: requestParams["_meta"],
      requestedSchema,
      serverName: sanitizeOptionalDisplayText(readString(requestParams, "serverName")),
    }),
    requestedSchema,
    meta: requestParams["_meta"],
  };
}

function readComputerUseApprovalElicitation(
  requestParams: JsonObject | undefined,
  expectedServerName: string | undefined,
): BridgeableApprovalElicitation | undefined {
  const serverName = readString(requestParams, "serverName");
  if (
    !serverName ||
    !expectedServerName ||
    serverName !== expectedServerName ||
    readString(requestParams, "mode") !== "form"
  ) {
    return undefined;
  }

  const requestedSchema = isJsonObject(requestParams?.requestedSchema)
    ? requestParams.requestedSchema
    : EMPTY_OBJECT_SCHEMA;
  if (
    readString(requestedSchema, "type") !== "object" ||
    !isJsonObject(requestedSchema.properties)
  ) {
    return undefined;
  }

  const meta = isJsonObject(requestParams?.["_meta"]) ? requestParams["_meta"] : {};
  const title =
    sanitizeDisplayText(readString(requestParams, "message") ?? "") || COMPUTER_USE_APPROVAL_TITLE;
  return {
    title,
    description: buildApprovalDescription({
      title,
      meta,
      requestedSchema,
      serverName: sanitizeOptionalDisplayText(serverName),
    }),
    requestedSchema,
    meta,
  };
}

function buildApprovalDescription(params: {
  title: string;
  meta: JsonObject;
  requestedSchema: JsonObject;
  serverName: string | undefined;
}): string {
  const connectorName = sanitizeOptionalDisplayText(
    readString(params.meta, MCP_TOOL_APPROVAL_CONNECTOR_NAME_KEY),
  );
  const toolTitle = sanitizeOptionalDisplayText(
    readString(params.meta, MCP_TOOL_APPROVAL_TOOL_TITLE_KEY),
  );
  const toolDescription = sanitizeOptionalDisplayText(
    readString(params.meta, MCP_TOOL_APPROVAL_TOOL_DESCRIPTION_KEY),
  );
  const summaryLines = [
    connectorName && `App: ${connectorName}`,
    toolTitle && `Tool: ${toolTitle}`,
    params.serverName && `MCP server: ${params.serverName}`,
    toolDescription,
  ].filter((line): line is string => Boolean(line));
  const paramLines = readDisplayParamLines(params.meta);
  const propertyLines = readPropertyDescriptionLines(params.requestedSchema);
  return [
    params.title,
    summaryLines.join("\n"),
    paramLines.length > 0 ? ["Parameters:", ...paramLines].join("\n") : "",
    propertyLines.length > 0 ? ["Fields:", ...propertyLines].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function readPropertyDescriptionLines(requestedSchema: JsonObject): string[] {
  const properties = isJsonObject(requestedSchema.properties) ? requestedSchema.properties : {};
  return Object.entries(properties)
    .map(([name, value]) => {
      const schema = isJsonObject(value) ? value : undefined;
      if (!schema) {
        return undefined;
      }
      const propTitle =
        sanitizeDisplayText(readString(schema, "title") ?? "") ||
        sanitizeDisplayText(name) ||
        "field";
      const description = sanitizeOptionalDisplayText(readString(schema, "description"));
      return description ? `- ${propTitle}: ${description}` : `- ${propTitle}`;
    })
    .filter((line): line is string => Boolean(line));
}

function readDisplayParamLines(meta: JsonObject): string[] {
  const displayParams = meta[MCP_TOOL_APPROVAL_TOOL_PARAMS_DISPLAY_KEY];
  if (!Array.isArray(displayParams)) {
    return [];
  }
  const lines = displayParams
    .slice(0, MAX_DISPLAY_PARAM_ENTRIES)
    .map((entry) => {
      const param = isJsonObject(entry) ? entry : undefined;
      if (!param) {
        return undefined;
      }
      const name =
        sanitizeOptionalDisplayText(readString(param, "display_name")) ??
        sanitizeOptionalDisplayText(readString(param, "name"));
      if (!name) {
        return undefined;
      }
      return `- ${name}: ${formatDisplayParamValue(param.value)}`;
    })
    .filter((line): line is string => Boolean(line));
  const remaining = displayParams.length - MAX_DISPLAY_PARAM_ENTRIES;
  return remaining > 0 ? [...lines, `- Additional parameters: ${remaining} more`] : lines;
}

function formatDisplayParamValue(value: JsonValue | undefined): string {
  const formatted = typeof value === "string" ? value : formatDisplayJsonValue(value ?? null);
  return truncateDisplayText(sanitizeDisplayText(formatted), MAX_DISPLAY_PARAM_VALUE_LENGTH);
}

function formatDisplayJsonValue(value: JsonValue, depth = MAX_DISPLAY_VALUE_DEPTH): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(truncateDisplayText(sanitizeDisplayText(value), 80));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (depth <= 0) {
      return "[truncated]";
    }
    const parts: string[] = [];
    const limit = Math.min(value.length, MAX_DISPLAY_VALUE_ARRAY_ITEMS);
    for (let i = 0; i < limit; i += 1) {
      parts.push(formatDisplayJsonValue(value[i] ?? null, depth - 1));
    }
    if (value.length > MAX_DISPLAY_VALUE_ARRAY_ITEMS) {
      parts.push("...");
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    if (depth <= 0) {
      return "{truncated}";
    }
    const parts: string[] = [];
    let count = 0;
    let truncated = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        continue;
      }
      if (count >= MAX_DISPLAY_VALUE_OBJECT_KEYS) {
        truncated = true;
        break;
      }
      const safeKey = truncateDisplayText(sanitizeDisplayText(key), 80);
      parts.push(
        `${JSON.stringify(safeKey)}:${formatDisplayJsonValue(value[key] ?? null, depth - 1)}`,
      );
      count += 1;
    }
    if (truncated) {
      parts.push("...");
    }
    return `{${parts.join(",")}}`;
  }
  return "null";
}

function sanitizeOptionalDisplayText(value: string | undefined): string | undefined {
  const sanitized = value === undefined ? "" : sanitizeDisplayText(value);
  return sanitized || undefined;
}

function sanitizeDisplayText(value: string): string {
  const scanned = sliceUtf16Safe(value, 0, DISPLAY_TEXT_SCAN_MAX_LENGTH);
  const clipped = value.length > DISPLAY_TEXT_SCAN_MAX_LENGTH;
  const sanitized = scanned
    .replace(ANSI_OSC_SEQUENCE_RE, "")
    .replace(ANSI_CONTROL_SEQUENCE_RE, "")
    .replace(DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE, "")
    .replace(INVISIBLE_FORMATTING_CONTROL_RE, " ")
    .replace(CONTROL_CHARACTER_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const escaped = sanitized ? formatCodexDisplayText(sanitized) : "";
  return clipped && escaped ? `${escaped}...` : escaped;
}

function truncateDisplayText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${truncateUtf16Safe(value, maxLength - 3)}...`;
}

async function requestPluginApprovalOutcome(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  title: string;
  description: string;
  allowedDecisions?: ExecApprovalDecision[];
  signal?: AbortSignal;
}): Promise<AppServerApprovalOutcome> {
  try {
    const requestResult = await requestPluginApproval({
      paramsForRun: params.paramsForRun,
      title: params.title,
      description: params.description,
      severity: "warning",
      toolName: "codex_mcp_tool_approval",
      allowedDecisions: params.allowedDecisions,
    });

    const approvalId = requestResult?.id;
    if (!approvalId) {
      return "unavailable";
    }

    const decision = approvalRequestExplicitlyUnavailable(requestResult)
      ? null
      : await waitForPluginApprovalDecision({ approvalId, signal: params.signal });
    return mapExecDecisionToOutcome(decision);
  } catch {
    return params.signal?.aborted ? "cancelled" : "denied";
  }
}

function buildElicitationResponse(
  approvalPrompt: Pick<
    BridgeableApprovalElicitation,
    "requestedSchema" | "meta" | "persistHintsMode"
  >,
  outcome: AppServerApprovalOutcome,
): JsonValue {
  const { requestedSchema, meta } = approvalPrompt;
  if (outcome === "cancelled") {
    return { action: "cancel", content: null, _meta: null };
  }
  if (outcome === "denied" || outcome === "unavailable") {
    return { action: "decline", content: null, _meta: null };
  }

  const content = buildAcceptedContent(approvalPrompt, outcome);
  if (!content) {
    if (hasNoSchemaProperties(requestedSchema)) {
      return {
        action: "accept",
        content: null,
        _meta: buildAcceptedMeta(meta, outcome, approvalPrompt.persistHintsMode ?? "legacy"),
      };
    }
    embeddedAgentLog.warn("codex MCP approval elicitation approved without a mappable response", {
      approvalKind: meta[MCP_TOOL_APPROVAL_KIND_KEY],
      fields: Object.keys(requestedSchema.properties ?? {}),
      outcome,
    });
    return { action: "decline", content: null, _meta: null };
  }
  return {
    action: "accept",
    content,
    _meta: buildAcceptedMeta(meta, outcome, approvalPrompt.persistHintsMode ?? "legacy"),
  };
}

function buildAcceptedContent(
  approvalPrompt: Pick<
    BridgeableApprovalElicitation,
    "requestedSchema" | "meta" | "persistHintsMode"
  >,
  outcome: AppServerApprovalOutcome,
): JsonObject | undefined {
  const { requestedSchema, meta } = approvalPrompt;
  const properties = isJsonObject(requestedSchema.properties)
    ? requestedSchema.properties
    : undefined;
  if (!properties) {
    return undefined;
  }
  const required = Array.isArray(requestedSchema.required)
    ? new Set(
        requestedSchema.required.filter((entry): entry is string => typeof entry === "string"),
      )
    : new Set<string>();
  const content: JsonObject = {};
  let sawApprovalField = false;

  for (const [name, value] of Object.entries(properties)) {
    const schema = isJsonObject(value) ? value : undefined;
    if (!schema) {
      continue;
    }
    const property = { name, schema, required: required.has(name) };
    const next =
      readApprovalFieldValue(property, outcome) ??
      readPersistFieldValue(property, meta, outcome, approvalPrompt.persistHintsMode ?? "legacy") ??
      readFallbackFieldValue(property, outcome);

    if (next === undefined) {
      if (isApprovalField(property)) {
        sawApprovalField = true;
      }
      if (property.required) {
        return undefined;
      }
      continue;
    }

    if (isApprovalField(property)) {
      sawApprovalField = true;
    }
    content[name] = next;
  }

  return sawApprovalField ? content : undefined;
}

function readApprovalFieldValue(
  property: ApprovalPropertyContext,
  outcome: AppServerApprovalOutcome,
): JsonValue | undefined {
  if (!isApprovalField(property)) {
    return undefined;
  }
  const type = readString(property.schema, "type");
  if (type === "boolean") {
    return true;
  }
  const options = readEnumOptions(property.schema);
  if (options.length === 0) {
    return undefined;
  }

  const sessionChoice = options.find((option) => isSessionApprovalOption(option));
  const acceptChoice = options.find((option) => isPositiveApprovalOption(option));
  if (outcome === "approved-session") {
    return sessionChoice?.value ?? acceptChoice?.value;
  }
  return acceptChoice?.value ?? sessionChoice?.value;
}

function readPersistFieldValue(
  property: ApprovalPropertyContext,
  meta: JsonObject,
  outcome: AppServerApprovalOutcome,
  persistHintsMode: "legacy" | "explicit",
): JsonValue | undefined {
  if (!isPersistField(property) || outcome !== "approved-session") {
    return undefined;
  }
  const persistHints = readPersistHints(meta, persistHintsMode);
  const options = readEnumOptions(property.schema);
  if (options.length === 0) {
    return undefined;
  }
  const preferred = choosePersistHint(persistHints);
  if (preferred) {
    const match = options.find(
      (option) => option.value === preferred || option.label === preferred,
    );
    return match?.value;
  }
  if (persistHintsMode === "explicit") {
    return chooseAlwaysPersistOptionValue(options);
  }
  return undefined;
}

function readDefaultValue(schema: JsonObject): JsonValue | undefined {
  return schema.default as JsonValue | undefined;
}

function readFallbackFieldValue(
  property: ApprovalPropertyContext,
  outcome: AppServerApprovalOutcome,
): JsonValue | undefined {
  if (outcome === "approved-once" && isPersistField(property)) {
    return undefined;
  }
  return readDefaultValue(property.schema);
}

function isApprovalField(property: ApprovalPropertyContext): boolean {
  const haystack = propertyText(property).toLowerCase();
  return /\b(approve|approval|allow|accept|decision)\b/.test(haystack);
}

function isPersistField(property: ApprovalPropertyContext): boolean {
  const haystack = propertyText(property).toLowerCase();
  return /\b(persist|session|always|scope)\b/.test(haystack);
}

function propertyText(property: ApprovalPropertyContext): string {
  return [
    property.name,
    readString(property.schema, "title"),
    readString(property.schema, "description"),
  ]
    .filter(Boolean)
    .join(" ");
}

function readPersistHints(meta: JsonObject, mode: "legacy" | "explicit" = "legacy"): string[] {
  const raw = meta.persist;
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string");
  }
  return mode === "legacy" ? ["session", "always"] : [];
}

function buildAcceptedMeta(
  meta: JsonObject,
  outcome: AppServerApprovalOutcome,
  persistHintsMode: "legacy" | "explicit",
): JsonObject | null {
  if (outcome !== "approved-session") {
    return null;
  }
  const persist = choosePersistHint(readPersistHints(meta, persistHintsMode));
  return persist ? { persist } : null;
}

function choosePersistHint(persistHints: string[]): "always" | "session" | undefined {
  if (persistHints.includes("always")) {
    return "always";
  }
  if (persistHints.includes("session")) {
    return "session";
  }
  return undefined;
}

function chooseAlwaysPersistOptionValue(
  options: Array<{ value: string; label: string }>,
): string | undefined {
  const always = options.find((option) => optionMatchesPersist(option, "always"));
  return always?.value;
}

function optionMatchesPersist(
  option: { value: string; label: string },
  persist: "always" | "session",
): boolean {
  return option.value.toLowerCase() === persist || option.label.toLowerCase() === persist;
}

function hasNoSchemaProperties(requestedSchema: JsonObject): boolean {
  const properties = isJsonObject(requestedSchema.properties) ? requestedSchema.properties : {};
  return Object.keys(properties).length === 0;
}

function readEnumOptions(schema: JsonObject): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((entry): entry is string => typeof entry === "string");
    const labels = Array.isArray(schema.enumNames)
      ? schema.enumNames.filter((entry): entry is string => typeof entry === "string")
      : [];
    return values.map((value, index) => ({ value, label: labels[index] ?? value }));
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .map((entry) => {
        const option = isJsonObject(entry) ? entry : undefined;
        const value = readString(option, "const");
        if (!value) {
          return undefined;
        }
        return { value, label: readString(option, "title") ?? value };
      })
      .filter((entry): entry is { value: string; label: string } => Boolean(entry));
  }
  return [];
}

function isPositiveApprovalOption(option: { value: string; label: string }): boolean {
  const haystack = `${option.value} ${option.label}`.toLowerCase();
  return /\b(allow|approve|accept|yes|continue|proceed|true)\b/.test(haystack);
}

function isSessionApprovalOption(option: { value: string; label: string }): boolean {
  const haystack = `${option.value} ${option.label}`.toLowerCase();
  return (
    /\b(session|always|persistent)\b/.test(haystack) && /\b(allow|approve|accept)\b/.test(haystack)
  );
}

function readString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readFirstString(record: JsonObject | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
