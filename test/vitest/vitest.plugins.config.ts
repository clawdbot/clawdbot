import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createPluginsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/plugins/**/*.test.ts"], {
    dir: "src/plugins",
    env,
    exclude: ["src/plugins/contracts/**", "src/plugins/loader.test.ts"],
    isolate: false,
    name: "plugins",
    passWithNoTests: true,
  });
}

export default createPluginsVitestConfig();
