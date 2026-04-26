import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const coldProviderSetupFiles = [
  "src/commands/auth-choice-options.ts",
  "src/commands/configure.gateway-auth.ts",
  "src/commands/provider-auth-guidance.ts",
  "src/flows/provider-flow.ts",
  "src/plugins/provider-auth-choices.ts",
  "src/plugins/provider-install-catalog.ts",
] as const;

const forbiddenRuntimeImports = [
  "providers.runtime.js",
  "provider-wizard.js",
  "provider-flow.runtime.js",
  "provider-auth-choice.runtime.js",
] as const;

describe("provider setup cold imports", () => {
  it("keeps auth/setup/configure metadata callers off static provider runtime imports", () => {
    for (const file of coldProviderSetupFiles) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      for (const importPath of forbiddenRuntimeImports) {
        const escapedImportPath = importPath.replaceAll(".", "\\.");
        const staticImportPattern = new RegExp(
          `(?:\\bfrom\\s+["'][^"']*${escapedImportPath}["']|\\bimport\\s+["'][^"']*${escapedImportPath}["'])`,
        );
        expect(source, `${file} must not statically import ${importPath}`).not.toMatch(
          staticImportPattern,
        );
      }
    }
  });
});
