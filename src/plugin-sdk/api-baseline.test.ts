/**
 * Tests the plugin SDK public API baseline.
 */
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mjs";
import {
  computePluginSdkApiBaselineHashFileContent,
  formatPluginSdkApiTypeAlias,
  listPluginSdkApiBaselineEntrypoints,
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
  renderPluginSdkApiBaseline,
  renderPluginSdkApiBaselineModules,
  type PluginSdkApiBaselineRender,
} from "./api-baseline.js";

const TEST_ENTRYPOINTS = [
  "agent-harness-runtime",
  "approval-gateway-runtime",
  "channel-policy",
  "core",
  "infra-runtime",
  "provider-auth",
  "provider-catalog-live-runtime",
  "provider-oauth-runtime",
  "provider-selection-runtime",
  "provider-web-search-config-contract",
  "realtime-voice",
  "session-catalog",
  "sqlite-runtime-testing",
] as const;

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

  beforeAll(async () => {
    rendered = await renderPluginSdkApiBaseline({ entrypoints: TEST_ENTRYPOINTS });
  });

  it("normalizes declaration import paths to repo-relative paths", () => {
    const repoRoot = process.cwd();
    const modelCatalogPath = path.join(repoRoot, "src", "agents", "agent-model-discovery");
    const declaration = `export function setModelCatalogImportForTest(loader?: (() => Promise<typeof import("${modelCatalogPath}", { with: { "resolution-mode": "import" } })>) | undefined): void;`;

    const normalized = normalizePluginSdkApiDeclarationText(repoRoot, declaration);

    expect(normalized).not.toContain(repoRoot);
    expect(normalized).toContain(
      'import("src/agents/agent-model-discovery", { with: { "resolution-mode": "import" } })',
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
    expect(findDeclaration("ProviderSelection")).toContain(
      "export type ProviderSelection<TProvider> =",
    );
    expect(findDeclaration("SessionCatalogEntrySummary")).toContain(
      "export interface SessionCatalogEntrySummary",
    );
    expect(findDeclaration("SessionCatalogEntrySummary")).toContain("entry: SessionEntry;");
    expect(rendered.json).not.toContain('"line":');
    expect(rendered.jsonl).not.toContain('"sourceLine":');
  });

  it("renders snapshots independently of entrypoint discovery order", () => {
    const reverse = renderPluginSdkApiBaselineModules(rendered.baseline.modules.toReversed());

    expect(reverse.json).toBe(rendered.json);
    expect(reverse.jsonl).toBe(rendered.jsonl);
  });

  it("hashes entrypoints independently so unrelated API changes merge", () => {
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
    const before = computePluginSdkApiBaselineHashFileContent(rendered).split("\n");
    const after = computePluginSdkApiBaselineHashFileContent(changed).split("\n");

    expect(after[0]).not.toBe(before[0]);
    expect(after.slice(1)).toEqual(before.slice(1));
  });
});
