import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundledDistPluginFile, bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import { listPluginSdkDistArtifacts } from "../scripts/lib/plugin-sdk-entries.mjs";
import {
  WORKSPACE_TEMPLATE_PACK_PATHS,
  createWorkspaceBootstrapSmokeEnv,
} from "../scripts/lib/workspace-bootstrap-smoke.mjs";
import { collectInstalledRootDependencyManifestErrors } from "../scripts/openclaw-npm-postpublish-verify.ts";
import {
  collectAppcastSparkleVersionErrors,
  collectBundledExtensionManifestErrors,
  collectCriticalPluginSdkEntrypointSizeErrors,
  collectForbiddenPackContentPaths,
  collectForbiddenPackPaths,
  collectMissingPackPaths,
  collectPackUnpackedSizeErrors,
  createPackedCompletionSmokeEnv,
  createPackedCliSmokeEnv,
  createPackedBundledPluginPostinstallEnv,
  MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES,
  PACKED_BUNDLED_RUNTIME_DEPS_REPAIR_ARGS,
  PACKED_CLI_SMOKE_COMMANDS,
  PACKED_COMPLETION_SMOKE_ARGS,
  packageNameFromSpecifier,
  resolveMissingPackBuildHint,
} from "../scripts/release-check.ts";
import { COMPLETION_SKIP_PLUGIN_COMMANDS_ENV } from "../src/cli/completion-runtime.ts";
import {
  LOCAL_BUILD_METADATA_DIST_PATHS,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "../src/infra/package-dist-inventory.ts";

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
  it("keeps generated dynamic imports opaque to tsx's source lexer", () => {
    expect(readFileSync("scripts/release-check.ts", "utf8")).not.toContain("import(");
  });

  it("keeps the expected packaged CLI smoke command list", () => {
    expect(PACKED_CLI_SMOKE_COMMANDS).toEqual([
      ["--help"],
      ["onboard", "--help"],
      ["doctor", "--help"],
      ["status", "--json", "--timeout", "1"],
      ["config", "schema"],
      ["models", "list", "--provider", "amazon-bedrock"],
    ]);
  });

  it("repairs bundled runtime deps before the read-only plugin doctor smoke", () => {
    expect(PACKED_BUNDLED_RUNTIME_DEPS_REPAIR_ARGS).toEqual([
      "doctor",
      "--fix",
      "--non-interactive",
    ]);
  });

  it("keeps packed completion smoke scoped to one shell cache", () => {
    expect(PACKED_COMPLETION_SMOKE_ARGS).toEqual(["completion", "--write-state", "--shell", "zsh"]);
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
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      OPENCLAW_SUPPRESS_NOTES: "1",
      OPENCLAW_STATE_DIR: "/tmp/smoke-state",
    });
  });

  it("skips plugin command discovery during packed completion cache smoke", () => {
    expect(
      createPackedCompletionSmokeEnv(
        {
          PATH: "/usr/bin",
          OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS: "0",
        },
        {
          HOME: "/tmp/smoke-home",
          OPENCLAW_STATE_DIR: "/tmp/smoke-state",
        },
      ),
    ).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp/smoke-home",
      OPENCLAW_STATE_DIR: "/tmp/smoke-state",
      OPENCLAW_SUPPRESS_NOTES: "1",
      OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
      [COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]: "1",
    });
  });
});

