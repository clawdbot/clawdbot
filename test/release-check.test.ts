import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import { listPluginSdkDistArtifacts } from "../scripts/lib/plugin-sdk-entries.mjs";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../scripts/lib/workspace-bootstrap-smoke.mjs";
import {
  collectAppcastSparkleVersionErrors,
  collectBundledExtensionManifestErrors,
  collectBundledPluginRootRuntimeMirrorErrors,
  collectRootDistBundledRuntimeMirrors,
  collectForbiddenPackPaths,
  collectMissingPackPaths,
  collectPackUnpackedSizeErrors,
  listRequiredQaScenarioPackPaths,
  packageNameFromSpecifier,
} from "../scripts/release-check.ts";
import { bundledDistPluginFile, bundledPluginFile } from "./helpers/bundled-plugin-paths.js";

function makeItem(shortVersion: string, sparkleVersion: string): string {
  return `<item><title>${shortVersion}</title><sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString><sparkle:version>${sparkleVersion}</sparkle:version></item>`;
}

function makePackResult(filename: string, unpackedSize: number) {
  return { filename, unpackedSize };
}

const requiredPluginSdkPackPaths = [...listPluginSdkDistArtifacts(), "dist/plugin-sdk/compat.js"];
const requiredBundledPluginPackPaths = listBundledPluginPackArtifacts();
const requiredQaScenarioPackPaths = listRequiredQaScenarioPackPaths();

describe("collectAppcastSparkleVersionErrors", () => {
  it("accepts legacy 9-digit calver builds before lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.2.26", "202602260")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });

  it("requires lane-floor builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "202603010")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
      "appcast item '2026.3.1' has sparkle:version 202603010 below lane floor 2026030190.",
    ]);
  });

  it("accepts canonical stable lane builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "2026030190")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });
});

describe("collectBundledExtensionManifestErrors", () => {
  it("flags invalid bundled extension install metadata", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: { npmSpec: "   " },
            },
          },
        },
      ]),
    ).toEqual([
      "bundled extension 'broken' manifest invalid | openclaw.install.npmSpec must be a non-empty string",
    ]);
  });

  it("flags invalid bundled extension minHostVersion metadata", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: { npmSpec: "@openclaw/broken", minHostVersion: "2026.3.14" },
            },
          },
        },
      ]),
    ).toEqual([
      "bundled extension 'broken' manifest invalid | openclaw.install.minHostVersion must use a semver floor in the form \">=x.y.z\"",
    ]);
  });

  it("allows install metadata without npmSpec when only non-publish metadata is present", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "irc",
          packageJson: {
            openclaw: {
              install: { minHostVersion: ">=2026.3.14" },
            },
          },
        },
      ]),
    ).toEqual([]);
  });

  it("flags non-object install metadata instead of throwing", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: 123,
            },
          },
        },
      ]),
    ).toEqual(["bundled extension 'broken' manifest invalid | openclaw.install must be an object"]);
  });
});

