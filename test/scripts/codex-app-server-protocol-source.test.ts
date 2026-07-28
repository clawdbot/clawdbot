// Codex App Server Protocol Source tests cover codex app server protocol source script behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageCodexAppServerProtocolArtifacts } from "../../scripts/lib/codex-app-server-protocol-artifacts.js";
import {
  buildCodexProtocolExportArgs,
  canonicalizeCodexAppServerProtocolJson,
  formatCodexAppServerProtocolJsonText,
  readCargoWorkspacePackageVersion,
  resolveCodexAppServerProtocolSource,
  resolveCodexProtocolCargoTargetDir,
  resolveCodexProtocolMinFreeBytes,
  resolveCodexProtocolPnpmCommand,
  validateCodexProtocolSourceVersion,
  validateCodexProtocolGenerationHeadroom,
} from "../../scripts/lib/codex-app-server-protocol-source.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const originalOpenClawCodexRepo = process.env.OPENCLAW_CODEX_REPO;

afterEach(() => {
  if (originalOpenClawCodexRepo === undefined) {
    delete process.env.OPENCLAW_CODEX_REPO;
  } else {
    process.env.OPENCLAW_CODEX_REPO = originalOpenClawCodexRepo;
  }
});

describe("Codex app-server generated artifact staging", () => {
  it("copies JSON bytes and normalizes nested TypeScript files in one pass", async () => {
    const sourceRoot = createTempDir("openclaw-protocol-artifacts-source-");
    const targetRoot = createTempDir("openclaw-protocol-artifacts-target-");
    const typescriptRoot = path.join(targetRoot, "typescript");
    const jsonRoot = path.join(targetRoot, "json");
    const rootTypeScript = [
      'import type { Root } from "./Root";',
      "export type { Parent } from '../Parent.js';",
      'export * as v2 from "./v2.js";',
      "export type Nullable = string | null | null;",
      "",
    ].join("\n");
    const nestedTypeScript = 'export type { Shared } from "../Shared";\n';
    const json = '{\n  "z": 1,\n  "a": 2\n}\n';
    fs.mkdirSync(path.join(sourceRoot, "v2"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "index.ts"), rootTypeScript);
    fs.writeFileSync(path.join(sourceRoot, "v2/Thing.ts"), nestedTypeScript);
    fs.writeFileSync(path.join(sourceRoot, "v2/Thing.json"), json);
    fs.writeFileSync(path.join(sourceRoot, "README.md"), "ignored\n");

    await stageCodexAppServerProtocolArtifacts(sourceRoot, { jsonRoot, typescriptRoot });

    expect(fs.readFileSync(path.join(typescriptRoot, "index.ts"), "utf8")).toBe(
      [
        'import type { Root } from "./Root.js";',
        "export type { Parent } from '../Parent.js';",
        'export * as v2 from "./v2/index.js";',
        "export type Nullable = string | null;",
        "",
      ].join("\n"),
    );
    expect(fs.readFileSync(path.join(typescriptRoot, "v2/Thing.ts"), "utf8")).toBe(
      'export type { Shared } from "../Shared.js";\n',
    );
    expect(fs.readFileSync(path.join(jsonRoot, "v2/Thing.json"), "utf8")).toBe(json);
    expect(fs.existsSync(path.join(typescriptRoot, "README.md"))).toBe(false);
    expect(fs.existsSync(path.join(jsonRoot, "README.md"))).toBe(false);
    expect(fs.readFileSync(path.join(sourceRoot, "index.ts"), "utf8")).toBe(rootTypeScript);
  });
});

