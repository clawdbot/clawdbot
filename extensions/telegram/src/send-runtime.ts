import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Telegram plugin module owns the lazy send runtime import.
export type TelegramSendModule = typeof import("./send.js");

export const loadTelegramSendModule = createLazyRuntimeModule(() => import("./send.js"));
