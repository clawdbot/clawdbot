/**
 * Tests the plugin SDK public API baseline.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mjs";
import {
  computePluginSdkApiBaselineHashFileContent,
  listPluginSdkApiBaselineEntrypoints,
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
  renderPluginSdkApiBaseline,
  type PluginSdkApiBaselineRender,
} from "./api-baseline.js";

describe("Plugin SDK API baseline", () => {
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

  it("renders complete declarations for the canonical public entrypoint inventory", async () => {
    expect(listPluginSdkApiBaselineEntrypoints()).toEqual(publicPluginSdkEntrypoints);

    const rendered = await renderPluginSdkApiBaseline({
      entrypoints: [
        "agent-harness-runtime",
        "approval-gateway-runtime",
        "infra-runtime",
        "provider-catalog-live-runtime",
        "provider-oauth-runtime",
        "provider-selection-runtime",
        "provider-web-search-config-contract",
        "realtime-voice",
        "sqlite-runtime-testing",
      ],
    });
    const findDeclaration = (exportName: string) =>
      rendered.baseline.modules
        .flatMap((moduleSurface) => moduleSurface.exports)
        .find((exportSurface) => exportSurface.exportName === exportName)?.declaration;

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
    expect(findDeclaration("LiveModelCatalogHttpError")).not.toContain("super(");
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
    expect(rendered.json).not.toContain('"line":');
    expect(rendered.jsonl).not.toContain('"sourceLine":');
  });

  it("renders snapshots independently of entrypoint discovery order", async () => {
    const entrypoints = ["core", "provider-auth", "channel-policy"];
    const forward = await renderPluginSdkApiBaseline({ entrypoints });
    const reverse = await renderPluginSdkApiBaseline({ entrypoints: entrypoints.toReversed() });

    expect(reverse.json).toBe(forward.json);
    expect(reverse.jsonl).toBe(forward.jsonl);
  });

  it("hashes entrypoints independently so unrelated API changes merge", () => {
    const moduleSurface = (entrypoint: string, declaration: string) => ({
      category: null,
      entrypoint,
      exports: [
        {
          declaration,
          exportName: `${entrypoint}Export`,
          kind: "function" as const,
          source: { path: `src/plugin-sdk/${entrypoint}.ts` },
        },
      ],
      importSpecifier: `openclaw/plugin-sdk/${entrypoint}`,
      source: { path: `src/plugin-sdk/${entrypoint}.ts` },
    });
    const render = (declaration: string): PluginSdkApiBaselineRender => ({
      baseline: {
        generatedBy: "scripts/generate-plugin-sdk-api-baseline.ts",
        modules: [moduleSurface("alpha", declaration), moduleSurface("beta", "stable")],
      },
      json: "",
      jsonl: "",
    });
    const before = computePluginSdkApiBaselineHashFileContent(render("before")).split("\n");
    const after = computePluginSdkApiBaselineHashFileContent(render("after")).split("\n");

    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });
});
