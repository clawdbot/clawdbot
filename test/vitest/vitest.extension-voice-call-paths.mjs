// Test routing roots for voice-call extension tests.
import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const voiceCallExtensionIds = ["voice-call"];

export const voiceCallExtensionTestRoots = voiceCallExtensionIds.map((id) => bundledPluginRoot(id));

export function isVoiceCallExtensionRoot(root) {
  return voiceCallExtensionTestRoots.includes(root);
}
