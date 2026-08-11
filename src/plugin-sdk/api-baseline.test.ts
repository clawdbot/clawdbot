/**
 * Tests the plugin SDK public API baseline.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatPluginSdkApiTypeAlias } from "./api-baseline-declaration-print.js";
import {
  listPluginSdkApiBaselineEntrypoints,
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
  renderPluginSdkApiBaseline,
  renderPluginSdkApiBaselineModules,
  writeRenderedPluginSdkApiBaselineArtifacts,
  type PluginSdkApiBaselineRender,
} from "./api-baseline.js";

const TEST_ENTRYPOINTS = [
  "agent-harness-runtime",
  "approval-gateway-runtime",
  "channel-policy",
  "core",
  "infra-runtime",
  "plugin-entry",
  "provider-auth",
  "provider-catalog-live-runtime",
  "provider-oauth-runtime",
  "provider-selection-runtime",
  "provider-web-search-config-contract",
  "realtime-voice",
  "session-catalog",
  "sqlite-runtime-testing",
] as const;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function renderSourceFixture(
  files: Readonly<Record<string, string>>,
  entrypoints: readonly string[] = ["fixture"],
) {
  const repoRoot = tempDirs.make("openclaw-plugin-sdk-api-");
  const sourceDir = path.join(repoRoot, "src", "plugin-sdk");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ESNext",
      },
    })}\n`,
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(sourceDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return renderPluginSdkApiBaseline({ repoRoot, entrypoints });
}

async function renderPrivateDeclarationFixture(params?: {
  optionalOption?: boolean;
  optionalResult?: boolean;
}) {
  const repoRoot = tempDirs.make("openclaw-plugin-sdk-api-");
  const sourceDir = path.join(repoRoot, "src", "plugin-sdk");
  const externalDir = path.join(repoRoot, "node_modules", "fixture-external");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ESNext",
      },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(sourceDir, "fixture.ts"),
    [
      'import type { FixtureOptionLeaf } from "./fixture-option.js";',
      'import type { FixtureResultLeaf } from "./fixture-result.js";',
      "type FixtureOptions = { nested: FixtureOptionLeaf };",
      "type FixtureResult = { nested: FixtureResultLeaf };",
      "export declare function createFixture(options: FixtureOptions): FixtureResult;",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(sourceDir, "fixture-option.ts"),
    [
      'import type { FixtureResultLeaf } from "./fixture-result.js";',
      'import type { FixtureExternal } from "fixture-external";',
      `export type FixtureOptionLeaf = { required${params?.optionalOption ? "?" : ""}: string; result?: FixtureResultLeaf; external?: FixtureExternal };`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(sourceDir, "fixture-result.ts"),
    'export type { FixtureResultLeaf } from "./fixture-result-shape.js";\n',
  );
  fs.writeFileSync(
    path.join(sourceDir, "fixture-result-shape.ts"),
    [
      'import type { FixtureOptionLeaf } from "./fixture-option.js";',
      `export type FixtureResultLeaf = { value${params?.optionalResult ? "?" : ""}: string; option?: FixtureOptionLeaf };`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(externalDir, "package.json"),
    `${JSON.stringify({ name: "fixture-external", types: "index.d.ts" })}\n`,
  );
  fs.writeFileSync(
    path.join(externalDir, "index.d.ts"),
    "export type FixtureExternal = { externalOnly: string };\n",
  );
  return renderPluginSdkApiBaseline({ repoRoot, entrypoints: ["fixture"] });
}

function createTupleAliasFixture(tuple: string, warmup: string, prewarm: boolean) {
  const fileName = "/plugin-sdk-tuple-fixture.ts";
  const source = [
    "interface Array<T> { [index: number]: T; readonly length: number }",
    "interface ReadonlyArray<T> { readonly [index: number]: T; readonly length: number }",
    `type Warmup = ${warmup};`,
    `const VALUES = ${tuple};`,
    "type Value = (typeof VALUES)[number];",
  ].join("\n");
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  const options = { noLib: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  host.fileExists = (candidate) => candidate === fileName;
  host.getSourceFile = (candidate) => (candidate === fileName ? sourceFile : undefined);
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const [warmupAlias, declaration] = sourceFile.statements.filter(ts.isTypeAliasDeclaration);
  if (!warmupAlias || !declaration) {
    throw new Error("Missing tuple fixture type aliases");
  }
  if (prewarm) {
    checker.getTypeAtLocation(warmupAlias);
  }
  return { checker, declaration };
}

describe("Plugin SDK API baseline", () => {
  let rendered: PluginSdkApiBaselineRender;

  // Rendering builds a TS program across SDK entrypoints. Loaded CI runners can
  // exceed the default hook budget; this work is compile-bound, not a hang.
  beforeAll(async () => {
    rendered = await renderPluginSdkApiBaseline({ entrypoints: TEST_ENTRYPOINTS });
  }, 300_000);

  it("normalizes declaration import paths to repo-relative paths", () => {
    const repoRoot = process.cwd();
    const modelCatalogPath = path.join(repoRoot, "src", "agents", "agent-model-discovery");
    const declaration = `export function setModelCatalogImportForTest(loader?: (() => Promise<typeof import("${modelCatalogPath}", { with: { "resolution-mode": "import" } })>) | undefined): void;`;

    const normalized = normalizePluginSdkApiDeclarationText(repoRoot, declaration);

    expect(normalized).not.toContain(repoRoot);
    expect(normalized).toContain('import("<repo>", { with: { "resolution-mode": "import" } })');
    expect(
      normalizePluginSdkApiDeclarationText(
        repoRoot,
        'type Owned = import("src/x").Foo; type External = import("node_modules/pkg/x").Foo; type Namespace = typeof import("src/x"); type ExternalNamespace = typeof import("node_modules/pkg/x");',
      ),
    ).toBe(
      'type Owned = Foo; type External = import("node_modules/pkg/x").Foo; type Namespace = typeof import("<repo>"); type ExternalNamespace = typeof import("node_modules/pkg/x");',
    );
  });

  it("normalizes dependency source paths to stable node_modules paths", () => {
    const repoRoot = path.join(path.sep, "workspace", "openclaw-worktree");
    const linkedDependencyPath = path.join(
      path.sep,
      "workspace",
      "openclaw",
      "node_modules",
      "@openclaw",
      "fs-safe",
      "dist",
      "secret-file.d.ts",
    );
    const pnpmDependencyPath = path.join(
      repoRoot,
      "node_modules",
      ".pnpm",
      "@openclaw+fs-safe@1.0.0",
      "node_modules",
      "@openclaw",
      "fs-safe",
      "dist",
      "secret-file.d.ts",
    );

    expect(normalizePluginSdkApiSourcePath(repoRoot, linkedDependencyPath)).toBe(
      "node_modules/@openclaw/fs-safe/dist/secret-file.d.ts",
    );
    expect(normalizePluginSdkApiSourcePath(repoRoot, pnpmDependencyPath)).toBe(
      "node_modules/@openclaw/fs-safe/dist/secret-file.d.ts",
    );
  });

  it("keeps repo source paths relative when a parent directory is named node_modules", () => {
    const repoRoot = path.join(path.sep, "workspace", "node_modules", "openclaw");
    const sourcePath = path.join(repoRoot, "src", "plugin-sdk", "core.ts");

    expect(normalizePluginSdkApiSourcePath(repoRoot, sourcePath)).toBe("src/plugin-sdk/core.ts");
  });

  it.each([
    {
      tuple: '["first", "middle", "last", "first"] as const',
      warmup: '"last"',
      expected: '"first" | "middle" | "last"',
    },
    {
      tuple: "[3, 1, 2] as const",
      warmup: "1",
      expected: "3 | 1 | 2",
    },
  ])("keeps tuple-derived unions stable across unrelated type discovery", (fixture) => {
    const baseline = createTupleAliasFixture(fixture.tuple, fixture.warmup, false);
    const prewarmed = createTupleAliasFixture(fixture.tuple, fixture.warmup, true);
    const unstable = prewarmed.checker.typeToString(
      prewarmed.checker.getTypeAtLocation(prewarmed.declaration),
      prewarmed.declaration,
      ts.TypeFormatFlags.NoTruncation,
    );

    expect(unstable).not.toBe(fixture.expected);
    expect(formatPluginSdkApiTypeAlias(baseline.checker, baseline.declaration)).toBe(
      fixture.expected,
    );
    expect(formatPluginSdkApiTypeAlias(prewarmed.checker, prewarmed.declaration)).toBe(
      fixture.expected,
    );
  });

  it("renders complete declarations for the canonical public entrypoint inventory", () => {
    expect(listPluginSdkApiBaselineEntrypoints()).toEqual(publicPluginSdkEntrypoints);

    const findDeclaration = (exportName: string) =>
      rendered.baseline.modules
        .flatMap((moduleSurface) => moduleSurface.exports)
        .find(
          (exportSurface) =>
            exportSurface.exportName === exportName && exportSurface.declaration !== null,
        )?.declaration;

    expect(rendered.baseline.modules.find((entry) => entry.entrypoint === "infra-runtime")).toEqual(
      expect.objectContaining({
        category: null,
        importSpecifier: "openclaw/plugin-sdk/infra-runtime",
      }),
    );
    expect(findDeclaration("OAuthProviderInterface")).toContain("readonly id: OAuthProviderId;");
    expect(findDeclaration("OAuthProviderInterface")).toContain(
      "login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;",
    );
    expect(findDeclaration("LiveModelCatalogHttpError")).toContain("readonly status: number;");
    expect(findDeclaration("LiveModelCatalogHttpError")).toContain(
      "constructor(providerId: string, status: number);",
    );
    expect(findDeclaration("AgentHarnessPreflightError")).toContain('readonly scope?: "harness";');
    expect(findDeclaration("AgentHarnessPreflightError")).toContain(
      "constructor(message: string, options?: ErrorOptions & {",
    );
    expect(findDeclaration("AgentHarnessPreflightError")).toContain('scope?: "harness";');
    expect(findDeclaration("AgentHarnessPreflightError")).not.toContain("harnessId");
    expect(findDeclaration("LiveModelCatalogHttpError")).not.toContain("super(");
    expect(findDeclaration("LiveModelRowProjection")).toContain(
      "export type LiveModelRowProjection",
    );
    expect(findDeclaration("ApprovalResolveResult")).not.toContain("see source");
    expect(findDeclaration("RealtimeVoiceAgentConsultRuntime")).not.toContain("see source");
    expect(findDeclaration("createWebSearchProviderContractFields")).toContain(
      "export function createWebSearchProviderContractFields(",
    );
    expect(findDeclaration("createWebSearchProviderContractFields")).not.toContain(
      "createBaseWebSearchProviderContractFields",
    );
    expect(findDeclaration("OPENCLAW_VERSION")).toContain("export const OPENCLAW_VERSION:");
    expect(findDeclaration("SqliteTrajectoryRuntimeEventForTest")).toContain(
      "export type SqliteTrajectoryRuntimeEventForTest =",
    );
    expect(
      rendered.baseline.modules
        .flatMap((moduleSurface) => moduleSurface.exports)
        .find((exportSurface) => exportSurface.exportName === "definePluginEntry")?.closureHash,
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(findDeclaration("definePluginEntry")).toContain("DefinePluginEntryOptions");
    expect(findDeclaration("definePluginEntry")).toContain("DefinedPluginEntry");
    expect(findDeclaration("ProviderSelection")).toContain(
      "export type ProviderSelection<TProvider> =",
    );
    expect(findDeclaration("SessionCatalogEntrySummary")).toContain(
      "export interface SessionCatalogEntrySummary",
    );
    expect(findDeclaration("SessionCatalogEntrySummary")).toContain("entry: SessionEntry;");
    expect(rendered.json).not.toContain('"line":');
    expect(rendered.json).toContain('"source": {');
    expect(rendered.jsonl).not.toContain('"sourceLine":');
    expect(rendered.jsonl).not.toContain('"sourcePath":');
    expect(rendered.jsonl).toContain('"contentHash":"');
    expect(rendered.jsonl).not.toContain('"closureHash":"');
    expect(rendered.jsonl).not.toContain("// declaration closure:");
  });

  it("renders snapshots independently of entrypoint discovery order", () => {
    const reverse = renderPluginSdkApiBaselineModules(rendered.baseline.modules.toReversed());

    expect(reverse.json).toBe(rendered.json);
    expect(reverse.jsonl).toBe(rendered.jsonl);
  });

  it("keeps unrelated module hashes byte-identical when one export changes", () => {
    const target = rendered.baseline.modules[0];
    expect(target?.exports.length).toBeGreaterThan(0);
    const changed = renderPluginSdkApiBaselineModules(
      rendered.baseline.modules.map((moduleSurface) =>
        moduleSurface === target
          ? {
              ...moduleSurface,
              exports: moduleSurface.exports.map((exportSurface, index) =>
                index === 0
                  ? { ...exportSurface, declaration: `${exportSurface.declaration ?? ""} changed` }
                  : exportSurface,
              ),
            }
          : moduleSurface,
      ),
    );
    const before = rendered.jsonl.split("\n");
    const after = changed.jsonl.split("\n");

    expect(after[0]).not.toBe(before[0]);
    expect(after.slice(1)).toEqual(before.slice(1));
  });

  it("writes one line per module and merges disjoint module edits without conflicts", () => {
    const modules = rendered.baseline.modules;
    const left = modules[0];
    const right = modules.at(-1);
    expect(left?.exports.length).toBeGreaterThan(0);
    expect(right?.exports.length).toBeGreaterThan(0);
    expect(left?.entrypoint).not.toBe(right?.entrypoint);

    const editModule = (target: typeof left, suffix: string) =>
      renderPluginSdkApiBaselineModules(
        modules.map((moduleSurface) =>
          moduleSurface === target
            ? {
                ...moduleSurface,
                exports: moduleSurface.exports.map((exportSurface, index) =>
                  index === 0
                    ? {
                        ...exportSurface,
                        declaration: `${exportSurface.declaration ?? ""} ${suffix}`,
                      }
                    : exportSurface,
                ),
              }
            : moduleSurface,
        ),
      );
    const ours = editModule(left, "left edit");
    const theirs = editModule(right, "right edit");
    const lines = rendered.jsonl
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(modules.length);
    expect(lines.map((line) => line.importSpecifier)).toEqual(
      modules.map((moduleSurface) => moduleSurface.importSpecifier),
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      ]),
    );

    const mergeDir = tempDirs.make("openclaw-plugin-sdk-api-merge-");
    const basePath = path.join(mergeDir, "base.jsonl");
    const oursPath = path.join(mergeDir, "ours.jsonl");
    const theirsPath = path.join(mergeDir, "theirs.jsonl");
    fs.writeFileSync(basePath, rendered.jsonl);
    fs.writeFileSync(oursPath, ours.jsonl);
    fs.writeFileSync(theirsPath, theirs.jsonl);

    const merge = spawnSync("git", ["merge-file", "--stdout", oursPath, basePath, theirsPath], {
      encoding: "utf8",
    });

    expect(merge.status, merge.stderr).toBe(0);
    expect(merge.stdout).toContain(ours.jsonl.trimEnd().split("\n")[0]);
    expect(merge.stdout).toContain(theirs.jsonl.trimEnd().split("\n").at(-1));
  });

  it("renders byte-identical JSONL deterministically", async () => {
    const firstRender = await renderPrivateDeclarationFixture();
    const secondRender = await renderPrivateDeclarationFixture();

    expect(secondRender.jsonl).toBe(firstRender.jsonl);
  });

  it("fails checks on contract drift and passes after write", async () => {
    const outputDir = tempDirs.make("openclaw-plugin-sdk-api-output-");
    const contractPath = path.join(outputDir, "plugin-sdk-api-baseline.jsonl");
    const jsonPath = path.join(outputDir, "plugin-sdk-api-baseline.json");
    fs.writeFileSync(contractPath, "stale\n");
    const options = {
      contractPath,
      jsonPath,
      rendered,
    } as const;

    const drifted = await writeRenderedPluginSdkApiBaselineArtifacts({
      ...options,
      check: true,
    });
    expect(drifted).toEqual(expect.objectContaining({ changed: true, wrote: false }));

    await writeRenderedPluginSdkApiBaselineArtifacts(options);

    const current = await writeRenderedPluginSdkApiBaselineArtifacts({
      ...options,
      check: true,
    });
    expect(current).toEqual(expect.objectContaining({ changed: false, wrote: false }));
    expect(fs.readFileSync(contractPath, "utf8")).toContain(
      '"importSpecifier":"openclaw/plugin-sdk/agent-harness-runtime"',
    );
    expect(fs.readFileSync(jsonPath, "utf8")).toContain(
      '"generatedBy": "scripts/generate-plugin-sdk-api-baseline.ts"',
    );
  });

  it("keeps hashes stable when reachable declarations move", async () => {
    const baseline = await renderSourceFixture({
      "fixture.ts": [
        'import type { Leaf } from "./dep/leaf.js";',
        "export declare function createFixture(value: Leaf): Leaf;",
      ].join("\n"),
      "dep/leaf.ts": "export type Leaf = { value: string };\n",
    });
    const moved = await renderSourceFixture({
      "fixture.ts": [
        'import type { Leaf } from "./moved/leaf.js";',
        "export declare function createFixture(value: Leaf): Leaf;",
      ].join("\n"),
      "moved/leaf.ts": "export type Leaf = { value: string };\n",
    });

    expect(moved.jsonl).toBe(baseline.jsonl);
  });

  it("includes globals from side-effect imports in closure hashes", async () => {
    const render = (optionalValue: boolean) =>
      renderSourceFixture({
        "fixture.ts": [
          'import "./ambient.js";',
          "export declare function createFixture(value: OpenClawBaselineFixtureGlobal): void;",
        ].join("\n"),
        "ambient.ts": [
          "declare global {",
          `  interface OpenClawBaselineFixtureGlobal { value${optionalValue ? "?" : ""}: string }`,
          "}",
          "export {};",
        ].join("\n"),
      });
    const baseline = await render(false);
    const changed = await render(true);

    expect(changed.baseline.modules[0]?.exports[0]?.closureHash).not.toBe(
      baseline.baseline.modules[0]?.exports[0]?.closureHash,
    );
  });

  it("keeps hashes stable when unqualified repo import types move", async () => {
    const baseline = await renderSourceFixture({
      "fixture.ts": 'export declare const fixture: typeof import("./dep/mod.js");\n',
      "dep/mod.ts": "export const value = 1;\n",
    });
    const moved = await renderSourceFixture({
      "fixture.ts": 'export declare const fixture: typeof import("./moved/mod.js");\n',
      "moved/mod.ts": "export const value = 1;\n",
    });

    expect(moved.jsonl).toBe(baseline.jsonl);
  });

  it("ignores unreachable transitive declaration changes", async () => {
    const render = (extra = "") =>
      renderSourceFixture({
        "fixture.ts": [
          'import type { Bridge } from "./bridge.js";',
          "export declare function createFixture(value: Bridge): Bridge;",
        ].join("\n"),
        "bridge.ts": [
          'import type { Shared } from "./shared.js";',
          "export type Bridge = { shared: Shared };",
        ].join("\n"),
        "shared.ts": `export type Shared = { value: string };\n${extra}`,
      });
    const baseline = await render();
    const unrelated = await render("export type TelegramProbe = { ignored: boolean };\n");

    expect(unrelated.jsonl).toBe(baseline.jsonl);
  });

  it("keeps cycle members complete across cached export walks", async () => {
    const render = (optionalMarker: boolean) =>
      renderSourceFixture(
        {
          "cycle-a.ts": [
            'import type { A } from "./a.js";',
            "export declare function first(value: A): A;",
          ].join("\n"),
          "cycle-b.ts": [
            'import type { B } from "./b.js";',
            "export declare function second(value: B): B;",
          ].join("\n"),
          "a.ts": [
            'import type { B } from "./b.js";',
            `export type A = { marker${optionalMarker ? "?" : ""}: string; b?: B };`,
          ].join("\n"),
          "b.ts": [
            'import type { A } from "./a.js";',
            "export type B = { value: string; a?: A };",
          ].join("\n"),
        },
        ["cycle-a", "cycle-b"],
      );
    const baseline = await render(false);
    const changed = await render(true);
    const closureHash = (result: PluginSdkApiBaselineRender) =>
      result.baseline.modules.find((moduleSurface) => moduleSurface.entrypoint === "cycle-b")
        ?.exports[0]?.closureHash;

    expect(closureHash(changed)).not.toBe(closureHash(baseline));
  });

  it("ignores unrelated declarations beside an aliased re-export", async () => {
    const render = (extra = "") =>
      renderSourceFixture({
        "fixture.ts": 'export { internalLeaf as publicLeaf } from "./dep.js";\n',
        "dep.ts": `export type internalLeaf = { value: string };\n${extra}`,
      });
    const baseline = await render();
    const unrelated = await render("export type Unrelated = { ignored: boolean };\n");

    expect(unrelated.jsonl).toBe(baseline.jsonl);
  });

  it("captures transitive private declaration changes deterministically", async () => {
    const baseline = await renderPrivateDeclarationFixture();
    const optionChanged = await renderPrivateDeclarationFixture({ optionalOption: true });
    const resultChanged = await renderPrivateDeclarationFixture({ optionalResult: true });
    const declaration = baseline.baseline.modules[0]?.exports[0];

    expect(declaration).toEqual(
      expect.objectContaining({
        exportName: "createFixture",
        kind: "function",
        source: { path: "src/plugin-sdk/fixture.ts" },
      }),
    );
    expect(declaration?.closureHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(declaration?.declaration).toContain("FixtureOptions");
    expect(declaration?.declaration).toContain("FixtureResult");
    expect(declaration?.declaration).not.toContain("required: string;");
    expect(declaration?.declaration).not.toContain("value: string;");
    expect(declaration?.declaration).not.toContain("externalOnly: string;");

    for (const changed of [optionChanged, resultChanged]) {
      expect(changed.baseline.modules[0]?.exports[0]?.declaration).toBe(declaration?.declaration);
      expect(changed.baseline.modules[0]?.exports[0]?.closureHash).not.toBe(
        declaration?.closureHash,
      );
      expect(changed.jsonl).not.toBe(baseline.jsonl);
    }
  });
});
