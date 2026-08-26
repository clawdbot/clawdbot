import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import {
  computeDeclaredSurfaceHash,
  diffDeclaredSurfaceWidening,
  mergePluginDeclaredSurfaces,
  resolveAcceptedSurfaceCurrent,
  resolvePluginArtifactDeclaredSurface,
  resolvePluginInstallRecordIntegrity,
} from "./capability-consent.js";
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

  it("aggregates root and nested plugin manifests from the actual package artifact", () => {
    const rootDir = createArtifactFixture({
      "package.json": {
        name: "multi-plugin-package",
        openclaw: { extensions: ["./index.js", "./plugins/child/dist/index.js"] },
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
      "plugins/child/dist/index.js": "export {};",
    });

    expect(resolvePluginArtifactDeclaredSurface(rootDir)).toEqual(
      createDeclaredSurface({
        channels: ["chat"],
        tools: ["read", "write"],
        skills: ["child-skill"],
      }),
    );
  });

  it("reads declared skills from bundle-format plugin artifacts", () => {
    const rootDir = createArtifactFixture({
      ".claude-plugin/plugin.json": { name: "bundle", skills: ["./bundle-skills"] },
    });

    expect(resolvePluginArtifactDeclaredSurface(rootDir).skills).toEqual(["./bundle-skills"]);
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

  it("selects the canonical installed artifact integrity in precedence order", () => {
    expect(
      resolvePluginInstallRecordIntegrity({
        integrity: "primary",
        npmIntegrity: "npm",
        clawpackSha256: "clawpack",
        gitCommit: "commit",
      }),
    ).toBe("primary");
    expect(resolvePluginInstallRecordIntegrity({ npmIntegrity: "npm", gitCommit: "commit" })).toBe(
      "npm",
    );
    expect(resolvePluginInstallRecordIntegrity({ clawpackSha256: "clawpack" })).toBe("clawpack");
    expect(resolvePluginInstallRecordIntegrity({ gitCommit: "commit" })).toBe("commit");
    expect(resolvePluginInstallRecordIntegrity({})).toBeUndefined();
  });
});