describe("workspace bootstrap smoke", () => {
  it("runs with a sterile env instead of maintainer provider credentials", () => {
    expect(
      createWorkspaceBootstrapSmokeEnv(
        {
          PATH: "/usr/bin",
          HOME: "/tmp/original-home",
          TMPDIR: "/tmp/original-tmp",
          OPENAI_API_KEY: "real-secret",
          ANTHROPIC_API_KEY: "real-secret",
          OPENCLAW_CONFIG_PATH: "/tmp/leaky-config.json",
        },
        "/tmp/bootstrap-home",
      ),
    ).toEqual({
      PATH:
        process.platform === "win32"
          ? `${dirname(process.execPath)};C:\\Windows\\System32;C:\\Windows`
          : `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: "/tmp/bootstrap-home",
      USERPROFILE: "/tmp/bootstrap-home",
      OPENCLAW_HOME: "/tmp/bootstrap-home",
      TMPDIR: "/tmp/original-tmp",
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_SUPPRESS_NOTES: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_SHARED_CREDENTIALS_FILE: "/tmp/bootstrap-home/.aws/credentials",
      AWS_CONFIG_FILE: "/tmp/bootstrap-home/.aws/config",
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
      "bundled extension 'broken' manifest invalid | openclaw.install.minHostVersion must use a semver floor in the form \">=x.y.z[-prerelease][+build]\"",
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

describe("bundled plugin package dependency checks", () => {
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
});

describe("collectForbiddenPackPaths", () => {
  it("blocks all packaged node_modules payloads", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        bundledDistPluginFile("discord", "node_modules/@discordjs/voice/index.js"),
        bundledPluginFile("tlon", "node_modules/.bin/tlon"),
        "node_modules/.bin/openclaw",
      ]),
    ).toEqual([
      bundledDistPluginFile("discord", "node_modules/@discordjs/voice/index.js"),
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

  it("blocks local build metadata from npm pack output", () => {
    expect(
      collectForbiddenPackPaths(["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS]),
    ).toEqual([...LOCAL_BUILD_METADATA_DIST_PATHS]);
  });

  it("keeps local build metadata excluded by package files", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files?: string[] };
    expect(pkg.files).toEqual(
      expect.arrayContaining(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => `!${entry}`)),
    );
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
        "dist/plugin-sdk/extensions/qa-channel/api.d.ts",
        "dist/plugin-sdk/extensions/qa-lab/cli.d.ts",
        "dist/plugin-sdk/qa-channel.js",
        "dist/plugin-sdk/qa-channel-protocol.d.ts",
        "dist/plugin-sdk/qa-lab.js",
        "dist/plugin-sdk/qa-runtime.js",
        "dist/qa-runtime-B9LDtssJ.js",
        "docs/channels/qa-channel.md",
        "qa/scenarios/index.md",
      ]),
    ).toEqual([
      "dist/extensions/qa-channel/runtime-api.js",
      "dist/extensions/qa-lab/runtime-api.js",
      "dist/plugin-sdk/extensions/qa-channel/api.d.ts",
      "dist/plugin-sdk/extensions/qa-lab/cli.d.ts",
      "dist/plugin-sdk/qa-channel-protocol.d.ts",
      "dist/plugin-sdk/qa-channel.js",
      "dist/plugin-sdk/qa-lab.js",
      "dist/plugin-sdk/qa-runtime.js",
      "dist/qa-runtime-B9LDtssJ.js",
      "docs/channels/qa-channel.md",
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

  it("blocks private QA paths in the generated dist inventory", () => {
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
      ).toEqual([PACKAGE_DIST_INVENTORY_RELATIVE_PATH]);
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
        "scripts/lib/official-external-channel-catalog.json",
        "scripts/lib/official-external-plugin-catalog.json",
        "scripts/lib/official-external-provider-catalog.json",
        "scripts/lib/package-dist-imports.mjs",
        "scripts/postinstall-bundled-plugins.mjs",
        "dist/task-registry-control.runtime.js",
        bundledDistPluginFile("slack", "runtime-api.js"),
        bundledDistPluginFile("slack", "openclaw.plugin.json"),
        bundledDistPluginFile("slack", "package.json"),
        bundledDistPluginFile("telegram", "runtime-api.js"),
        bundledDistPluginFile("telegram", "openclaw.plugin.json"),
        bundledDistPluginFile("telegram", "package.json"),
      ]),
    );
  });

  it("accepts the shipped upgrade surface when optional bundled metadata is present", () => {
    expect(
      collectMissingPackPaths([
        "dist/index.js",
        "dist/entry.js",
        "dist/control-ui/index.html",
        "dist/extensions/acpx/error-format.mjs",
        "dist/extensions/acpx/mcp-command-line.mjs",
        "dist/extensions/acpx/mcp-proxy.mjs",
        ...requiredBundledPluginPackPaths,
        ...requiredPluginSdkPackPaths,
        ...WORKSPACE_TEMPLATE_PACK_PATHS,
        "scripts/npm-runner.mjs",
        "scripts/preinstall-package-manager-warning.mjs",
        "scripts/lib/official-external-channel-catalog.json",
        "scripts/lib/official-external-plugin-catalog.json",
        "scripts/lib/official-external-provider-catalog.json",
        "scripts/lib/package-dist-imports.mjs",
        "scripts/postinstall-bundled-plugins.mjs",
        "dist/plugin-sdk/root-alias.cjs",
        "dist/task-registry-control.runtime.js",
        "dist/build-info.json",
        "dist/channel-catalog.json",
        PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
      ]),
    ).toEqual([]);
  });

  it("requires bundled plugin runtime sidecars that dynamic plugin boundaries resolve at runtime", () => {
    expect(requiredBundledPluginPackPaths).toEqual(
      expect.arrayContaining([
        bundledDistPluginFile("slack", "runtime-api.js"),
        bundledDistPluginFile("telegram", "runtime-api.js"),
      ]),
    );
  });
});

describe("resolveMissingPackBuildHint", () => {
  it("points missing runtime build artifacts at pnpm build", () => {
    expect(resolveMissingPackBuildHint(["dist/build-info.json"])).toBe(
      "release-check: build artifacts are missing. Run `pnpm build` before `pnpm release:check`.",
    );
  });

  it("points missing Control UI artifacts at pnpm ui:build", () => {
    expect(resolveMissingPackBuildHint(["dist/control-ui/index.html"])).toBe(
      "release-check: Control UI artifacts are missing. Run `pnpm ui:build` before `pnpm release:check`.",
    );
  });

  it("points combined runtime and Control UI misses at both build commands", () => {
    expect(
      resolveMissingPackBuildHint(["dist/build-info.json", "dist/control-ui/index.html"]),
    ).toBe(
      "release-check: build and Control UI artifacts are missing. Run `pnpm build && pnpm ui:build` before `pnpm release:check`.",
    );
  });

  it("does not emit a build hint for unrelated packed paths", () => {
    expect(resolveMissingPackBuildHint(["scripts/npm-runner.mjs"])).toBeNull();
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

describe("collectCriticalPluginSdkEntrypointSizeErrors", () => {
  it("flags oversized plugin SDK test-contract entrypoints before publish", () => {
    const root = mkdtempSync(join(tmpdir(), "release-check-critical-sdk-"));
    try {
      const pluginSdkDir = join(root, "dist", "plugin-sdk");
      mkdirSync(pluginSdkDir, { recursive: true });
      writeFileSync(join(pluginSdkDir, "agent-runtime-test-contracts.js"), "export {};\n");
      writeFileSync(join(pluginSdkDir, "provider-test-contracts.js"), "export {};\n");
      writeFileSync(
        join(pluginSdkDir, "plugin-test-contracts.js"),
        "x".repeat(MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES + 1),
      );

      expect(collectCriticalPluginSdkEntrypointSizeErrors(root)).toEqual([
        `dist/plugin-sdk/plugin-test-contracts.js is ${
          MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES + 1
        } bytes, exceeding ${MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES} bytes. Keep public SDK test-contract entrypoints lazy and avoid bundling compiler/runtime internals.`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
