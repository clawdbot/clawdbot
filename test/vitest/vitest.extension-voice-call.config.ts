import { createExtensionVitestConfig } from "./vitest.extension-config.ts";
// Vitest extension voice call config wires the extension voice call test shard.
import { voiceCallExtensionTestRoots } from "./vitest.extension-voice-call-paths.mjs";

export function createExtensionVoiceCallVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createExtensionVitestConfig("voice-call", voiceCallExtensionTestRoots, env);
}

export default createExtensionVoiceCallVitestConfig();
