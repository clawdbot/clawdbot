import { describe, expect, it } from "vitest";
import {
  collectPluginNpmPublishedRuntimeErrors,
  findPackedPackageReadmePath,
  parseNpmReadmeMetadata,
  readPluginNpmCommandOptions,
  readPositiveIntEnv,
  resolveNpmPackFilename,
  runPluginNpmCommand,
} from "../../scripts/verify-plugin-npm-published-runtime.mjs";

describe("plugin npm publish verifier retry limits", () => {
  it("rejects loose numeric retry env values instead of parsing prefixes", () => {
    expect(() =>
      readPositiveIntEnv("OPENCLAW_PLUGIN_NPM_VERIFY_ATTEMPTS", 90, {
        OPENCLAW_PLUGIN_NPM_VERIFY_ATTEMPTS: "2tries",
      }),
    ).toThrow("invalid OPENCLAW_PLUGIN_NPM_VERIFY_ATTEMPTS: 2tries");
    expect(() =>
      readPositiveIntEnv("OPENCLAW_PLUGIN_NPM_VERIFY_DELAY_MS", 10000, {
        OPENCLAW_PLUGIN_NPM_VERIFY_DELAY_MS: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_PLUGIN_NPM_VERIFY_DELAY_MS: 1e3");
    expect(() =>
      readPositiveIntEnv("OPENCLAW_PLUGIN_NPM_README_VERIFY_ATTEMPTS", 6, {
        OPENCLAW_PLUGIN_NPM_README_VERIFY_ATTEMPTS: "0",
      }),
    ).toThrow("invalid OPENCLAW_PLUGIN_NPM_README_VERIFY_ATTEMPTS: 0");
  });

  it("accepts strict positive retry env values and defaults", () => {
    expect(readPositiveIntEnv("OPENCLAW_PLUGIN_NPM_VERIFY_ATTEMPTS", 90, {})).toBe(90);
    expect(
      readPositiveIntEnv("OPENCLAW_PLUGIN_NPM_README_VERIFY_DELAY_MS", 10000, {
        OPENCLAW_PLUGIN_NPM_README_VERIFY_DELAY_MS: "2500",
      }),
    ).toBe(2500);
  });
});

describe("plugin npm publish verifier command limits", () => {
  it("bounds npm command runtime and captured output by default", () => {
    expect(readPluginNpmCommandOptions({})).toStrictEqual({
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    });
  });

  it("accepts strict npm command timeout and buffer overrides", () => {
    expect(
      readPluginNpmCommandOptions({
        OPENCLAW_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: "33554432",
        OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: "120000",
      }),
    ).toMatchObject({
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120000,
    });
  });

  it("rejects loose npm command timeout and buffer overrides", () => {
    expect(() =>
      readPluginNpmCommandOptions({
        OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: "60s",
      }),
    ).toThrow("invalid OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: 60s");
    expect(() =>
      readPluginNpmCommandOptions({
        OPENCLAW_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: "16mb",
      }),
    ).toThrow("invalid OPENCLAW_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: 16mb");
  });

  it("runs npm metadata commands with bounded exec options", () => {
    const calls: unknown[] = [];
    const output = runPluginNpmCommand(["view", "@openclaw/discord", "readme"], {
      env: {
        OPENCLAW_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: "1024",
        OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS: "2500",
      },
      execFileSyncImpl(command: string, args: string[], options: unknown) {
        calls.push({ args, command, options });
        return JSON.stringify("# Discord");
      },
    });

    expect(output).toBe(JSON.stringify("# Discord"));
    expect(calls).toStrictEqual([
      {
        args: ["view", "@openclaw/discord", "readme"],
        command: "npm",
        options: {
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 2500,
        },
      },
    ]);
  });
});

describe("collectPluginNpmPublishedRuntimeErrors", () => {
  it("flags published plugin packages with TypeScript entries and no compiled runtime output", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        spec: "@openclaw/discord@2026.5.2",
        packageJson: {
          name: "@openclaw/discord",
          version: "2026.5.2",
          openclaw: {
            extensions: ["./index.ts"],
          },
        },
        files: ["package.json", "index.ts"],
      }),
    ).toEqual([
      "@openclaw/discord@2026.5.2 requires compiled runtime output for TypeScript entry ./index.ts: expected ./dist/index.js, ./dist/index.mjs, ./dist/index.cjs, ./index.js, ./index.mjs, ./index.cjs",
    ]);
  });

  it("accepts published plugin packages with explicit runtimeExtensions", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/zalo",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: ["package.json", "index.ts", "dist/index.js"],
      }),
    ).toStrictEqual([]);
  });

  it("flags missing explicit runtimeExtensions outputs", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/line",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./src/index.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: ["package.json", "src/index.ts"],
      }),
    ).toEqual(["@openclaw/line@2026.5.3 runtime extension entry not found: ./dist/index.js"]);
  });

  it("flags runtimeExtensions length mismatches", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/acpx",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts", "./tools.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: ["package.json", "dist/index.js"],
      }),
    ).toEqual([
      "@openclaw/acpx@2026.5.3 package.json openclaw.runtimeExtensions length (1) must match openclaw.extensions length (2)",
    ]);
  });

  it("flags blank runtimeExtensions entries instead of falling back to inferred outputs", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/whatsapp",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./src/index.ts"],
            runtimeExtensions: [" "],
          },
        },
        files: ["package.json", "src/index.ts", "dist/index.js"],
      }),
    ).toEqual([
      "@openclaw/whatsapp@2026.5.3 package.json openclaw.runtimeExtensions[0] must be a non-empty string",
    ]);
  });

  it("flags published plugin packages with TypeScript setup entries and no compiled setup runtime", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/line",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup-entry.ts",
          },
        },
        files: ["package.json", "index.ts", "dist/index.js", "setup-entry.ts"],
      }),
    ).toEqual([
      "@openclaw/line@2026.5.3 requires compiled runtime output for TypeScript entry ./setup-entry.ts: expected ./dist/setup-entry.js, ./dist/setup-entry.mjs, ./dist/setup-entry.cjs, ./setup-entry.js, ./setup-entry.mjs, ./setup-entry.cjs",
    ]);
  });

  it("accepts published plugin packages with explicit runtimeSetupEntry", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/qqbot",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup-entry.ts",
            runtimeSetupEntry: "./dist/setup-entry.js",
          },
        },
        files: ["package.json", "dist/index.js", "dist/setup-entry.js"],
      }),
    ).toStrictEqual([]);
  });

  it("flags missing explicit runtimeSetupEntry outputs", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/matrix",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup-entry.ts",
            runtimeSetupEntry: "./dist/setup-entry.js",
          },
        },
        files: ["package.json", "dist/index.js"],
      }),
    ).toEqual(["@openclaw/matrix@2026.5.3 runtime setup entry not found: ./dist/setup-entry.js"]);
  });

  it("flags runtimeSetupEntry without setupEntry", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@openclaw/twitch",
          version: "2026.5.3",
          openclaw: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            runtimeSetupEntry: "./dist/setup-entry.js",
          },
        },
        files: ["package.json", "dist/index.js", "dist/setup-entry.js"],
      }),
    ).toEqual([
      "@openclaw/twitch@2026.5.3 package.json openclaw.runtimeSetupEntry requires openclaw.setupEntry",
    ]);
  });
});

