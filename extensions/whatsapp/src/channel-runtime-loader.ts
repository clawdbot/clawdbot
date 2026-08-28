// Whatsapp plugin module owns the source-safe channel runtime loading boundary.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadWhatsAppAuthStore = createLazyRuntimeModule(() => import("./auth-store.js"));

export async function readWhatsAppAccountLinkState(
  authDir: string,
): Promise<"linked" | "not-linked" | "unknown"> {
  const authStore = await loadWhatsAppAuthStore();
  const state = await authStore.readWebAuthState(authDir);
  return state === "unstable" ? "unknown" : state;
}

// Source-loaded entry points must share this promise. Preloading auth-store keeps
// Jiti from exposing its partially evaluated exports through channel.runtime.
export const loadWhatsAppChannelRuntime = createLazyRuntimeModule(async () => {
  await loadWhatsAppAuthStore();
  return await import("./channel.runtime.js");
});
