import type { OpenClawConfig } from "./config/config.js";

function isTruthyEnvValue(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? "");
}

type BrowserControlStartupMode = "server" | "service";

/** Select the early-start owner without changing the standalone HTTP server contract. */
export function resolveBrowserControlStartupMode(
  config: OpenClawConfig,
  eagerEnvValue: string | undefined,
): BrowserControlStartupMode | null {
  if (isTruthyEnvValue(eagerEnvValue)) {
    return "server";
  }
  if (config.browser?.enabled === false) {
    return null;
  }
  const hasExtensionProfile = Object.values(config.browser?.profiles ?? {}).some(
    (profile) => profile.driver === "extension",
  );
  return hasExtensionProfile ? "service" : null;
}
