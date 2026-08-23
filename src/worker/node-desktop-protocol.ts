import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerDesktopApp } from "../plugins/capability-provider.types.js";
import { NODE_DESKTOP_ATTACH_PATH } from "../shared/node-desktop-stream.js";

const REQUEST_MAX_BYTES = 16 * 1024;
const PATH_MAX_BYTES = 4 * 1024;
const TICKET_PATTERN = /^[a-f0-9]{48}$/u;

type NodeWorkerDesktopStreamInput = {
  ticket: string;
  attachPath: string;
  port: number;
  passwordFilePath?: string;
};

function parseJson(raw?: string | null): unknown {
  if (!raw || Buffer.byteLength(raw, "utf8") > REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: invalid node worker desktop request");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST: malformed node worker desktop request");
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > PATH_MAX_BYTES
  ) {
    throw new Error(`INVALID_REQUEST: ${label} must be a bounded absolute path`);
  }
  return value;
}

export function parseNodeWorkerDesktopStreamInput(
  raw?: string | null,
): NodeWorkerDesktopStreamInput {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ticket", "attachPath", "port"], ["passwordFilePath"])
  ) {
    throw new Error("INVALID_REQUEST: invalid node worker desktop stream request");
  }
  const ticket = value.ticket;
  const attachPath = value.attachPath;
  if (
    typeof ticket !== "string" ||
    !TICKET_PATTERN.test(ticket) ||
    attachPath !== `${NODE_DESKTOP_ATTACH_PATH}?ticket=${ticket}` ||
    !isValidPort(value.port)
  ) {
    throw new Error("INVALID_REQUEST: invalid node worker desktop stream request");
  }
  const passwordFilePath =
    value.passwordFilePath === undefined
      ? undefined
      : requireAbsolutePath(value.passwordFilePath, "passwordFilePath");
  return {
    ticket,
    attachPath,
    port: value.port,
    ...(passwordFilePath ? { passwordFilePath } : {}),
  };
}

export function parseNodeWorkerDesktopLaunchInput(raw?: string | null): WorkerDesktopApp {
  const value = parseJson(raw);
  if (!isRecord(value) || (value.id !== "browser" && value.id !== "terminal")) {
    throw new Error("INVALID_REQUEST: invalid node worker desktop app descriptor");
  }
  const executablePath = requireAbsolutePath(value.executablePath, "executablePath");
  if (value.id === "terminal") {
    if (!hasExactKeys(value, ["id", "executablePath"])) {
      throw new Error("INVALID_REQUEST: invalid node worker terminal descriptor");
    }
    return { id: "terminal", executablePath };
  }
  if (!hasExactKeys(value, ["id", "executablePath", "cdpPort"]) || !isValidPort(value.cdpPort)) {
    throw new Error("INVALID_REQUEST: invalid node worker browser descriptor");
  }
  return { id: "browser", executablePath, cdpPort: value.cdpPort };
}
