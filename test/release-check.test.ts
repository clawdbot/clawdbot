// Release check tests cover release validation script behavior.
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath, win32 } from "node:path";
import { bundledDistPluginFile, bundledPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { listBundledPluginPackArtifacts } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import {
  listPluginSdkDistArtifacts,
  listPrivateLocalOnlyPluginSdkDistArtifacts,
} from "../scripts/lib/plugin-sdk-entries.mjs";
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
  collectSkillShellScriptExecutableErrors,
  collectPackUnpackedSizeErrors,
  collectPackedInstalledPackageVerificationErrors,
  createPackedPluginSdkTypescriptSmokeProject,
  createPackedCompletionSmokeEnv,
  createPackedCliSmokeEnv,
  createPackedBundledPluginPostinstallEnv,
  MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES,
  PACKED_BUNDLED_RUNTIME_DEPS_REPAIR_ARGS,
  PACKED_CLI_SMOKE_COMMANDS,
  PACKED_COMPLETION_SMOKE_ARGS,
  packageNameFromSpecifier,
  resolvePackedTarballPath,
  resolveReleaseNpmCommand,
  resolveMissingPackBuildHint,
  runReleaseCheckCommand,
} from "../scripts/release-check.ts";
import { COMPLETION_SKIP_PLUGIN_COMMANDS_ENV } from "../src/cli/completion-runtime.ts";
import {
  LOCAL_BUILD_METADATA_DIST_PATHS,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "../src/infra/package-dist-inventory.ts";
import { withEnv } from "../src/test-utils/env.js";

function makeItem(shortVersion: string, sparkleVersion: string, channel?: string): string {
  const channelElement = channel ? `<sparkle:channel>${channel}</sparkle:channel>` : "";
  return `<item><title>${shortVersion}</title><sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString><sparkle:version>${sparkleVersion}</sparkle:version>${channelElement}</item>`;
}

function makePackResult(filename: string, unpackedSize: number) {
  return { filename, unpackedSize };
}

function withProcessEnv<T>(env: Record<string, string>, callback: () => T): T {
  return withEnv(env, callback);
}

const requiredPluginSdkPackPaths = [...listPluginSdkDistArtifacts(), "dist/plugin-sdk/compat.js"];
const privateLocalOnlyPluginSdkPackPaths = listPrivateLocalOnlyPluginSdkDistArtifacts();
const requiredBundledPluginPackPaths = listBundledPluginPackArtifacts();

describe("collectAppcastSparkleVersionErrors", () => {
  it("accepts legacy 9-digit calver builds before lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.2.26", "202602260")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toStrictEqual([]);
  });

  it("requires lane-floor builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "202603010")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
      "appcast item '2026.3.1' has sparkle:version 202603010 below lane floor 2026030190.",
    ]);
  });

  it("accepts canonical stable lane builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "2026030190")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toStrictEqual([]);
  });

  it("accepts canonical beta lane builds", () => {
    const xml = `<rss><channel>${makeItem("2026.6.5-beta.2", "2606000502", "beta")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toStrictEqual([]);
  });

  it("rejects beta builds on the default channel", () => {
    const xml = `<rss><channel>${makeItem("2026.6.5-beta.2", "2606000502")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
      "appcast item '2026.6.5-beta.2' must set sparkle:channel to 'beta'.",
    ]);
  });

  it("rejects appcast entries with invalid prerelease lanes", () => {
    const xml = `<rss><channel>${makeItem("2026.6.5-beta.0", "2606000500", "beta")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
      "appcast item '2026.6.5-beta.0' has invalid sparkle:shortVersionString '2026.6.5-beta.0'.",
    ]);
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
      ["models", "list", "--provider", "openai"],
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
      ComSpec: join("C:\\Windows", "System32", "cmd.exe"),
      APPDATA: join("/tmp/smoke-home", "AppData", "Roaming"),
      LOCALAPPDATA: join("/tmp/smoke-home", "AppData", "Local"),
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_SHARED_CREDENTIALS_FILE: join("/tmp/smoke-home", ".aws", "credentials"),
      AWS_CONFIG_FILE: join("/tmp/smoke-home", ".aws", "config"),
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
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/smoke-home",
      OPENCLAW_STATE_DIR: "/tmp/smoke-state",
      OPENCLAW_SUPPRESS_NOTES: "1",
      OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
      [COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]: "1",
    });
  });
});

describe("runReleaseCheckCommand", () => {
  it("returns captured command output", () => {
    expect(
      runReleaseCheckCommand(
        { command: process.execPath, args: ["--eval", "process.stdout.write('ok')"] },
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).toBe("ok");
  });

  it("bounds commands that ignore termination", () => {
    const startedAt = Date.now();

    expect(() =>
      runReleaseCheckCommand(
        {
          command: process.execPath,
          args: ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
        },
        { stdio: ["ignore", "pipe", "pipe"], timeoutMs: 100 },
      ),
    ).toThrow();
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  it("bounds captured command output", () => {
    expect(() =>
      runReleaseCheckCommand(
        { command: process.execPath, args: ["--eval", "process.stdout.write('x'.repeat(4096))"] },
        { maxBuffer: 1024, stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).toThrow();
  });

  it("rejects malformed command limit environment values", () => {
    withProcessEnv({ OPENCLAW_RELEASE_CHECK_COMMAND_TIMEOUT_MS: "1e3" }, () => {
      expect(() =>
        runReleaseCheckCommand(
          { command: process.execPath, args: ["--eval", "process.stdout.write('ok')"] },
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      ).toThrow("invalid OPENCLAW_RELEASE_CHECK_COMMAND_TIMEOUT_MS: 1e3");
    });

    withProcessEnv({ OPENCLAW_RELEASE_CHECK_COMMAND_MAX_BUFFER_BYTES: "16mb" }, () => {
      expect(() =>
        runReleaseCheckCommand(
          { command: process.execPath, args: ["--eval", "process.stdout.write('ok')"] },
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      ).toThrow("invalid OPENCLAW_RELEASE_CHECK_COMMAND_MAX_BUFFER_BYTES: 16mb");
    });
  });
});

describe("resolveReleaseNpmCommand", () => {
  it("wraps Windows npm.cmd release checks through cmd.exe without shell mode", () => {
    const nodeDir = "C:\\Program Files\\nodejs";
    const npmCmdPath = win32.resolve(nodeDir, "npm.cmd");

    expect(
      resolveReleaseNpmCommand(["pack", "--dry-run", "--json"], {
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: { PATH: "C:\\bin" },
        execPath: win32.join(nodeDir, "node.exe"),
        existsSync: (candidate) => candidate === npmCmdPath,
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npm.cmd" pack --dry-run --json"'],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("rejects bare npm fallback on Windows release checks", () => {
    expect(() =>
      resolveReleaseNpmCommand(["pack"], {
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        existsSync: () => false,
        platform: "win32",
      }),
    ).toThrow("OpenClaw refuses to shell out to bare npm on Windows");
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
      AWS_SHARED_CREDENTIALS_FILE: join("/tmp/bootstrap-home", ".aws", "credentials"),
      AWS_CONFIG_FILE: join("/tmp/bootstrap-home", ".aws", "config"),
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
    ).toStrictEqual([]);
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
        `{"name":"@openclaw/memory-lancedb","dependencies":{"root-owned-test-dep":"^1.0.0"}}\n`,
        "utf8",
      );
      writeFileSync(
        join(tempRoot, "dist", "lancedb-runtime-7TYK-Pto.js"),
        `//#region extensions/memory-lancedb/lancedb-runtime.ts\nimport("root-owned-test-dep");\n`,
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(tempRoot)).toStrictEqual([]);
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
        `{"name":"@openclaw/memory-lancedb","dependencies":{"root-owned-test-dep":"^1.0.0"}}\n`,
        "utf8",
      );
      writeFileSync(
        join(tempRoot, "dist", "root-runtime.js"),
        `import("root-owned-test-dep");\n`,
        "utf8",
      );

      expect(collectInstalledRootDependencyManifestErrors(tempRoot)).toEqual([
        "installed package root is missing declared runtime dependency 'root-owned-test-dep' for dist importers: root-runtime.js. Add it to package.json dependencies/optionalDependencies.",
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// This suite exists both as regression coverage and as an intentional CI touchpoint for executable-bit fixes.
// Windows doesn't support Unix permission bits; chmod 0o755 is a no-op and
// statSync().mode never reports execute bits, so these tests are meaningless there.
describe.skipIf(process.platform === "win32")("collectSkillShellScriptExecutableErrors", () => {
  it("flags non-executable shell scripts under skills/*/scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-"));
    const scriptPath = join(root, "skills", "openai-whisper-api", "scripts", "transcribe.sh");
    mkdirSync(join(root, "skills", "openai-whisper-api", "scripts"), { recursive: true });
    writeFileSync(scriptPath, "#!/usr/bin/env bash\necho test\n", "utf8");
    chmodSync(scriptPath, 0o644);

    try {
      expect(collectSkillShellScriptExecutableErrors(root)).toEqual([
        "skill shell script is not executable: skills/openai-whisper-api/scripts/transcribe.sh",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts executable shell scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-"));
    const scriptPath = join(root, "skills", "openai-whisper-api", "scripts", "transcribe.sh");
    mkdirSync(join(root, "skills", "openai-whisper-api", "scripts"), { recursive: true });
    writeFileSync(scriptPath, "#!/usr/bin/env bash\necho test\n", "utf8");
    chmodSync(scriptPath, 0o755);

    try {
      expect(collectSkillShellScriptExecutableErrors(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  it("blocks the old deep plugin SDK declaration tree from npm pack output", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        "dist/plugin-sdk/index.d.ts",
        "dist/plugin-sdk/types-abc123.d.ts",
        "dist/plugin-sdk/src/channels/plugins/types.public.d.ts",
        "dist/plugin-sdk/src/plugin-sdk/provider-entry.d.ts",
      ]),
    ).toEqual([
      "dist/plugin-sdk/src/channels/plugins/types.public.d.ts",
      "dist/plugin-sdk/src/plugin-sdk/provider-entry.d.ts",
    ]);
  });

  it("blocks local build metadata from npm pack output", () => {
    expect(
      collectForbiddenPackPaths(["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS]),
    ).toEqual([...LOCAL_BUILD_METADATA_DIST_PATHS]);
  });

  it("blocks Docker-selected external plugin trees from the core npm pack", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        "dist/extensions/clickclack/index.js",
        "dist/extensions/slack/setup-entry.js",
        "dist/extensions/msteams/openclaw.plugin.json",
      ]),
    ).toEqual([
      "dist/extensions/clickclack/index.js",
      "dist/extensions/msteams/openclaw.plugin.json",
      "dist/extensions/slack/setup-entry.js",
    ]);
  });

  it("keeps local build metadata excluded by package files", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files?: string[] };
    for (const entry of LOCAL_BUILD_METADATA_DIST_PATHS) {
      expect(pkg.files).toContain(`!${entry}`);
    }
    expect(pkg.files).toContain("!dist/plugin-sdk/src/**");
  });

  it("blocks private local-only plugin SDK artifacts from npm pack output", () => {
    expect(
      collectForbiddenPackPaths(["dist/index.js", ...privateLocalOnlyPluginSdkPackPaths]),
    ).toEqual([...privateLocalOnlyPluginSdkPackPaths].toSorted());
  });

  it("keeps private local-only plugin SDK artifacts excluded by package files", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files?: string[] };

    for (const entry of privateLocalOnlyPluginSdkPackPaths) {
      expect(pkg.files).toContain(`!${entry}`);
    }
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
        "qa/scenarios/index.yaml",
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
      "qa/scenarios/index.yaml",
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

  it("blocks root plugin SDK declarations that still reference private test helpers", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-release-private-sdk-"));

    try {
      mkdirSync(join(tempRoot, "dist", "plugin-sdk"), { recursive: true });
      writeFileSync(
        join(tempRoot, "dist", "plugin-sdk", "testing.d.ts"),
        "//#region src/plugin-sdk/test-helpers/session.ts\n",
        "utf8",
      );

      expect(collectForbiddenPackContentPaths(["dist/plugin-sdk/testing.d.ts"], tempRoot)).toEqual([
        "dist/plugin-sdk/testing.d.ts",
      ]);
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

    for (const path of [
      "dist/channel-catalog.json",
      PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
      "dist/control-ui/index.html",
      "scripts/npm-runner.mjs",
      "scripts/prepare-git-hooks.mjs",
      "scripts/preinstall-package-manager-warning.mjs",
      "scripts/lib/official-external-channel-catalog.json",
      "scripts/lib/official-external-plugin-catalog.json",
      "scripts/lib/official-external-provider-catalog.json",
      "scripts/lib/package-dist-imports.mjs",
      "scripts/postinstall-bundled-plugins.mjs",
      "dist/agents/compaction-planning.worker.js",
      "dist/agents/model-provider-auth.worker.js",
      "dist/audit/audit-event-writer.worker.js",
      "dist/task-registry-control.runtime.js",
      "dist/telegram-ingress-worker.runtime.js",
      bundledDistPluginFile("telegram", "runtime-api.js"),
      bundledDistPluginFile("telegram", "openclaw.plugin.json"),
      bundledDistPluginFile("telegram", "package.json"),
    ]) {
      expect(missing).toContain(path);
    }
  });

  it("accepts the shipped upgrade surface when optional bundled metadata is present", () => {
    expect(
      collectMissingPackPaths([
        "npm-shrinkwrap.json",
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
        "scripts/prepare-git-hooks.mjs",
        "scripts/preinstall-package-manager-warning.mjs",
        "scripts/lib/official-external-channel-catalog.json",
        "scripts/lib/official-external-plugin-catalog.json",
        "scripts/lib/official-external-provider-catalog.json",
        "scripts/lib/package-dist-imports.mjs",
        "scripts/postinstall-bundled-plugins.mjs",
        "dist/plugin-sdk/root-alias.cjs",
        "dist/agents/compaction-planning.worker.js",
        "dist/agents/model-provider-auth.worker.js",
        "dist/audit/audit-event-writer.worker.js",
        "dist/task-registry-control.runtime.js",
        "dist/telegram-ingress-worker.runtime.js",
        "dist/build-info.json",
        "dist/channel-catalog.json",
        PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
      ]),
    ).toStrictEqual([]);
  });

  it("runs postpublish package integrity checks against the packed install before publish", () => {
    const root = mkdtempSync(join(tmpdir(), "release-check-packed-install-"));
    try {
      const packageRoot = join(root, "openclaw");
      const distDir = join(packageRoot, "dist");
      mkdirSync(distDir, { recursive: true });
      for (const relativePath of [
        "facade-activation-check.runtime.js",
        "extensions/image-generation-core/runtime-api.js",
        "extensions/media-understanding-core/runtime-api.js",
      ]) {
        const filePath = join(distDir, relativePath);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, "export {};\n");
      }
      for (const pluginId of ["image-generation-core", "media-understanding-core"]) {
        writeFileSync(join(distDir, "extensions", pluginId, "package.json"), "{}\n");
      }
      writeFileSync(
        join(packageRoot, "package.json"),
        `${JSON.stringify({ name: "openclaw", version: "2026.5.14-beta.3", dependencies: {} })}\n`,
      );
      writeFileSync(join(distDir, "typescript-compiler.js"), "x".repeat(6 * 1024 * 1024 + 1));

      expect(
        collectPackedInstalledPackageVerificationErrors({
          expectedVersion: "2026.5.14-beta.3",
          installedBinaryVersion: "openclaw 2026.5.14-beta.3",
          packageRoot,
        }),
      ).toEqual([
        "installed package is missing required plugin SDK artifact: dist/plugin-sdk/zod.js",
        "installed package root dist file 'typescript-compiler.js' is invalid or exceeds 6291456 bytes.",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects packed plugin SDK root aliases that depend on minified export letters", () => {
    const root = mkdtempSync(join(tmpdir(), "release-check-packed-root-alias-"));
    try {
      const packageRoot = join(root, "openclaw");
      const pluginSdkDir = join(packageRoot, "dist", "plugin-sdk");
      mkdirSync(pluginSdkDir, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        `${JSON.stringify({ name: "openclaw", version: "2026.5.14-beta.3", dependencies: {} })}\n`,
      );
      writeFileSync(
        join(pluginSdkDir, "root-alias.cjs"),
        "module.exports = { onDiagnosticEvent: mod.r };\n",
      );

      expect(
        collectPackedInstalledPackageVerificationErrors({
          expectedVersion: "2026.5.14-beta.3",
          packageRoot,
        }),
      ).toContain(
        "installed package dist/plugin-sdk/root-alias.cjs depends on a single-letter bundled export alias.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires bundled plugin runtime sidecars that dynamic plugin boundaries resolve at runtime", () => {
    expect(requiredBundledPluginPackPaths).not.toContain(
      bundledDistPluginFile("slack", "runtime-api.js"),
    );
    expect(requiredBundledPluginPackPaths).toContain(
      bundledDistPluginFile("telegram", "runtime-api.js"),
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

describe("createPackedPluginSdkTypescriptSmokeProject", () => {
  it("writes a consumer project that imports representative public SDK subpaths", () => {
    const root = mkdtempSync(join(tmpdir(), "release-check-plugin-sdk-types-"));
    try {
      const consumerDir = join(root, "consumer");
      const packageRoot = join(root, "openclaw");
      createPackedPluginSdkTypescriptSmokeProject({
        consumerDir,
        packageSpec: `file:${packageRoot}`,
        aiPackageSpec: "file:/tmp/openclaw-ai.tgz",
      });

      const packageJson = JSON.parse(readFileSync(join(consumerDir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const tsconfig = JSON.parse(readFileSync(join(consumerDir, "tsconfig.json"), "utf8")) as {
        compilerOptions?: Record<string, unknown>;
      };
      const source = readFileSync(join(consumerDir, "src", "index.ts"), "utf8");
      const fixtureSource = readFileSync(
        "scripts/fixtures/packed-plugin-sdk-type-smoke.ts",
        "utf8",
      );

      expect(packageJson.dependencies?.openclaw).toBe(`file:${packageRoot}`);
      expect(packageJson.dependencies?.["@openclaw/ai"]).toBe("file:/tmp/openclaw-ai.tgz");
      expect(tsconfig.compilerOptions?.skipLibCheck).toBe(true);
      expect(source).toBe(fixtureSource);
      expect(source).toContain('"openclaw/plugin-sdk"');
      expect(source).toContain('"openclaw/plugin-sdk/provider-entry"');
      expect(source).toContain('"openclaw/plugin-sdk/channel-entry-contract"');
      expect(source).toContain('"openclaw/plugin-sdk/config-contracts"');
      expect(source).toContain('"openclaw/plugin-sdk/runtime-env"');
      expect(source).toContain("type PublicPluginSdkModules = [");
      expect(source).not.toContain("TelegramAccountConfig");
      expect(source).not.toContain("openclaw/plugin-sdk/channel-contract-testing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectPackUnpackedSizeErrors", () => {
  it("accepts pack results within the unpacked size budget", () => {
    expect(
      collectPackUnpackedSizeErrors([makePackResult("openclaw-2026.3.14.tgz", 120_354_302)]),
    ).toStrictEqual([]);
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

describe("resolvePackedTarballPath", () => {
  it("resolves one local npm pack tarball filename inside the pack destination", () => {
    expect(
      resolvePackedTarballPath("/tmp/openclaw-pack", [{ filename: "openclaw-2026.6.17.tgz" }]),
    ).toBe(resolvePath("/tmp/openclaw-pack", "openclaw-2026.6.17.tgz"));
    expect(
      resolvePackedTarballPath("/tmp/openclaw-pack", [
        { filename: "/tmp/openclaw-pack/openclaw-2026.6.17.tgz" },
      ]),
    ).toBe(resolvePath("/tmp/openclaw-pack", "openclaw-2026.6.17.tgz"));
  });

  it("rejects path-like npm pack tarball filenames", () => {
    const unsafeFilenames = [
      "../openclaw.tgz",
      "nested/openclaw.tgz",
      "nested\\openclaw.tgz",
      "/tmp/openclaw.tgz",
      "C:\\temp\\openclaw.tgz",
      "openclaw\u0000.tgz",
      "openclaw.tar.gz",
    ];

    for (const filename of unsafeFilenames) {
      expect(() => resolvePackedTarballPath("/tmp/openclaw-pack", [{ filename }])).toThrow(
        "release-check: npm pack reported unsafe tarball filename",
      );
    }
  });
});

describe("collectCriticalPluginSdkEntrypointSizeErrors", () => {
  it("flags oversized public plugin SDK entrypoints before publish", () => {
    const root = mkdtempSync(join(tmpdir(), "release-check-critical-sdk-"));
    try {
      const pluginSdkDir = join(root, "dist", "plugin-sdk");
      mkdirSync(pluginSdkDir, { recursive: true });
      writeFileSync(join(pluginSdkDir, "core.js"), "export {};\n");
      writeFileSync(join(pluginSdkDir, "runtime.js"), "export {};\n");
      writeFileSync(
        join(pluginSdkDir, "provider-entry.js"),
        "x".repeat(MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES + 1),
      );

      expect(collectCriticalPluginSdkEntrypointSizeErrors(root)).toEqual([
        `dist/plugin-sdk/provider-entry.js is ${
          MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES + 1
        } bytes, exceeding ${MAX_CRITICAL_PLUGIN_SDK_ENTRYPOINT_BYTES} bytes. Keep public SDK package entrypoints lazy and avoid bundling compiler/runtime internals.`,
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
