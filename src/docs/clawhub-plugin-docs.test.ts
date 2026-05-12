import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateExternalCodePluginPackageJson } from "../../packages/plugin-package-contract/src/index.ts";

const DOCS_ROOT = path.join(process.cwd(), "docs");
const pluginDocs = [
  path.join(DOCS_ROOT, "tools", "clawhub.md"),
  path.join(DOCS_ROOT, "plugins", "building-plugins.md"),
  path.join(DOCS_ROOT, "plugins", "sdk-setup.md"),
  path.join(DOCS_ROOT, "plugins", "sdk-provider-plugins.md"),
];

function extractNamedJsonBlock(markdown: string, label: string) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(
      `^[ \\t]*\\\`\\\`\\\`json ${escapedLabel}\\n([\\s\\S]*?)\\n[ \\t]*\\\`\\\`\\\``,
      "m",
    ),
  );
  if (!match?.[1]) {
    throw new Error(`Missing json code block for ${label}`);
  }
  return JSON.parse(match[1].trim()) as unknown;
}

describe("ClawHub plugin docs", () => {
  it("keeps the canonical plugin-publish snippets contract-valid", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(
        path.join(DOCS_ROOT, "snippets", "plugin-publish", "minimal-package.json"),
        "utf8",
      ),
    ) as unknown;
    const pluginManifest = JSON.parse(
      await fs.readFile(
        path.join(DOCS_ROOT, "snippets", "plugin-publish", "minimal-openclaw.plugin.json"),
        "utf8",
      ),
    ) as { id?: unknown; configSchema?: unknown };

    expect(validateExternalCodePluginPackageJson(packageJson).issues).toStrictEqual([]);
    expect(typeof pluginManifest.id).toBe("string");
    const { configSchema } = pluginManifest;
    if (configSchema === null) {
      throw new Error("expected minimal plugin config schema");
    }
    expect(typeof configSchema).toBe("object");
    expect(Array.isArray(configSchema)).toBe(false);
  });

  it("does not tell plugin authors to use bare clawhub publish", async () => {
    for (const docPath of pluginDocs) {
      const markdown = await fs.readFile(docPath, "utf8");
      expect(markdown).not.toMatch(/(^|[\s`])clawhub publish\b/);
    }
  });

  it("keeps the canonical package snippet embedded in the primary plugin docs", async () => {
    const snippet = JSON.parse(
      await fs.readFile(
        path.join(DOCS_ROOT, "snippets", "plugin-publish", "minimal-package.json"),
        "utf8",
      ),
    ) as unknown;
    const buildingPlugins = await fs.readFile(
      path.join(DOCS_ROOT, "plugins", "building-plugins.md"),
      "utf8",
    );
    const sdkSetup = await fs.readFile(path.join(DOCS_ROOT, "plugins", "sdk-setup.md"), "utf8");

    expect(extractNamedJsonBlock(buildingPlugins, "package.json")).toEqual(snippet);
    expect(extractNamedJsonBlock(sdkSetup, "openclaw-clawhub-package.json")).toEqual(snippet);
  });
});