describe("bundled plugin root runtime mirrors", () => {
  function makeBundledSpecs() {
    return new Map([
      ["@larksuiteoapi/node-sdk", { conflicts: [], pluginIds: ["feishu"], spec: "^1.60.0" }],
    ]);
  }

  it("maps package names from import specifiers", () => {
    expect(packageNameFromSpecifier("@larksuiteoapi/node-sdk/subpath")).toBe(
      "@larksuiteoapi/node-sdk",
    );
    expect(packageNameFromSpecifier("grammy/web")).toBe("grammy");
    expect(packageNameFromSpecifier("node:fs")).toBeNull();
    expect(packageNameFromSpecifier("./local")).toBeNull();
  });

  it("derives required root mirrors from built root dist imports", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-root-mirror-"));

    try {
      const distDir = join(tempRoot, "dist");
      mkdirSync(join(distDir, "extensions", "feishu"), { recursive: true });
      writeFileSync(
        join(distDir, "probe-Cz2PiFtC.js"),
        `import("@larksuiteoapi/node-sdk");\nrequire("grammy");\n`,
        "utf8",
      );
      writeFileSync(
        join(distDir, "extensions", "feishu", "index.js"),
        `import("@larksuiteoapi/node-sdk");\n`,
        "utf8",
      );

      const mirrors = collectRootDistBundledRuntimeMirrors({
        bundledRuntimeDependencySpecs: makeBundledSpecs(),
        distDir,
      });

      expect([...mirrors.keys()]).toEqual(["@larksuiteoapi/node-sdk"]);
      expect([...mirrors.get("@larksuiteoapi/node-sdk")!.importers]).toEqual(["probe-Cz2PiFtC.js"]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("flags missing root mirrors for plugin deps imported by root dist", () => {
    expect(
      collectBundledPluginRootRuntimeMirrorErrors({
        bundledRuntimeDependencySpecs: makeBundledSpecs(),
        requiredRootMirrors: new Map([
          [
            "@larksuiteoapi/node-sdk",
            {
              importers: new Set(["probe-Cz2PiFtC.js"]),
              pluginIds: ["feishu"],
              spec: "^1.60.0",
            },
          ],
        ]),
        rootPackageJson: { dependencies: {} },
      }),
    ).toEqual([
      "root dist imports bundled plugin runtime dependency '@larksuiteoapi/node-sdk' from probe-Cz2PiFtC.js; mirror '@larksuiteoapi/node-sdk: ^1.60.0' in root package.json (declared by feishu).",
    ]);
  });

  it("flags root mirror version drift from plugin manifests", () => {
    expect(
      collectBundledPluginRootRuntimeMirrorErrors({
        bundledRuntimeDependencySpecs: makeBundledSpecs(),
        requiredRootMirrors: new Map([
          [
            "@larksuiteoapi/node-sdk",
            {
              importers: new Set(["probe-Cz2PiFtC.js"]),
              pluginIds: ["feishu"],
              spec: "^1.60.0",
            },
          ],
        ]),
        rootPackageJson: { dependencies: { "@larksuiteoapi/node-sdk": "^1.61.0" } },
      }),
    ).toEqual([
      "root dist imports bundled plugin runtime dependency '@larksuiteoapi/node-sdk' from probe-Cz2PiFtC.js; root package.json has '^1.61.0' but plugin manifest declares '^1.60.0' (feishu).",
    ]);
  });

  it("accepts matching root mirrors for plugin deps imported by root dist", () => {
    expect(
      collectBundledPluginRootRuntimeMirrorErrors({
        bundledRuntimeDependencySpecs: makeBundledSpecs(),
        requiredRootMirrors: new Map([
          [
            "@larksuiteoapi/node-sdk",
            {
              importers: new Set(["probe-Cz2PiFtC.js"]),
              pluginIds: ["feishu"],
              spec: "^1.60.0",
            },
          ],
        ]),
        rootPackageJson: { dependencies: { "@larksuiteoapi/node-sdk": "^1.60.0" } },
      }),
    ).toEqual([]);
  });

  it("flags conflicting plugin dependency specs", () => {
    expect(
      collectBundledPluginRootRuntimeMirrorErrors({
        bundledRuntimeDependencySpecs: new Map([
          [
            "@example/sdk",
            {
              conflicts: [{ pluginId: "right", spec: "2.0.0" }],
              pluginIds: ["left"],
              spec: "1.0.0",
            },
          ],
        ]),
        requiredRootMirrors: new Map(),
        rootPackageJson: { dependencies: {} },
      }),
    ).toEqual([
      "bundled runtime dependency '@example/sdk' has conflicting plugin specs: left use '1.0.0', right uses '2.0.0'.",
    ]);
  });
});

describe("collectForbiddenPackPaths", () => {
  it("allows bundled plugin runtime deps under dist/extensions but still blocks other node_modules", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        bundledDistPluginFile("discord", "node_modules/@buape/carbon/index.js"),
        bundledPluginFile("tlon", "node_modules/.bin/tlon"),
        "node_modules/.bin/openclaw",
      ]),
    ).toEqual([bundledPluginFile("tlon", "node_modules/.bin/tlon"), "node_modules/.bin/openclaw"]);
  });

  it("blocks generated docs artifacts from npm pack output", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        "docs/.generated/config-baseline.json",
        "docs/.generated/config-baseline.core.json",
      ]),
    ).toEqual([
      "docs/.generated/config-baseline.core.json",
      "docs/.generated/config-baseline.json",
    ]);
  });

  it("blocks plugin SDK TypeScript build info from npm pack output", () => {
    expect(collectForbiddenPackPaths(["dist/index.js", "dist/plugin-sdk/.tsbuildinfo"])).toEqual([
      "dist/plugin-sdk/.tsbuildinfo",
    ]);
  });
});

