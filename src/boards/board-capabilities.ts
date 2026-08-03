import {
  BOARD_WIDGET_TOOL_MAX_LENGTH,
  type BoardWidgetDeclared,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeSandboxHostCsp } from "../agents/sandbox-host.js";
import { BoardValidationError } from "./board-layout.js";

const MAX_DECLARED_ORIGINS = 32;
const MAX_DECLARED_TOOLS = 64;

function invalidDeclaration(message: string): never {
  throw new BoardValidationError("invalid_operation", message);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function normalizeBoardNetOrigin(value: string): string {
  if (value !== value.trim() || value.length === 0 || value.length > 2048) {
    return invalidDeclaration(`invalid board widget network origin: ${value}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidDeclaration(`invalid board widget network origin: ${value}`);
  }
  const supportedHostname =
    /^\[[0-9A-Fa-f:.]+\]$/u.test(parsed.hostname) || /^[A-Za-z0-9.-]+$/u.test(parsed.hostname);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !supportedHostname ||
    parsed.hostname.includes("*") ||
    parsed.hostname.endsWith(".")
  ) {
    return invalidDeclaration(
      `board widget network origin must be an exact HTTPS origin: ${value}`,
    );
  }
  return parsed.origin;
}

function normalizeTool(value: string): string {
  const tool = value.trim();
  if (
    tool.length === 0 ||
    tool.length > BOARD_WIDGET_TOOL_MAX_LENGTH ||
    tool !== value ||
    hasControlCharacter(tool)
  ) {
    return invalidDeclaration(`invalid board widget tool capability: ${value}`);
  }
  return tool;
}

export function normalizeBoardWidgetDeclared(
  declared: BoardWidgetDeclared | undefined,
): BoardWidgetDeclared | undefined {
  if (!declared) {
    return undefined;
  }
  if ((declared.netOrigins?.length ?? 0) > MAX_DECLARED_ORIGINS) {
    return invalidDeclaration(
      `board widget cannot declare more than ${MAX_DECLARED_ORIGINS} network origins`,
    );
  }
  if ((declared.tools?.length ?? 0) > MAX_DECLARED_TOOLS) {
    return invalidDeclaration(`board widget cannot declare more than ${MAX_DECLARED_TOOLS} tools`);
  }
  const netOrigins = [
    ...new Set((declared.netOrigins ?? []).map(normalizeBoardNetOrigin)),
  ].toSorted();
  const tools = [...new Set((declared.tools ?? []).map(normalizeTool))].toSorted();
  let sandboxOrigins: string[] | undefined;
  try {
    sandboxOrigins = normalizeSandboxHostCsp({ connectDomains: netOrigins })?.connectDomains;
  } catch {
    return invalidDeclaration("board widget network origins exceed safe CSP limits");
  }
  if (
    netOrigins.length > 0 &&
    (sandboxOrigins?.length !== netOrigins.length ||
      netOrigins.some((origin, index) => sandboxOrigins[index] !== origin))
  ) {
    return invalidDeclaration("board widget network origin is not supported by the sandbox host");
  }
  if (netOrigins.length === 0 && tools.length === 0) {
    return undefined;
  }
  return {
    ...(netOrigins.length > 0 ? { netOrigins } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

export function boardDeclarationIsSubset(
  requested: BoardWidgetDeclared | undefined,
  granted: BoardWidgetDeclared | undefined,
): boolean {
  const grantedOrigins = new Set(granted?.netOrigins ?? []);
  const grantedTools = new Set(granted?.tools ?? []);
  return (
    (requested?.netOrigins ?? []).every((origin) => grantedOrigins.has(origin)) &&
    (requested?.tools ?? []).every((tool) => grantedTools.has(tool))
  );
}

export function boardWidgetHasGrantedTool(
  declared: BoardWidgetDeclared | undefined,
  grantState: "none" | "pending" | "granted" | "rejected",
  tool: string,
): boolean {
  return grantState === "granted" && (declared?.tools ?? []).includes(tool);
}
