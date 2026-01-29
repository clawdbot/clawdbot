export * from "./internal-hooks.js";

export type HookEventType = import("./internal-hooks.js").InternalHookEventType;
export type HookEvent = import("./internal-hooks.js").InternalHookEvent;
export type HookHandler = import("./internal-hooks.js").InternalHookHandler;
export type MessageReceivedContext = import("./internal-hooks.js").MessageReceivedHookContext;

export {
  registerInternalHook as registerHook,
  unregisterInternalHook as unregisterHook,
  clearInternalHooks as clearHooks,
  getRegisteredEventKeys as getRegisteredHookEventKeys,
  triggerInternalHook as triggerHook,
  createInternalHookEvent as createHookEvent,
  isMessageReceivedEvent,
} from "./internal-hooks.js";
