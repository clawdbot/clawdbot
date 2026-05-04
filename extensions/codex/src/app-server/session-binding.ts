import fs from "node:fs/promises";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ensureAuthProfileStore,
  resolveOpenClawAgentDir,
  resolveProviderIdForAuth,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { CodexAppServerApprovalPolicy, CodexAppServerSandboxMode } from "./config.js";
import type { CodexServiceTier } from "./protocol.js";

const CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER = "openai-codex";
const PUBLIC_OPENAI_MODEL_PROVIDER = "openai";

type ProviderAuthAliasLookupParams = Parameters<typeof resolveProviderIdForAuth>[1];
type ProviderAuthAliasConfig = NonNullable<ProviderAuthAliasLookupParams>["config"];

export type CodexAppServerAuthProfileLookup = {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
};

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
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
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
    const authProfileId =
      typeof parsed.authProfileId === "string" ? parsed.authProfileId : undefined;
    return {
      schemaVersion: 1,
      threadId: parsed.threadId,
      sessionFile,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      authProfileId,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      modelProvider: normalizeCodexAppServerBindingModelProvider({
        ...lookup,
        authProfileId,
        modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : undefined,
      }),
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
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const payload: CodexAppServerThreadBinding = {
    schemaVersion: 1,
    sessionFile,
    threadId: binding.threadId,
    cwd: binding.cwd,
    authProfileId: binding.authProfileId,
    model: binding.model,
    modelProvider: normalizeCodexAppServerBindingModelProvider({
      ...lookup,
      authProfileId: binding.authProfileId,
      modelProvider: binding.modelProvider,
    }),
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

export function isCodexAppServerNativeAuthProfile(
  lookup: CodexAppServerAuthProfileLookup,
): boolean {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return false;
  }
  try {
    const credential = resolveCodexAppServerAuthProfileCredential({
      ...lookup,
      authProfileId,
    });
    return isCodexAppServerNativeAuthProvider({
      provider: credential?.provider,
      config: lookup.config,
    });
  } catch (error) {
    embeddedAgentLog.debug("failed to resolve codex app-server auth profile provider", {
      authProfileId,
      error,
    });
    return false;
  }
}

export function normalizeCodexAppServerBindingModelProvider(params: {
  authProfileId?: string;
  modelProvider?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
}): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider) {
    return undefined;
  }
  if (
    isCodexAppServerNativeAuthProfile(params) &&
    modelProvider.toLowerCase() === PUBLIC_OPENAI_MODEL_PROVIDER
  ) {
    return undefined;
  }
  return modelProvider;
}

function resolveCodexAppServerAuthProfileCredential(
  lookup: CodexAppServerAuthProfileLookup,
): AuthProfileStore["profiles"][string] | undefined {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return undefined;
  }
  const store = lookup.authProfileStore ?? loadCodexAppServerAuthProfileStore(lookup.agentDir);
  return store.profiles[authProfileId];
}

function loadCodexAppServerAuthProfileStore(agentDir: string | undefined): AuthProfileStore {
  return ensureAuthProfileStore(agentDir?.trim() || resolveOpenClawAgentDir(), {
    allowKeychainPrompt: false,
  });
}

function isCodexAppServerNativeAuthProvider(params: {
  provider?: string;
  config?: ProviderAuthAliasConfig;
}): boolean {
  const provider = params.provider?.trim();
  return Boolean(
    provider &&
    resolveProviderIdForAuth(provider, { config: params.config }) ===
      CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER,
  );
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
