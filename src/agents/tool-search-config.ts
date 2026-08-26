import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  MAX_TOOL_SEARCH_RESULTS,
  type ToolSearchConfig,
  type ToolSearchMode,
} from "./tool-search-types.js";

const DEFAULT_CODE_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_MAX_SEARCH_LIMIT = 20;

function readToolSearchConfig(config?: OpenClawConfig): Record<string, unknown> {
  const tools = isRecord(config?.tools) ? config.tools : undefined;
  const toolSearch = tools?.toolSearch;
  if (toolSearch === true) {
    return { enabled: true };
  }
  if (toolSearch === false) {
    return { enabled: false };
  }
  return isRecord(toolSearch) ? toolSearch : {};
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

let toolSearchCodeModeSupportedForTest: boolean | undefined;
let toolSearchMinCodeTimeoutMsForTest: number | undefined;

export function isToolSearchCodeModeSupported(): boolean {
  if (toolSearchCodeModeSupportedForTest !== undefined) {
    return toolSearchCodeModeSupportedForTest;
  }
  // Electron advertises Node flags but process.execPath remains the host binary,
  // so the isolated code child cannot be launched as a plain Node process.
  return (
    typeof process.versions.electron !== "string" &&
    process.allowedNodeEnvironmentFlags.has("--permission")
  );
}

function resolveMinCodeTimeoutMs(): number {
  return toolSearchMinCodeTimeoutMsForTest ?? 1000;
}

export function resolveToolSearchConfig(config?: OpenClawConfig): ToolSearchConfig {
  const raw = readToolSearchConfig(config);
  const rawMode = typeof raw.mode === "string" ? raw.mode : "code";
  const requestedMode: ToolSearchMode =
    rawMode === "tools" || rawMode === "directory" || rawMode === "code" ? rawMode : "code";
  const mode: ToolSearchMode =
    requestedMode === "code" && !isToolSearchCodeModeSupported() ? "tools" : requestedMode;
  const configured = Object.keys(raw).some((key) => key !== "enabled");
  const maxSearchLimit = Math.max(
    1,
    Math.min(MAX_TOOL_SEARCH_RESULTS, readInteger(raw.maxSearchLimit, DEFAULT_MAX_SEARCH_LIMIT)),
  );
  return {
    enabled: resolveBoolean(raw.enabled, configured),
    mode,
    codeTimeoutMs: Math.max(
      resolveMinCodeTimeoutMs(),
      Math.min(60_000, readInteger(raw.codeTimeoutMs, DEFAULT_CODE_TIMEOUT_MS)),
    ),
    searchDefaultLimit: Math.max(
      1,
      Math.min(maxSearchLimit, readInteger(raw.searchDefaultLimit, DEFAULT_SEARCH_LIMIT)),
    ),
    maxSearchLimit,
  };
}

export function setToolSearchCodeModeSupportedForTest(value: boolean | undefined): void {
  toolSearchCodeModeSupportedForTest = value;
}

export function setToolSearchMinCodeTimeoutMsForTest(value: number | undefined): void {
  toolSearchMinCodeTimeoutMsForTest =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : undefined;
}
