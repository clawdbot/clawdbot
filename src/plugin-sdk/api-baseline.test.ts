import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePluginSdkApiDeclarationText } from "./api-baseline.js";

describe("Plugin SDK API baseline", () => {
  it("normalizes declaration import paths to repo-relative paths", () => {
    const repoRoot = process.cwd();
    const modelCatalogPath = path.join(repoRoot, "src", "agents", "pi-model-discovery-runtime");
    const declaration = `export function __setModelCatalogImportForTest(loader?: (() => Promise<typeof import("${modelCatalogPath}", { with: { "resolution-mode": "import" } })>) | undefined): void;`;

    const normalized = normalizePluginSdkApiDeclarationText(repoRoot, declaration);

    expect(normalized).not.toContain(repoRoot);
    expect(normalized).toContain(
      'import("src/agents/pi-model-discovery-runtime", { with: { "resolution-mode": "import" } })',
    );
  });
});
