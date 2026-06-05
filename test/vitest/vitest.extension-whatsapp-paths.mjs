// Test routing roots for WhatsApp extension tests.
import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const whatsAppExtensionIds = ["whatsapp"];

export const whatsAppExtensionTestRoots = whatsAppExtensionIds.map((id) => bundledPluginRoot(id));

export function isWhatsAppExtensionRoot(root) {
  return whatsAppExtensionTestRoots.includes(root);
}
