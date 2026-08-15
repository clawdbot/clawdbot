/** Public hook handler alias exposed to bundled/workspace hook modules. */
export type HookHandler = import("./internal-hook-types.js").InternalHookHandler;

/** Public hook API facade for hook modules that should not import internals directly. */
export { isAgentBootstrapEvent } from "./internal-hooks.js";
