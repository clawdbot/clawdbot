import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ALLOWED_PLUGIN_SDK_FIXTURE_IMPORTS = new Set([
  // Intentional legacy SDK-root compatibility smoke tests.
  'src/plugins/loader.test.ts:configSchema: (require("openclaw/plugin-sdk").emptyPluginConfigSchema)(),',
  'src/plugins/loader.test.ts:const { onDiagnosticEvent } = require("openclaw/plugin-sdk");',
  // Intentional jiti alias regression test.
  'src/plugins/loader.git-path-regression.test.ts:`import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-send-deps";',
  'src/plugins/loader.git-path-regression.test.ts:          "openclaw/plugin-sdk/outbound-send-deps": ${JSON.stringify(copiedChannelRuntimeShim)},',
  // Intentional packaged bundled-plugin SDK alias regression tests.
  'src/plugins/loader.test.ts:`import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";`,',
]);

const LOADER_FIXTURE_TEST_FILES = [
  "src/plugins/loader.cli-metadata.test.ts",
  "src/plugins/loader.git-path-regression.test.ts",
  "src/plugins/loader.test.ts",
];

function findLoaderFixtureSdkImports(): string[] {
  const repoRoot = process.cwd();
  const matches: string[] = [];
  for (const file of LOADER_FIXTURE_TEST_FILES) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf-8");
    for (const line of source.split("\n")) {
      if (
        line.includes('require("openclaw/plugin-sdk') ||
        (line.includes("import ") && line.includes('"openclaw/plugin-sdk'))
      ) {
        matches.push(`${file}:${line.trim()}`);
      }
    }
  }
  return matches;
}

describe("plugin loader fixture SDK imports", () => {
  it("keeps generated jiti plugin fixtures off the SDK except explicit compatibility smokes", () => {
    const unexpected = findLoaderFixtureSdkImports().filter(
      (entry) => !ALLOWED_PLUGIN_SDK_FIXTURE_IMPORTS.has(entry),
    );

    expect(unexpected).toEqual([]);
  });
});
