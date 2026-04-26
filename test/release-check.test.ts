import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import { listPluginSdkDistArtifacts } from "../scripts/lib/plugin-sdk-entries.mjs";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "../scripts/lib/workspace-bootstrap-smoke.mjs";
import { collectInstalledRootDependencyManifestErrors } from "../scripts/openclaw-npm-postpublish-verify.ts";
import {
  collectAppcastSparkleVersionErrors,
  collectBundledExtensionManifestErrors,
  collectBundledPluginRootRuntimeMirrorErrors,
  collectForbiddenPackContentPaths,
  collectInstalledBundledPluginRuntimeDepErrors,
  bundledRuntimeDependencySentinelCandidates,
  collectRootDistBundledRuntimeMirrors,
  collectForbiddenPackPaths,
  collectMissingPackPaths,
  collectPackUnpackedSizeErrors,
  createPackedCliSmokeEnv,
  createPackedBundledPluginPostinstallEnv,
  PACKED_CLI_SMOKE_COMMANDS,
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

describe("packed CLI smoke", () => {
  it("keeps the expected packaged CLI smoke command list", () => {
    expect(PACKED_CLI_SMOKE_COMMANDS).toEqual([
      ["--help"],
      ["status", "--json", "--timeout", "1"],
      ["config", "schema"],
      ["models", "list", "--provider", "amazon-bedrock"],
    ]);
  });

  it("builds a packed CLI smoke env with packaged-install guardrails", () => {
    expect(
      createPackedCliSmokeEnv(
        {
          PATH: "/usr/bin",
          HOME: "/tmp/original-home",
          USERPROFILE: "/tmp/original-profile",
          TMPDIR: "/tmp/original-tmp",
          SystemRoot: "C:\\Windows",
          GITHUB_TOKEN: "redacted",
          OPENAI_API_KEY: "real-secret",
          OPENCLAW_CONFIG_PATH: "/tmp/leaky-config.json",
        },
        { HOME: "/tmp/smoke-home", OPENCLAW_STATE_DIR: "/tmp/smoke-state" },
      ),
    ).toEqual({
      PATH:
        process.platform === "win32"
          ? `${dirname(process.execPath)};C:\\Windows\\System32;C:\\Windows`
          : `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: "/tmp/smoke-home",
      USERPROFILE: "/tmp/smoke-home",
      ComSpec: "C:\\Windows/System32/cmd.exe",
      APPDATA: "/tmp/smoke-home/AppData/Roaming",
      LOCALAPPDATA: "/tmp/smoke-home/AppData/Local",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_SHARED_CREDENTIALS_FILE: "/tmp/smoke-home/.aws/credentials",
      AWS_CONFIG_FILE: "/tmp/smoke-home/.aws/config",
      TMPDIR: "/tmp/original-tmp",
      SystemRoot: "C:\\Windows",
      OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_SUPPRESS_NOTES: "1",
      OPENCLAW_STATE_DIR: "/tmp/smoke-state",
    });
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
      ]);
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
      "installed package root is missing mirrored bundled runtime dependency '@larksuiteoapi/node-sdk' for dist importers: probe-Cz2PiFtC.js. Add it to package.json dependencies/optionalDependencies or keep imports under dist/extensions/feishu/.",
    ]);
  });

  it("does not derive root mirrors for root chunks sourced from the owning plugin", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-root-mirror-owned-"));

    try {
      const distDir = join(tempRoot, "dist");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(distDir, "probe-Cz2PiFtC.js"),
        `//#region extensions/feishu/client.ts\nimport("@larksuiteoapi/node-sdk");\n`,
        "utf8",
      );

      const mirrors = collectRootDistBundledRuntimeMirrors({
        bundledRuntimeDependencySpecs: makeBundledSpecs(),
        distDir,
      });

      expect([...mirrors.keys()]).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not require root deps for root chunks sourced from the owning installed plugin", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-root-owned-installed-"));

    try {
      mkdirSync(join(tempRoot, "dist", "extensions", "memory-lancedb"), { recursive: true });
      writeFileSync(
        join(tempRoot, "package.json"),
        `{"name":"openclaw","dependencies":{}}\n`,
        "utf8",
      );
      writeFileSync(
        join(tempRoot, "dist", "extensions", "memory-lancedb", "package.json"),
        `{"name":"@openclaw/memory-lancedb","dependencies":{"@lancedb/lancedb":"^0.27.2"}}\n`,
        "utf8",
      );
      writeFileSync(
        join(tempRoot, "dist", "lancedb-runtime-7TYK-Pto.js"),
        `//#region extensions/memory-lancedb/lancedb-runtime.ts\nimport("@lancedb/lancedb");\n`,
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(tempRoot)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("still requires root deps for root-owned installed chunks", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-root-owned-installed-missing-"));

    try {
      mkdirSync(join(tempRoot, "dist", "extensions", "memory-lancedb"), { recursive: true });
      writeFileSync(
        join(tempRoot, "package.json"),
        `{"name":"openclaw","dependencies":{}}\n`,
        "utf8",
      );
      writeFileSync(
        join(tempRoot, "dist", "extensions", "memory-lancedb", "package.json"),
        `{"name":"@openclaw/memory-lancedb","dependencies":{"@lancedb/lancedb":"^0.27.2"}}\n`,
        "utf8",
      );
      writeFileSync(
        join(tempRoot, "dist", "root-runtime.js"),
        `import("@lancedb/lancedb");\n`,
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(tempRoot)).toEqual([
        "installed package root is missing declared runtime dependency '@lancedb/lancedb' for dist importers: root-runtime.js. Add it to package.json dependencies/optionalDependencies.",
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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

  it("blocks legacy runtime dependency stamps from npm pack output", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        "dist/extensions/browser/.OpenClaw-Install-Stage/package.json",
        "dist/extensions/codex/.openclaw-runtime-deps-backup-node_modules-old/zod/index.js",
        "dist/extensions/discord/.openclaw-runtime-deps-stamp.json",
      ]),
    ).toEqual([
      "dist/extensions/browser/.OpenClaw-Install-Stage/package.json",
      "dist/extensions/codex/.openclaw-runtime-deps-backup-node_modules-old/zod/index.js",
      "dist/extensions/discord/.openclaw-runtime-deps-stamp.json",
    ]);
  });

  it("blocks private qa channel, qa lab, and suite paths from npm pack output", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        "dist/extensions/qa-channel/runtime-api.js",
        "dist/extensions/qa-lab/runtime-api.js",
        "dist/plugin-sdk/extensions/qa-lab/cli.d.ts",
        "dist/plugin-sdk/qa-lab.js",
        "dist/plugin-sdk/qa-runtime.js",
        "dist/qa-runtime-B9LDtssJ.js",
        "qa/scenarios/index.md",
      ]),
    ).toEqual([
      "dist/extensions/qa-channel/runtime-api.js",
      "dist/extensions/qa-lab/runtime-api.js",
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

describe("createPackedBundledPluginPostinstallEnv", () => {
  it("keeps packed postinstall on the lazy bundled dependency path", () => {
    expect(createPackedBundledPluginPostinstallEnv({ PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
    });
  });
});

describe("collectInstalledBundledPluginRuntimeDepErrors", () => {
  function createPackageRoot(): string {
    const packageRoot = mkdtempSync(join(tmpdir(), "release-check-installed-bundled-"));
    mkdirSync(join(packageRoot, "dist", "extensions"), { recursive: true });
    return packageRoot;
  }

  function writeBundledPluginPackageJson(
    packageRoot: string,
    pluginId: string,
    packageJson: Record<string, unknown>,
  ): void {
    const pluginRoot = join(packageRoot, "dist", "extensions", pluginId);
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, "package.json"), JSON.stringify(packageJson, null, 2));
  }

  function installRuntimeDependencyAtPackageRoot(
    packageRoot: string,
    dependencyName: string,
    version: string,
  ): void {
    const dependencyRoot = join(packageRoot, "node_modules", ...dependencyName.split("/"));
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(
      join(dependencyRoot, "package.json"),
      JSON.stringify({ name: dependencyName, version }, null, 2),
    );
  }

  it("returns no errors when declared deps are installed at the openclaw package root", () => {
    const packageRoot = createPackageRoot();
    try {
      writeBundledPluginPackageJson(packageRoot, "whatsapp", {
        name: "@openclaw/whatsapp",
        dependencies: { "@whiskeysockets/baileys": "7.0.0-rc.9" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      });
      installRuntimeDependencyAtPackageRoot(packageRoot, "@whiskeysockets/baileys", "7.0.0-rc.9");

      expect(collectInstalledBundledPluginRuntimeDepErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("surfaces an error naming the owning plugin and missing dependency", () => {
    const packageRoot = createPackageRoot();
    try {
      writeBundledPluginPackageJson(packageRoot, "whatsapp", {
        name: "@openclaw/whatsapp",
        dependencies: { "@whiskeysockets/baileys": "7.0.0-rc.9" },
        openclaw: { bundle: { stageRuntimeDependencies: true } },
      });

      expect(collectInstalledBundledPluginRuntimeDepErrors(packageRoot)).toEqual([
        "bundled plugin runtime dependency '@whiskeysockets/baileys@7.0.0-rc.9' (owners: whatsapp) is missing at node_modules/@whiskeysockets/baileys/package.json.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});

describe("bundledRuntimeDependencySentinelCandidates", () => {
  it("checks canonical external runtime-deps roots for packed installs", () => {
    const root = mkdtempSync(join(tmpdir(), "release-check-runtime-candidates-"));
    const packageRoot = join(root, "package");
    const aliasRoot = join(root, "package-alias");
    const homeRoot = join(root, "home");
    try {
      mkdirSync(join(packageRoot, "dist", "extensions", "browser"), { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.4.25-beta.1" }, null, 2),
      );
      symlinkSync(packageRoot, aliasRoot, "dir");

      const candidates = bundledRuntimeDependencySentinelCandidates(
        aliasRoot,
        "browser",
        "playwright-core",
        { HOME: homeRoot } as NodeJS.ProcessEnv,
      );
      const externalCandidates = candidates.filter(
        (candidate) =>
          candidate.startsWith(join(homeRoot, ".openclaw", "plugin-runtime-deps")) &&
          candidate.endsWith(join("node_modules", "playwright-core", "package.json")),
      );

      expect(externalCandidates.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
