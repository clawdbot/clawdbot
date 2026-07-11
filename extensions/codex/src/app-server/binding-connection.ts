// Codex helper module selects an app-server connection from private binding ownership.
import {
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexSupervisionAppServerRuntimeOptions,
  type CodexAppServerRuntimeOptions,
} from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

type CodexAppServerRuntimeOptionsParams = NonNullable<
  Parameters<typeof resolveCodexAppServerRuntimeOptions>[0]
>;

export type CodexBindingAppServerConnection = {
  appServer: CodexAppServerRuntimeOptions;
  usesSupervisionConnection: boolean;
  requestAuthProfileId: string | undefined;
  clientAuthProfileId: string | null | undefined;
};

export type CodexSupervisionModelSelection = {
  model: string;
  modelProvider: string;
};

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
  const appServer = (
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
