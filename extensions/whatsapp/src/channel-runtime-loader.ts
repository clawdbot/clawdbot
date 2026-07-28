// Whatsapp plugin module owns the source-safe channel runtime loading boundary.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadWhatsAppAuthStore = createLazyRuntimeModule(() => import("./auth-store.js"));

export async function isWhatsAppAuthConfigured(authDir: string): Promise<boolean> {
  const authStore = await loadWhatsAppAuthStore();
  return (await authStore.readWebAuthState(authDir)) === "linked";
}

// Source-loaded entry points must share this promise. Preloading auth-store keeps
// Jiti from exposing its partially evaluated exports through channel.runtime.
export const loadWhatsAppChannelRuntime = createLazyRuntimeModule(async () => {
  await loadWhatsAppAuthStore();
  return await import("./channel.runtime.js");
});
