export * from "./internal-hooks.js";

export type HookEventType = import("./internal-hooks.js").InternalHookEventType;
export type HookEvent = import("./internal-hooks.js").InternalHookEvent;
export type HookHandler = import("./internal-hook-types.js").InternalHookHandler;

export {
  registerInternalHook as registerHook,
  unregisterInternalHook as unregisterHook,
  clearInternalHooks as clearHooks,
  getRegisteredEventKeys as getRegisteredHookEventKeys,
  triggerInternalHook as triggerHook,
  createInternalHookEvent as createHookEvent,
} from "./internal-hooks.js";
