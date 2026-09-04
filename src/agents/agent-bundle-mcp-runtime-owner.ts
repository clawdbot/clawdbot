import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

export type SessionMcpConfigReload = {
  cfg: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  reloadPlugins?: boolean;
};

type SessionMcpRuntimeOwner = {
  isCurrent: () => boolean;
  replace: (params: Parameters<CreateSessionMcpRuntime>[0]) => SessionMcpRuntime;
  reload: (params: SessionMcpConfigReload) => Promise<void>;
};

// SDK facades and the Gateway can load separate bundles of this module.
export const sessionMcpRuntimeOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionMcpRuntimeOwners"),
  () => new WeakMap<SessionMcpRuntime, SessionMcpRuntimeOwner>(),
);
