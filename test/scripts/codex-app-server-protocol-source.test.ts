import { spawnSync } from "node:child_process";
// Codex App Server Protocol Source tests cover codex app server protocol source script behavior.
import fs from "node:fs";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { stageCodexAppServerProtocolArtifacts } from "../../scripts/lib/codex-app-server-protocol-artifacts.js";
import {
  buildCodexProtocolFixtureCommand,
  canonicalizeCodexAppServerProtocolJson,
  codexAppServerSharedDefinitionsSchema,
  compactCodexAppServerProtocolJsonSchemas,
  expandCodexAppServerProtocolJsonSchema,
  formatCodexAppServerProtocolJsonText,
  materializeCodexProtocolPrecomputedExports,
  readCargoWorkspacePackageVersion,
  resolveCodexAppServerProtocolSource,
  resolveCodexProtocolCargoTargetDir,
  resolveCodexProtocolMinFreeBytes,
  resolveCodexProtocolPnpmCommand,
  selectedCodexAppServerJsonSchemas,
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

  it("materializes the upstream experimental precomputed export tree", async () => {
    const root = createTempDir("openclaw-protocol-precomputed-");
    const archivePath = path.join(root, "precomputed/app-server-exports-experimental.json.zst");
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(
      archivePath,
      zstdCompressSync(
        JSON.stringify({
          typescript: { "v2/Thing.ts": "export type Thing = string;\n" },
          json_schema: { "v2/Thing.json": '{"type":"string"}\n' },
          internal_json_schema: {},
        }),
      ),
    );

    await materializeCodexProtocolPrecomputedExports(root);

    expect(fs.readFileSync(path.join(root, "v2/Thing.ts"), "utf8")).toBe(
      "export type Thing = string;\n",
    );
    expect(fs.readFileSync(path.join(root, "v2/Thing.json"), "utf8")).toBe('{"type":"string"}\n');
    expect(fs.existsSync(archivePath)).toBe(false);
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

  it("requires HEAD to equal the peeled exact-version tag", async () => {
    const repoRoot = createTempDir("openclaw-protocol-version-root-");
    const codexRepo = createTempDir("openclaw-protocol-version-codex-");
    fs.mkdirSync(path.join(repoRoot, "extensions/codex"), { recursive: true });
    fs.mkdirSync(path.join(codexRepo, "codex-rs"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "extensions/codex/package.json"),
      JSON.stringify({ dependencies: { "@openai/codex": "0.149.0" } }),
    );
    fs.writeFileSync(
      path.join(codexRepo, "codex-rs/Cargo.toml"),
      '[workspace.package]\nversion = "0.149.0"\n',
    );
    for (const args of [
      ["init"],
      ["config", "user.name", "OpenClaw Test"],
      ["config", "user.email", "test@example.invalid"],
      ["add", "codex-rs/Cargo.toml"],
      ["commit", "-m", "tagged source"],
      ["tag", "rust-v0.149.0"],
    ]) {
      expect(spawnSync("git", args, { cwd: codexRepo }).status).toBe(0);
    }

    await expect(
      validateCodexProtocolSourceVersion({ codexRepo, repoRoot }),
    ).resolves.toBeUndefined();

    fs.writeFileSync(path.join(codexRepo, "README.md"), "later commit\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: codexRepo }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "later source"], { cwd: codexRepo }).status).toBe(0);
    await expect(validateCodexProtocolSourceVersion({ codexRepo, repoRoot })).rejects.toThrow(
      /does not match peeled rust-v0\.149\.0 commit/,
    );
  });

  it("rejects a matching-version checkout without the exact version tag", async () => {
    const repoRoot = createTempDir("openclaw-protocol-version-root-");
    const codexRepo = createTempDir("openclaw-protocol-version-codex-");
    fs.mkdirSync(path.join(repoRoot, "extensions/codex"), { recursive: true });
    fs.mkdirSync(path.join(codexRepo, "codex-rs"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "extensions/codex/package.json"),
      JSON.stringify({ dependencies: { "@openai/codex": "0.149.0" } }),
    );
    fs.writeFileSync(
      path.join(codexRepo, "codex-rs/Cargo.toml"),
      '[workspace.package]\nversion = "0.149.0"\n',
    );
    for (const args of [
      ["init"],
      ["config", "user.name", "OpenClaw Test"],
      ["config", "user.email", "test@example.invalid"],
      ["add", "codex-rs/Cargo.toml"],
      ["commit", "-m", "untagged source"],
    ]) {
      expect(spawnSync("git", args, { cwd: codexRepo }).status).toBe(0);
    }

    await expect(validateCodexProtocolSourceVersion({ codexRepo, repoRoot })).rejects.toThrow(
      /Could not resolve Codex protocol source refs\/tags\/rust-v0\.149\.0/,
    );
  });

  it("reports git command failure for a matching-version non-repository", async () => {
    const repoRoot = createTempDir("openclaw-protocol-version-root-");
    const codexRepo = createTempDir("openclaw-protocol-version-codex-");
    fs.mkdirSync(path.join(repoRoot, "extensions/codex"), { recursive: true });
    fs.mkdirSync(path.join(codexRepo, "codex-rs"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "extensions/codex/package.json"),
      JSON.stringify({ dependencies: { "@openai/codex": "0.149.0" } }),
    );
    fs.writeFileSync(
      path.join(codexRepo, "codex-rs/Cargo.toml"),
      '[workspace.package]\nversion = "0.149.0"\n',
    );

    await expect(validateCodexProtocolSourceVersion({ codexRepo, repoRoot })).rejects.toThrow(
      /Could not resolve Codex protocol source HEAD/,
    );
  });

  it("uses the upstream ignored fixture test with explicit schema env", () => {
    expect(
      buildCodexProtocolFixtureCommand("/codex/codex-rs/Cargo.toml", "/tmp/protocol", {
        CARGO_TARGET_DIR: "/cache/codex-target",
      }),
    ).toEqual({
      args: [
        "test",
        "--manifest-path",
        "/codex/codex-rs/Cargo.toml",
        "-p",
        "codex-app-server-protocol",
        "--lib",
        "schema_fixtures_tests::write_schema_fixtures_from_env",
        "--",
        "--exact",
        "--ignored",
      ],
      env: {
        CARGO_TARGET_DIR: "/cache/codex-target",
        CODEX_APP_SERVER_SCHEMA_ROOT: "/tmp/protocol",
        CODEX_APP_SERVER_SCHEMA_EXPERIMENTAL: "1",
      },
    });
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

  it("factors repeated definitions and exactly reconstructs every source schema", () => {
    const schemas = new Map<string, unknown>(
      selectedCodexAppServerJsonSchemas.map((schemaPath) => [
        schemaPath,
        { $schema: "http://json-schema.org/draft-07/schema#", title: schemaPath, type: "object" },
      ]),
    );
    const shared = { properties: { value: { $ref: "#/definitions/Leaf" } }, type: "object" };
    const leaf = { type: "string" };
    schemas.set("DynamicToolCallParams.json", {
      definitions: { Leaf: leaf },
      properties: { arguments: { $ref: "#/definitions/Leaf" } },
      title: "DynamicToolCallParams",
      type: "object",
    });
    schemas.set("v2/ErrorNotification.json", {
      definitions: { Leaf: leaf, Shared: shared },
      properties: { error: { $ref: "#/definitions/Shared" } },
      title: "ErrorNotification",
      type: "object",
    });
    schemas.set("v2/GetAccountResponse.json", {
      definitions: { Leaf: leaf, Shared: shared },
      properties: { account: { $ref: "#/definitions/Shared" } },
      title: "GetAccountResponse",
      type: "object",
    });

    const compacted = compactCodexAppServerProtocolJsonSchemas(schemas);
    const sharedSchema = compacted.get(codexAppServerSharedDefinitionsSchema);
    expect(sharedSchema).toMatchObject({
      definitions: { Leaf: leaf, Shared: shared },
      title: "CodexAppServerProtocolDefinitions",
    });
    expect(compacted.get("v2/ErrorNotification.json")).toMatchObject({
      properties: {
        error: {
          $ref: "./CodexAppServerProtocolDefinitions.json#/definitions/Shared",
        },
      },
    });
    expect(compacted.get("DynamicToolCallParams.json")).toMatchObject({
      properties: {
        arguments: {
          $ref: "./v2/CodexAppServerProtocolDefinitions.json#/definitions/Leaf",
        },
      },
    });

    for (const schemaPath of selectedCodexAppServerJsonSchemas) {
      expect(
        expandCodexAppServerProtocolJsonSchema({
          schema: compacted.get(schemaPath),
          schemaPath,
          sharedSchema,
        }),
      ).toEqual(canonicalizeCodexAppServerProtocolJson(schemas.get(schemaPath)));
    }
  });

  it("rejects same-name definitions with different schema semantics", () => {
    const schemas = new Map<string, unknown>(
      selectedCodexAppServerJsonSchemas.map((schemaPath) => [
        schemaPath,
        { title: schemaPath, type: "object" },
      ]),
    );
    schemas.set("v2/ErrorNotification.json", {
      definitions: { Shared: { type: "string" } },
      $ref: "#/definitions/Shared",
    });
    schemas.set("v2/GetAccountResponse.json", {
      definitions: { Shared: { type: "integer" } },
      $ref: "#/definitions/Shared",
    });

    expect(() => compactCodexAppServerProtocolJsonSchemas(schemas)).toThrow(
      /shared definition Shared differs across schemas/,
    );
  });
});

function createProtocolSchema(codexRepo: string): void {
  fs.mkdirSync(path.join(codexRepo, "codex-rs/app-server-protocol/schema/typescript"), {
    recursive: true,
  });
}
