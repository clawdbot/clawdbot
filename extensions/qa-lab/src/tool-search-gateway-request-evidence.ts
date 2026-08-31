import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  countOccurrences,
  countSessionLogMentions,
  subtractMentionCounts,
} from "./fixture-utils.js";
import { qaMockRequestsAfterUrl } from "./providers/shared/debug-request-cursor.js";

const TOOL_SEARCH_REQUEST_EVIDENCE_LIMIT = 12;
const SAFE_TOOL_SEARCH_STAGE_NAMES = new Set([
  "tool_search_code",
  "tool_search",
  "tool_describe",
  "tool_call",
]);

function projectToolSearchGatewayLogFacts(logs: string, targetTool: string) {
  const safeTargets = [...SAFE_TOOL_SEARCH_STAGE_NAMES, targetTool].filter(Boolean);
  return {
    captured: logs.length > 0,
    mentions: Object.fromEntries(
      safeTargets.map((name) => [name, countOccurrences(logs, name, true) > 0]),
    ),
  };
}

function projectToolSearchProviderRequests(requests: unknown, targetTool: string) {
  if (!Array.isArray(requests)) {
    return [];
  }
  return requests.slice(-TOOL_SEARCH_REQUEST_EVIDENCE_LIMIT).map((request) => {
    const record = isRecord(request) ? request : {};
    const body = isRecord(record.body) ? record.body : {};
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const declaredNames = new Set(
      tools.flatMap((tool) => {
        if (!isRecord(tool)) {
          return [];
        }
        const name = isRecord(tool.function) ? tool.function.name : tool.name;
        return typeof name === "string" ? [name] : [];
      }),
    );
    const plannedToolName = record.plannedToolName;
    return {
      plannedToolName:
        typeof plannedToolName !== "string"
          ? null
          : plannedToolName === targetTool || SAFE_TOOL_SEARCH_STAGE_NAMES.has(plannedToolName)
            ? plannedToolName
            : "<other>",
      declaredToolCount: tools.length,
      targetDeclared: declaredNames.has(targetTool),
      bridgeDeclared: declaredNames.has("tool_search_code"),
      targetResultObserved:
        targetTool.length > 0 &&
        typeof record.toolOutput === "string" &&
        record.toolOutput.includes("FAKE_PLUGIN_OK") &&
        record.toolOutput.includes(targetTool),
    };
  });
}

export async function countToolSearchSessionLogMentions(params: {
  stateDir: string;
  targetTool: string;
}) {
  return countSessionLogMentions({
    identifierKeys: new Set([...SAFE_TOOL_SEARCH_STAGE_NAMES, params.targetTool]),
    sessionsDir: path.join(params.stateDir, "agents", "qa", "sessions"),
    needles: {
      tool_search_code: "tool_search_code",
      tool_search: "tool_search",
      tool_describe: "tool_describe",
      tool_call: "tool_call",
      [params.targetTool]: params.targetTool,
    },
  });
}

type FetchJson = (
  url: string,
  init?: RequestInit,
  options?: { timeoutMs?: number },
) => Promise<unknown>;

export async function throwToolSearchGatewayRequestFailure(params: {
  cause: unknown;
  fetchJson: FetchJson;
  gatewayLogs: string;
  lane: string;
  mentionCountsBefore: Record<string, number>;
  providerBaseUrl: string;
  requestCursorBefore: number;
  stateDir: string;
  targetTool: string;
}): Promise<never> {
  const requests = await params
    .fetchJson(qaMockRequestsAfterUrl(params.providerBaseUrl, params.requestCursorBefore))
    .catch(() => []);
  const mentionsAfter = await countToolSearchSessionLogMentions(params).catch(() => null);
  const sessionMentions = mentionsAfter
    ? subtractMentionCounts(mentionsAfter, params.mentionCountsBefore)
    : null;
  const providerRequests = projectToolSearchProviderRequests(requests, params.targetTool);
  const gatewayLogFacts = projectToolSearchGatewayLogFacts(params.gatewayLogs, params.targetTool);
  const httpStatus = /^HTTP (\d{3})\b/u.exec(
    params.cause instanceof Error ? params.cause.message : "",
  )?.[1];
  const errorCode =
    params.cause instanceof Error && "code" in params.cause && typeof params.cause.code === "string"
      ? params.cause.code
      : undefined;
  const safeFailure = httpStatus
    ? `HTTP ${httpStatus}`
    : errorCode === "ETIMEDOUT" || errorCode === "ETOOBIG"
      ? errorCode
      : "request failed";
  // Scenario formatting traverses causes; raw HTTP errors can include complete provider bodies.
  throw new Error(
    `Tool Search ${params.lane} lane gateway request failed (${safeFailure}); ` +
      `providerRequests=${JSON.stringify(providerRequests)}; ` +
      `sessionMentions=${JSON.stringify(sessionMentions)}; ` +
      `gatewayLogFacts=${JSON.stringify(gatewayLogFacts)}`,
  );
}
