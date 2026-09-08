import path from "node:path";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import { readCodexClientSessionMeta } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  isJsonObject,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

export function hasCodexNativeToolCatalog(
  binding: CodexAppServerThreadBinding | undefined,
): binding is CodexAppServerThreadBinding {
  return binding?.connectionScope === "supervision" && !binding.pendingSupervisionBranch;
}

/** Pinned serde omits empty catalogs and false deferLoading; declarations remain native-owned. */
export function parseCodexNativeToolCatalog(
  metadata: unknown,
  threadId: string,
  fingerprint?: string,
): CodexDynamicToolSpec[] {
  const fail = () =>
    new Error(
      "The canonical Codex native tool catalog is missing, corrupt, or changed; the thread is preserved. Reconnect and inspect its native metadata before retrying.",
    );
  if (!isJsonObject(metadata) || metadata.id !== threadId) {
    throw fail();
  }
  const catalog = metadata.dynamic_tools ?? [];
  if (!Array.isArray(catalog) || Buffer.byteLength(JSON.stringify(catalog)) > 1024 * 1024) {
    throw fail();
  }
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const validName = (name: unknown): name is string =>
    typeof name === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(name);
  const readFunction = (value: unknown): CodexDynamicToolFunctionSpec => {
    if (
      !isJsonObject(value) ||
      value.type !== "function" ||
      !validName(value.name) ||
      typeof value.description !== "string" ||
      !isJsonObject(value.inputSchema) ||
      (value.deferLoading !== undefined && typeof value.deferLoading !== "boolean") ||
      Object.keys(value).some(
        (key) => !["type", "name", "description", "inputSchema", "deferLoading"].includes(key),
      ) ||
      names.has(value.name) ||
      names.size >= 2000
    ) {
      throw fail();
    }
    names.add(value.name);
    return {
      type: "function",
      name: value.name,
      description: value.description,
      inputSchema: structuredClone(value.inputSchema),
      ...(value.deferLoading === true ? { deferLoading: true } : {}),
    };
  };
  const tools = catalog.map((value): CodexDynamicToolSpec => {
    if (!isJsonObject(value) || value.type !== "namespace") {
      return readFunction(value);
    }
    if (
      !validName(value.name) ||
      namespaces.has(value.name) ||
      typeof value.description !== "string" ||
      !Array.isArray(value.tools) ||
      !value.tools.length ||
      Object.keys(value).some((key) => !["type", "name", "description", "tools"].includes(key))
    ) {
      throw fail();
    }
    namespaces.add(value.name);
    return {
      type: "namespace",
      name: value.name,
      description: value.description,
      tools: value.tools.map(readFunction),
    };
  });
  if (fingerprint !== undefined && codexDynamicToolsFingerprint(tools) !== fingerprint) {
    throw fail();
  }
  return tools;
}

/** Existing supervised bindings identify data, never authorize an executor or a new adoption. */
export async function loadCodexNativeToolCatalog(params: {
  client: CodexAppServerClient;
  binding: CodexAppServerThreadBinding;
  appServer: CodexAppServerRuntimeOptions;
  agentDir: string;
  assertCurrent: () => void;
}): Promise<CodexDynamicToolSpec[]> {
  const { binding, client, appServer, agentDir, assertCurrent } = params;
  assertCurrent();
  const home = resolveCodexAppServerLocalHomeDir(appServer.start, agentDir);
  const actualHome = client.getRuntimeIdentity()?.codexHome;
  if (
    !hasCodexNativeToolCatalog(binding) ||
    !binding.dynamicToolsFingerprint ||
    appServer.start.transport !== "stdio" ||
    appServer.remoteWorkspaceRoot ||
    !actualHome ||
    path.resolve(actualHome) !== path.resolve(home) ||
    binding.appServerRuntimeFingerprint !==
      buildCodexAppServerConnectionFingerprint(appServer, agentDir)
  ) {
    throw new Error(
      "Canonical Codex declarations require the original verified local binding and selected native connection; the thread is preserved.",
    );
  }
  const metadata = await readCodexClientSessionMeta(
    client,
    path.join(home, "sessions"),
    binding.rolloutPath,
    binding.threadId,
  );
  assertCurrent();
  return parseCodexNativeToolCatalog(metadata, binding.threadId, binding.dynamicToolsFingerprint);
}
