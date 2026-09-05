import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpConfigReload, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

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
