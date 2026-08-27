import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import {
  buildPluginCapabilityConsentReview,
  computeDeclaredSurfaceHash,
  createManagedPluginArtifactConsentHandler,
  diffDeclaredSurfaceWidening,
  resolveAcceptedSurfaceCurrent,
  resolvePluginArtifactDeclaredSurface,
  resolvePluginInstallRecordIntegrity,
} from "./capability-consent.js";
import { buildPluginCapabilitySummary, mergePluginDeclaredSurfaces } from "./capability-summary.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { loadInstalledPluginIndexWithDiscovery } from "./installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function createArtifactFixture(files: Record<string, object | string>): string {
  const rootDir = makeTrackedTempDir("openclaw-plugin-capability-consent", tempDirs);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return rootDir;
}

function createDeclaredSurface(
  overrides: Partial<PluginAcceptedDeclaredSurface> = {},
): PluginAcceptedDeclaredSurface {
  return {
    channels: [],
    providers: [],
    tools: [],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
    ...overrides,
  };
}

describe("plugin capability consent", () => {
  it("merges every package-owned plugin into a sorted, duplicate-free capability surface", () => {
    expect(
      mergePluginDeclaredSurfaces([
        createDeclaredSurface({ channels: ["chat"], tools: ["write", "read"] }),
        createDeclaredSurface({ tools: ["admin", "read"], mcpServers: ["provider"] }),
      ]),
    ).toEqual(
      createDeclaredSurface({
        channels: ["chat"],
        tools: ["admin", "read", "write"],
        mcpServers: ["provider"],
      }),
    );
  });

  it.each([
    { label: "native package entries", explicitPath: false, staged: false },
    { label: "a configured file override", explicitPath: true, staged: false },
    {
      label: "a configured file override mapped into an update stage",
      explicitPath: true,
      staged: true,
    },
    {
      label: "a configured file override after the previous payload was removed",
      explicitPath: true,
      staged: true,
      missingPrevious: true,
    },
    {
      label: "a configured file symlink with its original manifest root",
      explicitPath: true,
      alias: true,
      staged: false,
    },
    {
      label: "a configured file symlink mapped into an update stage",
      explicitPath: true,
      alias: true,
      staged: true,
    },
    {
      label: "an unmanaged configured descendant outside the package entry set",
      explicitPath: true,
      unmanaged: true,
      staged: false,
    },
  ])(
    "matches runtime discovery for $label",
    ({ explicitPath, staged, alias = false, unmanaged = false, missingPrevious = false }) => {
      const rootDir = createArtifactFixture({
        "package.json": {
          name: "multi-plugin-package",
          openclaw: { extensions: ["./index.js", "./plugins/child/child.js"] },
        },
        "openclaw.plugin.json": {
          id: "root",
          channels: ["chat"],
          contracts: { tools: ["read"] },
          configSchema: { type: "object" },
        },
        "index.js": "export {};",
        "plugins/child/openclaw.plugin.json": {
          id: "child",
          contracts: { tools: ["write", "read"] },
          skills: ["child-skill"],
          configSchema: { type: "object" },
        },
        "plugins/child/child.js": "export {};",
        "plugins/openclaw.plugin.json": {
          id: "ignored-ancestor",
          contracts: { tools: ["unreachable-tool"] },
          configSchema: { type: "object" },
        },
        "extra/extra.js": "export {};",
        "extra/openclaw.plugin.json": {
          id: "unmanaged-extra",
          contracts: { tools: ["unmanaged-tool"] },
          configSchema: { type: "object" },
        },
      });
      const artifactDir = staged ? createArtifactFixture({}) : rootDir;
      if (staged) {
        fs.cpSync(rootDir, artifactDir, { recursive: true });
        fs.writeFileSync(
          path.join(artifactDir, "plugins/child/openclaw.plugin.json"),
          JSON.stringify({
            id: "child",
            contracts: { tools: ["staged-write", "read"] },
            skills: ["child-skill"],
            configSchema: { type: "object" },
          }),
        );
      }
      if (alias) {
        for (const dir of new Set([rootDir, artifactDir])) {
          fs.symlinkSync("plugins/child/child.js", path.join(dir, "alias.js"));
        }
      }
      const configuredEntry = unmanaged
        ? "extra/extra.js"
        : alias
          ? "alias.js"
          : "plugins/child/child.js";
      const config = {
        plugins: {
          load: { paths: explicitPath ? [path.join(rootDir, configuredEntry)] : [] },
        },
      };
      if (missingPrevious) {
        fs.rmSync(rootDir, { recursive: true, force: true });
      }
      const runtimePaths = explicitPath ? [path.join(artifactDir, configuredEntry)] : [];
      const env = {
        HOME: artifactDir,
        OPENCLAW_STATE_DIR: path.join(artifactDir, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
      };
      const runtime = loadInstalledPluginIndexWithDiscovery({
        config: { plugins: { load: { paths: runtimePaths } } },
        env,
        installRecords: { root: { source: "path", installPath: artifactDir } },
      });
      const ownedIds = new Set(
        runtime.index.plugins
          .filter((plugin) => resolveInstalledPluginIndexInstallOwner(plugin) === "root")
          .map((plugin) => plugin.pluginId),
      );
      const runtimeDeclared = mergePluginDeclaredSurfaces(
        runtime.manifestRegistry.plugins
          .filter((manifest) => ownedIds.has(manifest.id))
          .map(
            (manifest) =>
              buildPluginCapabilitySummary({ manifest, origin: manifest.origin }).declared,
          ),
      );
      const includesChildManifest = explicitPath && !alias && !unmanaged;
      const expectedTools = includesChildManifest
        ? ["read", staged ? "staged-write" : "write"]
        : ["read"];
      const expected = createDeclaredSurface({
        channels: ["chat"],
        tools: expectedTools,
        contracts: expectedTools.map((tool) => `tools: ${tool}`),
        skills: includesChildManifest ? ["child-skill"] : [],
      });

      expect(
        runtime.index.diagnostics.filter((diagnostic) => diagnostic.level === "error"),
      ).toEqual([]);
      expect(runtimeDeclared).toEqual(expected);
      expect(
        resolvePluginArtifactDeclaredSurface(artifactDir, env, {
          config,
          ...(staged ? { currentArtifactDir: rootDir } : {}),
        }),
      ).toEqual(expected);
    },
  );

  it("reads declared skills from bundle-format plugin artifacts", () => {
    const rootDir = createArtifactFixture({
      ".claude-plugin/plugin.json": { name: "bundle", skills: ["./bundle-skills"] },
    });

    expect(resolvePluginArtifactDeclaredSurface(rootDir).skills).toEqual(["./bundle-skills"]);
  });

  it("reviews native package extensions before a competing bundle manifest, like runtime discovery", () => {
    const rootDir = createArtifactFixture({
      "package.json": { openclaw: { extensions: ["./index.js"] } },
      "index.js": "export {};",
      "openclaw.plugin.json": {
        id: "native",
        contracts: { gatewayMethodDispatch: ["dangerous.gateway"] },
        configSchema: { type: "object" },
      },
      ".claude-plugin/plugin.json": { name: "bundle", skills: ["./misleading-safe-skill"] },
    });

    expect(resolvePluginArtifactDeclaredSurface(rootDir)).toEqual(
      createDeclaredSurface({ contracts: ["gatewayMethodDispatch: dangerous.gateway"] }),
    );
  });

  it("reviews a competing bundle before native fallback when the package declares no extensions", () => {
    const rootDir = createArtifactFixture({
      "openclaw.plugin.json": {
        id: "native",
        contracts: { gatewayMethodDispatch: ["native.gateway"] },
        configSchema: { type: "object" },
      },
      ".claude-plugin/plugin.json": { name: "bundle", skills: ["./bundle-skills"] },
    });

    expect(resolvePluginArtifactDeclaredSurface(rootDir)).toEqual(
      createDeclaredSurface({ skills: ["./bundle-skills"] }),
    );
  });

  it("rejects package extension entries that escape the installed artifact", () => {
    const rootDir = createArtifactFixture({
      "package.json": { openclaw: { extensions: ["../outside/index.js"] } },
      "openclaw.plugin.json": { id: "root", configSchema: { type: "object" } },
    });

    expect(() => resolvePluginArtifactDeclaredSurface(rootDir)).toThrow();
  });

  it("hashes declared surfaces independently of object-key and capability ordering", () => {
    const declared = createDeclaredSurface({
      channels: ["zulu", "alpha"],
      tools: ["write", "read"],
    });
    const reordered = {
      dangerousConfigFlags: [],
      skills: [],
      cliBackends: [],
      cliCommands: [],
      mcpServers: [],
      hooks: [],
      contracts: [],
      tools: ["read", "write"],
      providers: [],
      channels: ["alpha", "zulu"],
    } satisfies PluginAcceptedDeclaredSurface;

    expect(computeDeclaredSurfaceHash(declared)).toMatch(/^[a-f\d]{64}$/);
    expect(computeDeclaredSurfaceHash(declared)).toBe(computeDeclaredSurfaceHash(reordered));
    expect(computeDeclaredSurfaceHash(declared)).not.toBe(
      computeDeclaredSurfaceHash(createDeclaredSurface({ channels: ["alpha", "zulu"] })),
    );
  });

  it.each<{
    label: string;
    previous: Partial<PluginAcceptedDeclaredSurface>;
    next: Partial<PluginAcceptedDeclaredSurface>;
    widened: Partial<PluginAcceptedDeclaredSurface>;
  }>([
    {
      label: "an added capability in an existing group",
      previous: { tools: ["read"] },
      next: { tools: ["write", "read"] },
      widened: { tools: ["write"] },
    },
    {
      label: "a removed capability",
      previous: { tools: ["read", "write"] },
      next: { tools: ["read"] },
      widened: {},
    },
    {
      label: "an unchanged capability surface",
      previous: { channels: ["chat"], tools: ["read"] },
      next: { channels: ["chat"], tools: ["read"] },
      widened: {},
    },
    {
      label: "capabilities in a previously empty group",
      previous: { tools: ["read"] },
      next: { tools: ["read"], mcpServers: ["zulu", "alpha"] },
      widened: { mcpServers: ["alpha", "zulu"] },
    },
  ])("identifies widening for $label", ({ previous, next, widened }) => {
    expect(
      diffDeclaredSurfaceWidening(createDeclaredSurface(previous), createDeclaredSurface(next)),
    ).toEqual({ widened, hasWidening: Object.keys(widened).length > 0 });
  });

  it.each<{
    label: string;
    record: Partial<PluginInstallRecord>;
    declared: Partial<PluginAcceptedDeclaredSurface>;
    current: boolean;
  }>([
    {
      label: "missing acceptance",
      record: { acceptedSurface: undefined },
      declared: { tools: ["read"] },
      current: false,
    },
    {
      label: "missing acceptance hash",
      record: { acceptedSurfaceHash: undefined },
      declared: { tools: ["read"] },
      current: false,
    },
    {
      label: "a forged acceptance hash",
      record: { acceptedSurfaceHash: "0".repeat(64) },
      declared: { tools: ["read"] },
      current: false,
    },
    {
      label: "a changed accepted snapshot",
      record: { acceptedSurface: createDeclaredSurface({ tools: ["write"] }) },
      declared: { tools: ["read"] },
      current: false,
    },
    {
      label: "a changed installed artifact",
      record: { integrity: "sha512-new", acceptedSurfaceIntegrity: "sha512-old" },
      declared: { tools: ["read"] },
      current: false,
    },
    {
      label: "an accepted artifact anchor that disappeared",
      record: { acceptedSurfaceIntegrity: "sha512-old" },
      declared: { tools: ["read"] },
      current: false,
    },
    {
      label: "matching declared surface and artifact integrity",
      record: { integrity: "sha512-current", acceptedSurfaceIntegrity: "sha512-current" },
      declared: { tools: ["read"] },
      current: true,
    },
    {
      label: "matching declared surface without an available artifact digest",
      record: {},
      declared: { tools: ["read"] },
      current: true,
    },
  ])("recognizes current acceptance for $label", ({ record, declared, current }) => {
    const surface = createDeclaredSurface(declared);
    const installRecord: PluginInstallRecord = {
      source: "npm",
      acceptedSurface: surface,
      acceptedSurfaceHash: computeDeclaredSurfaceHash(surface),
      ...record,
    };

    expect(resolveAcceptedSurfaceCurrent(installRecord, surface)).toBe(current);
  });

  it("redacts source credentials before a capability review reaches a prompt or pending inspection", () => {
    const url = new URL("https://example.invalid/plugins/demo.git");
    url.username = "fixture-user";
    url.password = "fixture-password";
    url.searchParams.set("token", "fixture-token");
    const record: PluginInstallRecord = { source: "git", spec: `git:${url.href}` };

    const review = buildPluginCapabilityConsentReview({
      pluginId: "plugin",
      manifest: {},
      config: {},
      record,
    });

    expect(review.source?.spec).toBe(
      "git:https://***:***@example.invalid/plugins/demo.git?token=***",
    );
    expect(record.spec).toBe(`git:${url.href}`);
  });

  it("selects the canonical installed artifact integrity in precedence order", () => {
    expect(
      resolvePluginInstallRecordIntegrity({
        integrity: "primary",
        npmIntegrity: "npm",
        clawpackSha256: "clawpack",
        gitCommit: "commit",
      }),
    ).toEqual({ integrity: "primary", integrityKind: "ssri" });
    expect(
      resolvePluginInstallRecordIntegrity({ npmIntegrity: "npm", gitCommit: "commit" }),
    ).toEqual({
      integrity: "npm",
      integrityKind: "ssri",
    });
    expect(resolvePluginInstallRecordIntegrity({ clawpackSha256: "clawpack" })).toEqual({
      integrity: "clawpack",
      integrityKind: "sha256",
    });
    expect(resolvePluginInstallRecordIntegrity({ gitCommit: "commit" })).toEqual({
      integrity: "commit",
      integrityKind: "git-commit",
    });
    expect(resolvePluginInstallRecordIntegrity({})).toBeUndefined();
  });

  it.each(["missing", "invalid"])(
    "requires fresh review to repair a %s previous artifact",
    async (condition) => {
      const files = {
        "package.json": { openclaw: { extensions: ["./index.js"] } },
        "index.js": "export {};",
        "openclaw.plugin.json": {
          id: "plugin",
          contracts: { tools: ["repair-tool"] },
          configSchema: { type: "object" },
        },
      };
      const previousDir = createArtifactFixture(files);
      const stagedDir = createArtifactFixture(files);
      const acceptedSurface = resolvePluginArtifactDeclaredSurface(previousDir);
      const previousRecord = {
        source: "npm" as const,
        installPath: previousDir,
        integrity: "sha512-previous",
        acceptedSurface,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
        acceptedSurfaceIntegrity: "sha512-previous",
      };
      if (condition === "missing") {
        fs.rmSync(previousDir, { recursive: true });
      } else {
        fs.writeFileSync(path.join(previousDir, "openclaw.plugin.json"), "{");
      }
      const params = {
        config: {},
        source: "npm" as const,
        previousRecords: { plugin: previousRecord },
      };
      const artifact = {
        pluginId: "plugin",
        stagedArtifactDir: stagedDir,
        mode: "update" as const,
      };
      await expect(
        createManagedPluginArtifactConsentHandler(params).onBeforePluginArtifactCommit(artifact),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "plugin" } });
      const reviewed: string[][] = [];
      const consent = createManagedPluginArtifactConsentHandler({
        ...params,
        onCapabilityConsent: async (review) => {
          reviewed.push(review.declared.tools);
          return { reviewToken: review.reviewToken };
        },
      });
      await consent.onBeforePluginArtifactCommit(artifact);
      expect(reviewed).toEqual([["repair-tool"]]);
      const repairedRecord: PluginInstallRecord = { source: "npm" };
      expect(consent.applyAcceptedSurface("plugin", repairedRecord).acceptedSurface).toEqual(
        acceptedSurface,
      );
    },
  );

  it("requires consent when reinstalling a previously disabled plugin will enable it", async () => {
    const rootDir = createArtifactFixture({
      "package.json": { openclaw: { extensions: ["./index.js"] } },
      "index.js": "export {};",
      "openclaw.plugin.json": { id: "plugin", configSchema: { type: "object" } },
    });
    const consent = createManagedPluginArtifactConsentHandler({
      config: { plugins: { entries: { plugin: { enabled: false } } } },
      source: "npm",
      previousRecords: { plugin: { source: "npm", installPath: rootDir } },
    });

    await expect(
      consent.onBeforePluginArtifactCommit({
        pluginId: "plugin",
        stagedArtifactDir: rootDir,
        mode: "update",
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "plugin" } });
  });
});
