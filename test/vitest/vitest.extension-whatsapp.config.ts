import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension whatsapp config wires the extension whatsapp test shard.
import { whatsAppExtensionTestRoots } from "./vitest.extension-whatsapp-paths.mjs";

export function createExtensionWhatsAppVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("whatsapp", whatsAppExtensionTestRoots, env);
}

export default createExtensionWhatsAppVitestConfig();
