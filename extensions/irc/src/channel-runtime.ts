// Runtime-only IRC helpers for lazy chat plugin hooks.
// Keeping this boundary separate keeps bundled entry loads off monitor/send.
export { monitorIrcProvider } from "./monitor.js";
export { sendMessageIrc } from "./send.js";