describe("resolveNpmPackFilename", () => {
  it("uses the final tarball filename from plain npm pack output", () => {
    const noisyOutput = [
      "npm notice",
      "npm notice package: @openclaw/msteams@2026.5.24-beta.1",
      "openclaw-msteams-2026.5.24-beta.1.tgz",
      "",
    ].join("\n");

    expect(resolveNpmPackFilename(noisyOutput)).toBe("openclaw-msteams-2026.5.24-beta.1.tgz");
  });
});

describe("findPackedPackageReadmePath", () => {
  it("finds a root package README without accepting nested documentation files", () => {
    expect(
      findPackedPackageReadmePath(["package.json", "docs/README.md", "README.md", "dist/index.js"]),
    ).toBe("README.md");
    expect(findPackedPackageReadmePath(["package.json", "docs/README.md"])).toBe("");
  });
});

describe("parseNpmReadmeMetadata", () => {
  it("accepts non-empty npm readme metadata", () => {
    expect(parseNpmReadmeMetadata(JSON.stringify("# Plugin\n\nInstall it."))).toBe(
      "# Plugin\n\nInstall it.",
    );
  });

  it("rejects empty or unsupported npm readme metadata", () => {
    expect(parseNpmReadmeMetadata(JSON.stringify(""))).toBe("");
    expect(parseNpmReadmeMetadata(JSON.stringify(null))).toBe("");
    expect(parseNpmReadmeMetadata("{")).toBe("");
  });
});
