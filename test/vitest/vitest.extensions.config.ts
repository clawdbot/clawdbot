import { BUNDLED_PLUGIN_TEST_GLOB } from "./vitest.bundled-plugin-paths.ts";
import { extensionExcludedChannelTestGlobs } from "./vitest.channel-paths.mjs";
import { acpxExtensionTestRoots } from "./vitest.extension-acpx-paths.mjs";
import { blueBubblesExtensionTestRoots } from "./vitest.extension-bluebubbles-paths.mjs";
import { diffsExtensionTestRoots } from "./vitest.extension-diffs-paths.mjs";
import { feishuExtensionTestRoots } from "./vitest.extension-feishu-paths.mjs";
import { ircExtensionTestRoots } from "./vitest.extension-irc-paths.mjs";
import { matrixExtensionTestRoots } from "./vitest.extension-matrix-paths.mjs";
import { mattermostExtensionTestRoots } from "./vitest.extension-mattermost-paths.mjs";
import { memoryExtensionTestRoots } from "./vitest.extension-memory-paths.mjs";
import { messagingExtensionTestRoots } from "./vitest.extension-messaging-paths.mjs";
import { msTeamsExtensionTestRoots } from "./vitest.extension-msteams-paths.mjs";
import {
  providerExtensionTestRoots,
  providerOpenAiExtensionTestRoots,
} from "./vitest.extension-provider-paths.mjs";
import { telegramExtensionTestRoots } from "./vitest.extension-telegram-paths.mjs";
import { voiceCallExtensionTestRoots } from "./vitest.extension-voice-call-paths.mjs";
import { whatsAppExtensionTestRoots } from "./vitest.extension-whatsapp-paths.mjs";
import { zaloExtensionTestRoots } from "./vitest.extension-zalo-paths.mjs";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function loadIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createExtensionsVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(loadIncludePatternsFromEnv(env) ?? [BUNDLED_PLUGIN_TEST_GLOB], {
    dir: "extensions",
    env,
    name: "extensions",
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
    // Some bundled plugins still run on the channel surface; keep those roots
    // out of the shared extensions lane.
    exclude: [
      ...extensionExcludedChannelTestGlobs,
      ...acpxExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...blueBubblesExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...diffsExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...feishuExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...ircExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...matrixExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...mattermostExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...memoryExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...messagingExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...msTeamsExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...providerOpenAiExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...providerExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...telegramExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...voiceCallExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...whatsAppExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
      ...zaloExtensionTestRoots.map((root) => `${root.replace(/^extensions\//u, "")}/**`),
    ],
  });
}

export default createExtensionsVitestConfig();
