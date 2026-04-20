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
  collectForbiddenPackContentPaths,
  collectRootDistBundledRuntimeMirrors,
  collectForbiddenPackPaths,
  collectMissingPackPaths,
  collectPackUnpackedSizeErrors,
  packageNameFromSpecifier,
} from "../scripts/release-check.ts";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "../src/infra/package-dist-inventory.ts";
import { bundledDistPluginFile, bundledPluginFile } from "./helpers/bundled-plugin-paths.js";

function makeItem(shortVersion: string, sparkleVersion: string): string {
  return `<item><title>${shortVersion}</title><sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString><sparkle:version>${sparkleVersion}</sparkle:version></item>`;
}

function makePackResult(filename: string, unpackedSize: number) {
  return { filename, unpackedSize };
}

const requiredPluginSdkPackPaths = [...listPluginSdkDistArtifacts(), "dist/plugin-sdk/compat.js"];
const requiredBundledPluginPackPaths = listBundledPluginPackArtifacts();

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
      [
        "@matrix-org/matrix-sdk-crypto-nodejs",
        { conflicts: [], pluginIds: ["matrix"], spec: "^0.4.0" },
      ],
      [
        "@matrix-org/matrix-sdk-crypto-wasm",
        { conflicts: [], pluginIds: ["matrix"], spec: "18.0.0" },
      ],
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
      mkdirSync(join(distDir, "extensions", "feishu", "node_modules", "@larksuiteoapi"), {
        recursive: true,
      });
      writeFileSync(
        join(distDir, "extensions", "feishu", "node_modules", "@larksuiteoapi", "node-sdk.js"),
        `import("@larksuiteoapi/node-sdk");\n`,
        "utf8",
      );

      const mirrors = collectRootDistBundledRuntimeMirrors({
        bundledRuntimeDependencySpecs: makeBundledSpecs(),
        distDir,
      });

      expect([...mirrors.keys()].toSorted((left, right) => left.localeCompare(right))).toEqual([
        "@larksuiteoapi/node-sdk",
        "@matrix-org/matrix-sdk-crypto-nodejs",
        "@matrix-org/matrix-sdk-crypto-wasm",
      ]);
      expect([...mirrors.get("@larksuiteoapi/node-sdk")!.importers]).toEqual([
        "extensions/feishu/index.js",
        "probe-Cz2PiFtC.js",
      ]);
      expect([...mirrors.get("@matrix-org/matrix-sdk-crypto-nodejs")!.importers]).toEqual([
        "<curated root runtime surface>",
      ]);
      expect([...mirrors.get("@matrix-org/matrix-sdk-crypto-wasm")!.importers]).toEqual([
        "<curated root runtime surface>",
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not require root mirrors for plugin deps imported by root dist", () => {
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
    ).toEqual([]);
  });

  it("does not compare root mirror versions for plugin manifest deps", () => {
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
    ).toEqual([]);
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
  it("blocks all packaged node_modules payloads", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        bundledDistPluginFile("discord", "node_modules/@buape/carbon/index.js"),
        bundledPluginFile("tlon", "node_modules/.bin/tlon"),
        "node_modules/.bin/openclaw",
      ]),
    ).toEqual([
      bundledDistPluginFile("discord", "node_modules/@buape/carbon/index.js"),
      bundledPluginFile("tlon", "node_modules/.bin/tlon"),
      "node_modules/.bin/openclaw",
    ]);
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

  it("blocks private qa lab and suite paths from npm pack output", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        "dist/extensions/qa-lab/runtime-api.js",
        "dist/plugin-sdk/extensions/qa-lab/cli.d.ts",
        "dist/plugin-sdk/qa-lab.js",
        "dist/plugin-sdk/qa-runtime.js",
        "dist/qa-runtime-B9LDtssJ.js",
        "qa/scenarios/index.md",
      ]),
    ).toEqual([
      "dist/plugin-sdk/extensions/qa-lab/cli.d.ts",
      "dist/plugin-sdk/qa-lab.js",
      "dist/plugin-sdk/qa-runtime.js",
      "dist/qa-runtime-B9LDtssJ.js",
      "qa/scenarios/index.md",
    ]);
  });

  it("blocks root dist chunks that still reference private qa lab sources", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-release-private-qa-"));

    try {
      mkdirSync(join(tempRoot, "dist"), { recursive: true });
      writeFileSync(
        join(tempRoot, "dist", "entry.js"),
        "//#region extensions/qa-lab/src/runtime-api.ts\n",
        "utf8",
      );
      writeFileSync(join(tempRoot, "CHANGELOG.md"), "local QA notes mention extensions/qa-lab/\n");

      expect(collectForbiddenPackContentPaths(["dist/entry.js", "CHANGELOG.md"], tempRoot)).toEqual(
        ["dist/entry.js"],
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows legacy QA compatibility paths in the generated dist inventory", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-release-inventory-"));

    try {
      mkdirSync(join(tempRoot, "dist"), { recursive: true });
      writeFileSync(
        join(tempRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH),
        JSON.stringify(["dist/extensions/qa-lab/runtime-api.js"]),
        "utf8",
      );

      expect(
        collectForbiddenPackContentPaths([PACKAGE_DIST_INVENTORY_RELATIVE_PATH], tempRoot),
      ).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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
        PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
        "dist/control-ui/index.html",
        "scripts/npm-runner.mjs",
        "scripts/preinstall-package-manager-warning.mjs",
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
  });

  it("accepts the shipped upgrade surface when optional bundled metadata is present", () => {
    expect(
      collectMissingPackPaths([
        "dist/index.js",
        "dist/entry.js",
        "dist/control-ui/index.html",
        "dist/extensions/qa-channel/runtime-api.js",
        "dist/extensions/qa-lab/runtime-api.js",
        "dist/extensions/acpx/mcp-proxy.mjs",
        bundledDistPluginFile("diffs", "assets/viewer-runtime.js"),
        ...requiredBundledPluginPackPaths,
        ...requiredPluginSdkPackPaths,
        ...WORKSPACE_TEMPLATE_PACK_PATHS,
        "scripts/npm-runner.mjs",
        "scripts/preinstall-package-manager-warning.mjs",
        "scripts/postinstall-bundled-plugins.mjs",
        "dist/plugin-sdk/root-alias.cjs",
        "dist/build-info.json",
        "dist/channel-catalog.json",
        PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
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
