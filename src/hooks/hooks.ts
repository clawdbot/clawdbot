export type HookHandler = import("./internal-hook-types.js").InternalHookHandler;

export type { AgentBootstrapHookContext } from "./internal-hooks.js";
export {
  createInternalHookEvent as createHookEvent,
  isAgentBootstrapEvent,
} from "./internal-hooks.js";
