import fs from "node:fs/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerApprovalPolicy, CodexAppServerSandboxMode } from "./config.js";
import type { CodexServiceTier } from "./protocol.js";

export type CodexAppServerThreadBinding = {
  schemaVersion: 1;
  threadId: string;
  sessionFile: string;
  cwd: string;
  authProfileId?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  dynamicToolsFingerprint?: string;
  createdAt: string;
  updatedAt: string;
};

export function resolveCodexAppServerBindingPath(sessionFile: string): string {
  return `${sessionFile}.codex-app-server.json`;
}

export async function readCodexAppServerBinding(
  sessionFile: string,
): Promise<CodexAppServerThreadBinding | undefined> {
  const path = resolveCodexAppServerBindingPath(sessionFile);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    embeddedAgentLog.warn("failed to read codex app-server binding", { path, error });
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CodexAppServerThreadBinding>;
    if (parsed.schemaVersion !== 1 || typeof parsed.threadId !== "string") {
      return undefined;
    }
    return {
      schemaVersion: 1,
      threadId: parsed.threadId,
      sessionFile,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      authProfileId: typeof parsed.authProfileId === "string" ? parsed.authProfileId : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : undefined,
      approvalPolicy: readApprovalPolicy(parsed.approvalPolicy),
      sandbox: readSandboxMode(parsed.sandbox),
      serviceTier: readServiceTier(parsed.serviceTier),
      dynamicToolsFingerprint:
        typeof parsed.dynamicToolsFingerprint === "string"
          ? parsed.dynamicToolsFingerprint
          : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to parse codex app-server binding", { path, error });
    return undefined;
  }
}

export async function writeCodexAppServerBinding(
  sessionFile: string,
  binding: Omit<
    CodexAppServerThreadBinding,
    "schemaVersion" | "sessionFile" | "createdAt" | "updatedAt"
  > & {
    createdAt?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const payload: CodexAppServerThreadBinding = {
    schemaVersion: 1,
    sessionFile,
    threadId: binding.threadId,
    cwd: binding.cwd,
    authProfileId: binding.authProfileId,
    model: binding.model,
    modelProvider: binding.modelProvider,
    approvalPolicy: binding.approvalPolicy,
    sandbox: binding.sandbox,
    serviceTier: binding.serviceTier,
    dynamicToolsFingerprint: binding.dynamicToolsFingerprint,
    createdAt: binding.createdAt ?? now,
    updatedAt: now,
  };
  await fs.writeFile(
    resolveCodexAppServerBindingPath(sessionFile),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

export async function clearCodexAppServerBinding(sessionFile: string): Promise<void> {
  try {
    await fs.unlink(resolveCodexAppServerBindingPath(sessionFile));
  } catch (error) {
    if (!isNotFound(error)) {
      embeddedAgentLog.warn("failed to clear codex app-server binding", { sessionFile, error });
    }
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function readApprovalPolicy(value: unknown): CodexAppServerApprovalPolicy | undefined {
  return value === "never" ||
    value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted"
    ? value
    : undefined;
}

function readSandboxMode(value: unknown): CodexAppServerSandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

function readServiceTier(value: unknown): CodexServiceTier | undefined {
  return value === "fast" || value === "flex" ? value : undefined;
}
