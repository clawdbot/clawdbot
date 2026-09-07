// Codex helper module selects an app-server connection from private binding ownership.
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-registration";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerRuntimeOptions } from "./config-contracts.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./config-runtime.js";
import {
  buildCodexAppServerConnectionFingerprint,
  resolveCodexCatalogConnectionHome,
} from "./plugin-app-cache-key.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

type CodexAppServerRuntimeOptionsParams = NonNullable<
  Parameters<typeof resolveCodexAppServerRuntimeOptions>[0]
>;

type CodexBindingAppServerConnection = {
  appServer: CodexAppServerRuntimeOptions;
  usesSupervisionConnection: boolean;
  requestAuthProfileId: string | undefined;
  clientAuthProfileId: string | null | undefined;
};

type CodexSupervisionModelSelection = {
  model: string;
  modelProvider: string;
};

/** Prevents a prepared native session from becoming a fresh thread after its binding changes. */
export function assertCodexSessionRuntimeOwnership(
  binding:
    | Pick<
        CodexAppServerThreadBinding,
        "preserveNativeModel" | "connectionScope" | "model" | "modelProvider"
      >
    | undefined,
  expected: EmbeddedRunAttemptParamsV2["expectedSessionRuntimeOwnership"],
): void {
  if (!expected) {
    return;
  }
  const auth = binding?.connectionScope === "supervision" ? "native" : "host";
  const hostModelChanged =
    expected.auth === "host" &&
    (!expected.modelRef ||
      binding?.model !== expected.modelRef.model ||
      binding?.modelProvider !== expected.modelRef.provider);
  if (binding?.preserveNativeModel !== true || auth !== expected.auth || hostModelChanged) {
    throw new AgentHarnessPreflightError(
      "Codex native session ownership is missing or changed. Reattach the original native session or create a new chat with a concrete model; no replacement thread was started.",
    );
  }
}

/** Requires the native model pair after a supervised pending branch has materialized. */
export function requireCodexSupervisionModelSelection(
  binding: Pick<CodexAppServerThreadBinding, "connectionScope" | "model" | "modelProvider">,
): CodexSupervisionModelSelection {
  const model = binding.model?.trim();
  const modelProvider = binding.modelProvider?.trim();
  if (binding.connectionScope !== "supervision" || !model || !modelProvider) {
    throw new Error(
      "Codex supervised binding is missing its native model and provider; refusing request selection",
    );
  }
  return { model, modelProvider };
}

/** Resolves connection and auth ownership exclusively from the private thread binding. */
export function resolveCodexBindingAppServerConnection(
  params: CodexAppServerRuntimeOptionsParams & {
    binding?: Pick<
      CodexAppServerThreadBinding,
      "appServerRuntimeFingerprint" | "connectionScope" | "pendingSupervisionBranch"
    >;
    authProfileId?: string;
  },
): CodexBindingAppServerConnection {
  const { binding, authProfileId, ...runtimeParams } = params;
  const usesSupervisionConnection = binding?.connectionScope === "supervision";
  if (
    usesSupervisionConnection &&
    readCodexPluginConfig(runtimeParams.pluginConfig).supervision?.enabled !== true
  ) {
    throw new Error(
      "Codex supervision is disabled; refusing to open a native user-home supervised session",
    );
  }
  let appServer = (
    usesSupervisionConnection
      ? resolveCodexSupervisionAppServerRuntimeOptions
      : resolveCodexAppServerRuntimeOptions
  )(runtimeParams);
  if (usesSupervisionConnection) {
    // Thread ids are connection-local. Every binding-owned operation must reject
    // config drift before a copied id can reach another native Codex store.
    const persistedFingerprint =
      binding.pendingSupervisionBranch?.connectionFingerprint ??
      binding.appServerRuntimeFingerprint;
    const catalogHome = persistedFingerprint
      ? resolveCodexCatalogConnectionHome(persistedFingerprint, runtimeParams.agentDir)
      : undefined;
    if (catalogHome) {
      // Connection recovery changes only the store location. The freshly resolved
      // runtime keeps its native-model review and permission policy.
      appServer = {
        ...appServer,
        start: {
          ...appServer.start,
          homeScope: "user",
          env: { ...appServer.start.env, CODEX_HOME: catalogHome },
        },
      };
    }
    const currentFingerprint = buildCodexAppServerConnectionFingerprint(
      appServer,
      runtimeParams.agentDir,
    );
    if (!persistedFingerprint || persistedFingerprint !== currentFingerprint) {
      throw new Error(
        "Codex supervision connection changed; refusing to operate on its bound native thread",
      );
    }
  }
  return {
    appServer,
    usesSupervisionConnection,
    requestAuthProfileId: usesSupervisionConnection ? undefined : authProfileId,
    clientAuthProfileId: usesSupervisionConnection ? null : authProfileId,
  };
}