describe("codex app-server protocol source resolver", () => {
  it("reads the Cargo workspace package version without matching sibling sections", () => {
    expect(
      readCargoWorkspacePackageVersion(`
[workspace]
members = []

[workspace.package] # shared crate metadata
version = "0.142.5"
edition = "2024"

[workspace.dependencies]
version = "9.9.9"
`),
    ).toBe("0.142.5");
    expect(readCargoWorkspacePackageVersion('[workspace.dependencies]\nversion = "9.9.9"\n')).toBe(
      undefined,
    );
  });

  it("rejects a Codex checkout that differs from the pinned package version", async () => {
    const repoRoot = createTempDir("openclaw-protocol-version-root-");
    const codexRepo = createTempDir("openclaw-protocol-version-codex-");
    fs.mkdirSync(path.join(repoRoot, "extensions/codex"), { recursive: true });
    fs.mkdirSync(path.join(codexRepo, "codex-rs"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "extensions/codex/package.json"),
      JSON.stringify({ dependencies: { "@openai/codex": "0.142.5" } }),
    );
    fs.writeFileSync(
      path.join(codexRepo, "codex-rs/Cargo.toml"),
      '[workspace.package]\nversion = "0.142.4"\n',
    );

    await expect(validateCodexProtocolSourceVersion({ codexRepo, repoRoot })).rejects.toThrow(
      /0\.142\.4 does not match @openai\/codex 0\.142\.5/,
    );
  });

  it("uses the app-server protocol export binary instead of compiling the full codex cli", () => {
    expect(buildCodexProtocolExportArgs("/codex/codex-rs/Cargo.toml", "/tmp/protocol")).toEqual([
      "run",
      "--manifest-path",
      "/codex/codex-rs/Cargo.toml",
      "-p",
      "codex-app-server-protocol",
      "--bin",
      "export",
      "--",
      "--out",
      "/tmp/protocol",
      "--experimental",
    ]);
  });

  it("fails before cargo protocol generation when local disk headroom is too low", () => {
    expect(() =>
      validateCodexProtocolGenerationHeadroom({
        freeBytes: 6 * 1024 * 1024 * 1024,
        minFreeBytes: 10 * 1024 * 1024 * 1024,
        pathLabel: "/repo",
      }),
    ).toThrow(/Run this check on Crabbox\/Testbox/);
  });

  it("allows an explicit local disk headroom override", () => {
    expect(resolveCodexProtocolMinFreeBytes({ OPENCLAW_CODEX_PROTOCOL_MIN_FREE_BYTES: "0" })).toBe(
      0,
    );
    expect(() =>
      validateCodexProtocolGenerationHeadroom({
        freeBytes: 1,
        minFreeBytes: 0,
        pathLabel: "/repo",
      }),
    ).not.toThrow();
  });

  it("rejects malformed local disk headroom overrides", () => {
    expect(() =>
      resolveCodexProtocolMinFreeBytes({ OPENCLAW_CODEX_PROTOCOL_MIN_FREE_BYTES: "nope" }),
    ).toThrow(/non-negative byte count/);
  });

  it("checks the Codex workspace target dir by default", () => {
    expect(resolveCodexProtocolCargoTargetDir("/codex", {})).toBe(
      path.join("/codex", "codex-rs", "target"),
    );
  });

  it("checks an explicit Cargo target dir override", () => {
    expect(
      resolveCodexProtocolCargoTargetDir("/codex", { CARGO_TARGET_DIR: "/cache/target" }),
    ).toBe(path.resolve("/cache/target"));
  });

  it("resolves relative Cargo target dir overrides from the Codex checkout", () => {
    expect(resolveCodexProtocolCargoTargetDir("/codex", { CARGO_TARGET_DIR: "target-cache" })).toBe(
      path.join("/codex", "target-cache"),
    );
  });

  it("checks Cargo's build target dir override", () => {
    expect(
      resolveCodexProtocolCargoTargetDir("/codex", {
        CARGO_BUILD_TARGET_DIR: "/cache/build-target",
      }),
    ).toBe(path.resolve("/cache/build-target"));
  });

  it("prefers Cargo's target dir override over the build config env override", () => {
    expect(
      resolveCodexProtocolCargoTargetDir("/codex", {
        CARGO_BUILD_TARGET_DIR: "/cache/build-target",
        CARGO_TARGET_DIR: "/cache/target",
      }),
    ).toBe(path.resolve("/cache/target"));
  });

  it("wraps Windows pnpm formatting through cmd.exe without shell mode", () => {
    expect(
      resolveCodexProtocolPnpmCommand(
        ["exec", "oxfmt", "--write", "--threads=1", String.raw`C:\tmp\generated types`],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          npmExecPath: String.raw`C:\Program Files\nodejs\pnpm.cmd`,
          platform: "win32",
        },
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`""C:\Program Files\nodejs\pnpm.cmd" exec oxfmt --write --threads=1 "C:\tmp\generated types""`,
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("uses OPENCLAW_CODEX_REPO when provided", async () => {
    const root = createTempDir("openclaw-protocol-source-root-");
    const codexRepo = createTempDir("openclaw-protocol-source-codex-");
    createProtocolSchema(codexRepo);
    process.env.OPENCLAW_CODEX_REPO = codexRepo;

    await expect(resolveCodexAppServerProtocolSource(root)).resolves.toEqual({
      codexRepo,
      sourceRoot: path.join(codexRepo, "codex-rs/app-server-protocol/schema"),
    });
  });

  it("finds the primary checkout sibling from a git worktree", async () => {
    const parentDir = createTempDir("openclaw-protocol-source-parent-");
    const primaryOpenClaw = path.join(parentDir, "openclaw");
    const codexRepo = path.join(parentDir, "codex");
    const worktreeRoot = createTempDir("openclaw-protocol-source-worktree-");
    fs.mkdirSync(path.join(primaryOpenClaw, ".git", "worktrees", "codex-harness"), {
      recursive: true,
    });
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(worktreeRoot, ".git"),
      `gitdir: ${path.join(primaryOpenClaw, ".git", "worktrees", "codex-harness")}\n`,
    );
    createProtocolSchema(codexRepo);
    delete process.env.OPENCLAW_CODEX_REPO;

    await expect(resolveCodexAppServerProtocolSource(worktreeRoot)).resolves.toEqual({
      codexRepo,
      sourceRoot: path.join(codexRepo, "codex-rs/app-server-protocol/schema"),
    });
  });
});

describe("Codex app-server protocol JSON canonicalizer", () => {
  it("sorts object keys recursively before formatting", () => {
    const source = JSON.stringify({
      z: {
        d: 1,
        b: {
          y: 2,
          x: 3,
        },
      },
      a: [
        {
          z: 4,
          a: {
            c: 5,
            b: 6,
          },
        },
      ],
    });

    expect(formatCodexAppServerProtocolJsonText(source)).toBe(`{
  "a": [
    {
      "a": {
        "b": 6,
        "c": 5
      },
      "z": 4
    }
  ],
  "z": {
    "b": {
      "x": 3,
      "y": 2
    },
    "d": 1
  }
}
`);
  });

  it("sorts typed-object arrays only for order-insensitive schema keywords", () => {
    expect(
      canonicalizeCodexAppServerProtocolJson({
        anyOf: [
          { z: 1, type: "string" },
          { type: "integer", a: 2 },
        ],
        enum: [
          { z: 1, type: "z" },
          { type: "a", a: 2 },
        ],
        mixed: [{ type: "b" }, "item", { type: "a" }],
        oneOf: [
          { type: "object", z: true },
          { a: true, type: "array" },
          { type: "object", z: false },
        ],
        prefixItems: [
          { z: 1, type: "string" },
          { type: "number", a: 2 },
        ],
        required: [
          { z: 1, type: "z" },
          { type: "a", a: 2 },
        ],
        typed: [
          { type: "beta", z: 1 },
          { type: "alpha", z: 2 },
          { type: "beta", z: 3 },
        ],
      }),
    ).toEqual({
      anyOf: [
        { a: 2, type: "integer" },
        { type: "string", z: 1 },
      ],
      enum: [
        { a: 2, type: "a" },
        { type: "z", z: 1 },
      ],
      mixed: [{ type: "b" }, "item", { type: "a" }],
      oneOf: [
        { a: true, type: "array" },
        { type: "object", z: true },
        { type: "object", z: false },
      ],
      prefixItems: [
        { type: "string", z: 1 },
        { a: 2, type: "number" },
      ],
      required: [
        { a: 2, type: "a" },
        { type: "z", z: 1 },
      ],
      typed: [
        { type: "beta", z: 1 },
        { type: "alpha", z: 2 },
        { type: "beta", z: 3 },
      ],
    });
  });
});

function createProtocolSchema(codexRepo: string): void {
  fs.mkdirSync(path.join(codexRepo, "codex-rs/app-server-protocol/schema/typescript"), {
    recursive: true,
  });
}