describe("collectMissingPackPaths", () => {
  it("requires the shipped channel catalog, control ui, and optional bundled metadata", () => {
    const missing = collectMissingPackPaths([
      "dist/index.js",
      "dist/entry.js",
      "dist/plugin-sdk/compat.js",
      "dist/plugin-sdk/index.js",
      "dist/plugin-sdk/index.d.ts",
      "dist/plugin-sdk/root-alias.cjs",
      "dist/build-info.json",
    ]);

    expect(missing).toEqual(
      expect.arrayContaining([
        "dist/channel-catalog.json",
        "dist/control-ui/index.html",
        "qa/scenarios/index.md",
        "scripts/npm-runner.mjs",
        "scripts/postinstall-bundled-plugins.mjs",
        bundledDistPluginFile("diffs", "assets/viewer-runtime.js"),
        bundledDistPluginFile("matrix", "helper-api.js"),
        bundledDistPluginFile("matrix", "runtime-api.js"),
        bundledDistPluginFile("matrix", "thread-bindings-runtime.js"),
        bundledDistPluginFile("matrix", "openclaw.plugin.json"),
        bundledDistPluginFile("matrix", "package.json"),
        bundledDistPluginFile("whatsapp", "light-runtime-api.js"),
        bundledDistPluginFile("whatsapp", "runtime-api.js"),
        bundledDistPluginFile("whatsapp", "openclaw.plugin.json"),
        bundledDistPluginFile("whatsapp", "package.json"),
      ]),
    );
    expect(
      missing.some((path) => path.startsWith("qa/scenarios/") && path !== "qa/scenarios/index.md"),
    ).toBe(true);
  });

  it("accepts the shipped upgrade surface when optional bundled metadata is present", () => {
    expect(
      collectMissingPackPaths([
        "dist/index.js",
        "dist/entry.js",
        "dist/control-ui/index.html",
        "dist/extensions/acpx/mcp-proxy.mjs",
        bundledDistPluginFile("diffs", "assets/viewer-runtime.js"),
        ...requiredBundledPluginPackPaths,
        ...requiredQaScenarioPackPaths,
        ...requiredPluginSdkPackPaths,
        ...WORKSPACE_TEMPLATE_PACK_PATHS,
        "scripts/npm-runner.mjs",
        "scripts/postinstall-bundled-plugins.mjs",
        "dist/plugin-sdk/root-alias.cjs",
        "dist/build-info.json",
        "dist/channel-catalog.json",
      ]),
    ).toEqual([]);
  });

  it("requires bundled plugin runtime sidecars that dynamic plugin boundaries resolve at runtime", () => {
    expect(requiredBundledPluginPackPaths).toEqual(
      expect.arrayContaining([
        bundledDistPluginFile("matrix", "helper-api.js"),
        bundledDistPluginFile("matrix", "runtime-api.js"),
        bundledDistPluginFile("matrix", "thread-bindings-runtime.js"),
        bundledDistPluginFile("whatsapp", "light-runtime-api.js"),
        bundledDistPluginFile("whatsapp", "runtime-api.js"),
      ]),
    );
  });

  it("requires the authored qa scenario pack files in npm pack output", () => {
    expect(requiredQaScenarioPackPaths).toContain("qa/scenarios/index.md");
    expect(
      requiredQaScenarioPackPaths.some(
        (path) => path.startsWith("qa/scenarios/") && path !== "qa/scenarios/index.md",
      ),
    ).toBe(true);
  });
});

describe("collectPackUnpackedSizeErrors", () => {
  it("accepts pack results within the unpacked size budget", () => {
    expect(
      collectPackUnpackedSizeErrors([makePackResult("openclaw-2026.3.14.tgz", 120_354_302)]),
    ).toEqual([]);
  });

  it("flags oversized pack results that risk low-memory startup failures", () => {
    expect(
      collectPackUnpackedSizeErrors([makePackResult("openclaw-2026.3.12.tgz", 224_002_564)]),
    ).toEqual([
      "openclaw-2026.3.12.tgz unpackedSize 224002564 bytes (213.6 MiB) exceeds budget 211812352 bytes (202.0 MiB). Investigate duplicate channel shims, copied extension trees, or other accidental pack bloat before release.",
    ]);
  });

  it("fails closed when npm pack output omits unpackedSize for every result", () => {
    expect(
      collectPackUnpackedSizeErrors([
        { filename: "openclaw-2026.3.14.tgz" },
        { filename: "openclaw-extra.tgz", unpackedSize: Number.NaN },
      ]),
    ).toEqual([
      "npm pack --dry-run produced no unpackedSize data; pack size budget was not verified.",
    ]);
  });
});
