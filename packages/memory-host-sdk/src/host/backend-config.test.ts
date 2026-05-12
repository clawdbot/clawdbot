import syncFs from "node:fs";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import type { OpenClawConfig } from "./config-utils.js";

type ResolvedMemoryBackendConfig = ReturnType<typeof resolveMemoryBackendConfig>;

const resolveComparablePath = (value: string, workspaceDir = "/workspace/root"): string =>
  path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value);

const memoryFileEntry = (name: string): Dirent =>
  ({
    name,
    isFile: () => true,
    isSymbolicLink: () => false,
  }) as Dirent;

const withMemoryRootEntries = <T>(entries: Dirent[], test: () => T): T => {
  const readdirSpy = vi
    .spyOn(syncFs, "readdirSync")
    .mockReturnValue(entries as unknown as ReturnType<typeof syncFs.readdirSync>);
  try {
    return test();
  } finally {
    readdirSpy.mockRestore();
  }
};

const rootMemoryConfig = (workspaceDir: string): OpenClawConfig =>
  ({
    agents: {
      defaults: { workspace: workspaceDir },
      list: [{ id: "main", default: true, workspace: workspaceDir }],
    },
    memory: {
      backend: "qmd",
      qmd: {},
    },
  }) as OpenClawConfig;

const collectionNames = (resolved: ResolvedMemoryBackendConfig): Set<string> =>
  new Set((resolved.qmd?.collections ?? []).map((collection) => collection.name));

function requireQmdConfig(
  resolved: ResolvedMemoryBackendConfig,
): NonNullable<ResolvedMemoryBackendConfig["qmd"]> {
  if (!resolved.qmd) {
    throw new Error("expected qmd memory backend config");
  }
  return resolved.qmd;
}

function requireQmdCollection(
  resolved: ResolvedMemoryBackendConfig,
  name: string,
): NonNullable<ResolvedMemoryBackendConfig["qmd"]>["collections"][number] {
  const collection = requireQmdConfig(resolved).collections.find(
    (candidate) => candidate.name === name,
  );
  if (!collection) {
    throw new Error(`expected qmd collection ${name}`);
  }
  return collection;
}

const customQmdCollections = (
  resolved: ResolvedMemoryBackendConfig,
): NonNullable<ResolvedMemoryBackendConfig["qmd"]>["collections"] =>
  (resolved.qmd?.collections ?? []).filter((collection) => collection.kind === "custom");

const customCollectionPaths = (resolved: ResolvedMemoryBackendConfig): string[] =>
  customQmdCollections(resolved).map((collection) => collection.path);

let fixtureRoot: string;
let fixtureId = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-backend-config-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

async function createFixtureDir(name: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${name}-${fixtureId++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("resolveMemoryBackendConfig", () => {
  it("defaults to builtin backend when config missing", () => {
    const cfg = { agents: { defaults: { workspace: "/tmp/memory-test" } } } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("builtin");
    expect(resolved.citations).toBe("auto");
    expect(resolved.qmd).toBeUndefined();
  });

  it("resolves qmd backend with default collections", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {},
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("qmd");
    const qmd = requireQmdConfig(resolved);
    expect(qmd.collections.length).toBe(2);
    expect(qmd.command).toBe("qmd");
    expect(qmd.searchMode).toBe("search");
    expect(qmd.update.intervalMs).toBe(300_000);
    expect(qmd.update.debounceMs).toBe(15_000);
    expect(qmd.update.onBoot).toBe(true);
    expect(qmd.update.startup).toBe("off");
    expect(qmd.update.startupDelayMs).toBe(120_000);
    expect(qmd.update.waitForBootSync).toBe(false);
    expect(qmd.update.embedIntervalMs).toBe(3_600_000);
    expect(qmd.update.commandTimeoutMs).toBe(30_000);
    expect(qmd.update.updateTimeoutMs).toBe(120_000);
    expect(qmd.update.embedTimeoutMs).toBe(120_000);
    const names = new Set(qmd.collections.map((collection) => collection.name));
    expect(names.has("memory-root-main")).toBe(true);
    expect(names.has("memory-dir-main")).toBe(true);
    expect(names.has("memory-alt-main")).toBe(false);
    expect(requireQmdCollection(resolved, "memory-root-main").pattern).toBe("MEMORY.md");
  });

  it("keeps uppercase MEMORY.md as the root pattern when only lowercase memory.md exists", () => {
    const workspaceDir = "/workspace/root";
    withMemoryRootEntries([memoryFileEntry("memory.md")], () => {
      const cfg = rootMemoryConfig(workspaceDir);
      const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
      expect(requireQmdCollection(resolved, "memory-root-main").pattern).toBe("MEMORY.md");
      expect(collectionNames(resolved).has("memory-alt-main")).toBe(false);
    });
  });

  it("prefers MEMORY.md over legacy memory.md when both root files exist", () => {
    const workspaceDir = "/workspace/root";
    withMemoryRootEntries([memoryFileEntry("MEMORY.md"), memoryFileEntry("memory.md")], () => {
      const cfg = rootMemoryConfig(workspaceDir);
      const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
      expect(requireQmdCollection(resolved, "memory-root-main").pattern).toBe("MEMORY.md");
      expect(collectionNames(resolved).has("memory-alt-main")).toBe(false);
    });
  });

  it("parses quoted qmd command paths", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          command: '"/Applications/QMD Tools/qmd" --flag',
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(requireQmdConfig(resolved).command).toBe("/Applications/QMD Tools/qmd");
  });

  it("resolves custom paths relative to workspace", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [{ id: "main", workspace: "/workspace/root" }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          paths: [
            {
              path: "notes",
              name: "custom-notes",
              pattern: "**/*.md",
            },
          ],
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const custom = requireQmdConfig(resolved).collections.find((c) =>
      c.name.startsWith("custom-notes"),
    );
    if (!custom) {
      throw new Error("expected custom-notes qmd collection");
    }
    expect(custom.path).toBe(path.resolve("/workspace/root", "notes"));
  });

  it("scopes qmd collection names per agent", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [
          { id: "main", default: true, workspace: "/workspace/root" },
          { id: "dev", workspace: "/workspace/dev" },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          paths: [{ path: "notes", name: "workspace", pattern: "**/*.md" }],
        },
      },
    } as OpenClawConfig;
    const mainResolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const devResolved = resolveMemoryBackendConfig({ cfg, agentId: "dev" });
    const mainNames = collectionNames(mainResolved);
    const devNames = collectionNames(devResolved);
    expect(mainNames.has("memory-dir-main")).toBe(true);
    expect(devNames.has("memory-dir-dev")).toBe(true);
    expect(mainNames.has("workspace-main")).toBe(true);
    expect(devNames.has("workspace-dev")).toBe(true);
  });

  it("merges default and per-agent qmd extra collections", () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            qmd: {
              extraCollections: [
                {
                  path: "/shared/team-notes",
                  name: "team-notes",
                  pattern: "**/*.md",
                },
              ],
            },
          },
        },
        list: [
          {
            id: "main",
            default: true,
            workspace: "/workspace/root",
            memorySearch: {
              qmd: {
                extraCollections: [
                  {
                    path: "notes",
                    name: "notes",
                    pattern: "**/*.md",
                  },
                ],
              },
            },
          },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const names = collectionNames(resolved);
    expect(names.has("team-notes")).toBe(true);
    expect(names.has("notes-main")).toBe(true);
  });

  it("preserves explicit custom collection names for paths outside the workspace", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [
          { id: "main", default: true, workspace: "/workspace/root" },
          { id: "dev", workspace: "/workspace/dev" },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          paths: [{ path: "/shared/notion-mirror", name: "notion-mirror", pattern: "**/*.md" }],
        },
      },
    } as OpenClawConfig;
    const mainResolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const devResolved = resolveMemoryBackendConfig({ cfg, agentId: "dev" });
    const mainNames = collectionNames(mainResolved);
    const devNames = collectionNames(devResolved);
    expect(mainNames.has("memory-dir-main")).toBe(true);
    expect(devNames.has("memory-dir-dev")).toBe(true);
    expect(mainNames.has("notion-mirror")).toBe(true);
    expect(devNames.has("notion-mirror")).toBe(true);
  });

  it("keeps symlinked workspace paths agent-scoped when deciding custom collection names", async () => {
    const tmpRoot = await createFixtureDir("symlinked-workspace");
    const workspaceDir = path.join(tmpRoot, "workspace");
    const workspaceAliasDir = path.join(tmpRoot, "workspace-alias");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.symlink(workspaceDir, workspaceAliasDir);
    const cfg = {
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          paths: [{ path: workspaceAliasDir, name: "workspace", pattern: "**/*.md" }],
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const names = collectionNames(resolved);
    expect(names.has("workspace-main")).toBe(true);
    expect(names.has("workspace")).toBe(false);
  });

  it("keeps unresolved child paths under a symlinked workspace agent-scoped", async () => {
    const tmpRoot = await createFixtureDir("symlinked-child");
    const realRootDir = path.join(tmpRoot, "real-root");
    const aliasRootDir = path.join(tmpRoot, "alias-root");
    const workspaceDir = path.join(realRootDir, "workspace");
    const workspaceAliasDir = path.join(aliasRootDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.symlink(realRootDir, aliasRootDir);
    const cfg = {
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          paths: [
            { path: path.join(workspaceAliasDir, "notes"), name: "notes", pattern: "**/*.md" },
          ],
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const names = collectionNames(resolved);
    expect(names.has("notes-main")).toBe(true);
    expect(names.has("notes")).toBe(false);
  });

  it("resolves qmd update timeout overrides", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          update: {
            waitForBootSync: true,
            commandTimeoutMs: 12_000,
            updateTimeoutMs: 480_000,
            embedTimeoutMs: 360_000,
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const update = requireQmdConfig(resolved).update;
    expect(update.waitForBootSync).toBe(true);
    expect(update.commandTimeoutMs).toBe(12_000);
    expect(update.updateTimeoutMs).toBe(480_000);
    expect(update.embedTimeoutMs).toBe(360_000);
  });

  it("resolves qmd startup refresh overrides", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          update: {
            startup: "idle",
            startupDelayMs: 45_000,
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const update = requireQmdConfig(resolved).update;
    expect(update.startup).toBe("idle");
    expect(update.startupDelayMs).toBe(45_000);
    expect(update.onBoot).toBe(true);
  });

  it("resolves qmd search mode override", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "vsearch",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(requireQmdConfig(resolved).searchMode).toBe("vsearch");
  });

  it("resolves qmd mcporter search tool override", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "query",
          searchTool: " hybrid_search ",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const qmd = requireQmdConfig(resolved);
    expect(qmd.searchMode).toBe("query");
    expect(qmd.searchTool).toBe("hybrid_search");
  });
});

describe("memorySearch.extraPaths integration", () => {
  it("maps agents.defaults.memorySearch.extraPaths to QMD collections", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["/home/user/docs", "/home/user/vault"],
          },
        },
      },
    } as OpenClawConfig;
    const result = resolveMemoryBackendConfig({ cfg, agentId: "test-agent" });
    expect(result.backend).toBe("qmd");
    const paths = customCollectionPaths(result);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths).toContain(resolveComparablePath("/home/user/docs"));
    expect(paths).toContain(resolveComparablePath("/home/user/vault"));
  });

  it("merges default and per-agent memorySearch.extraPaths for QMD collections", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["/default/path"],
          },
        },
        list: [
          {
            id: "my-agent",
            memorySearch: {
              extraPaths: ["/agent/specific/path"],
            },
          },
        ],
      },
    } as OpenClawConfig;
    const result = resolveMemoryBackendConfig({ cfg, agentId: "my-agent" });
    expect(result.backend).toBe("qmd");
    const paths = customCollectionPaths(result);
    expect(paths).toContain(resolveComparablePath("/agent/specific/path"));
    expect(paths).toContain(resolveComparablePath("/default/path"));
  });

  it("falls back to defaults when agent has no overrides", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["/default/path"],
          },
        },
        list: [
          {
            id: "other-agent",
            memorySearch: {
              extraPaths: ["/other/path"],
            },
          },
        ],
      },
    } as OpenClawConfig;
    const result = resolveMemoryBackendConfig({ cfg, agentId: "my-agent" });
    expect(result.backend).toBe("qmd");
    const paths = customCollectionPaths(result);
    expect(paths).toContain(resolveComparablePath("/default/path"));
  });

  it("deduplicates merged memorySearch.extraPaths for QMD collections", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["/shared/path", " /shared/path "],
          },
        },
        list: [
          {
            id: "my-agent",
            memorySearch: {
              extraPaths: ["/shared/path", "/agent-only"],
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = resolveMemoryBackendConfig({ cfg, agentId: "my-agent" });
    const paths = customCollectionPaths(result);

    expect(
      paths.filter((collectionPath) => collectionPath === resolveComparablePath("/shared/path")),
    ).toHaveLength(1);
    expect(paths).toContain(resolveComparablePath("/agent-only"));
  });

  it("keeps unnamed extra paths agent-scoped even when they resolve outside the workspace", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["/shared/path"],
          },
        },
      },
    } as OpenClawConfig;
    const result = resolveMemoryBackendConfig({ cfg, agentId: "my-agent" });
    expect(customQmdCollections(result).map((collection) => collection.name)).toContain(
      "custom-1-my-agent",
    );
  });

  it("matches per-agent memorySearch.extraPaths using normalized agent ids", () => {
    const cfg = {
      memory: { backend: "qmd" },
      agents: {
        defaults: {
          workspace: "/workspace/root",
        },
        list: [
          {
            id: "My-Agent",
            memorySearch: {
              extraPaths: ["/agent/mixed-case"],
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = resolveMemoryBackendConfig({ cfg, agentId: "my-agent" });

    expect(customCollectionPaths(result)).toContain(resolveComparablePath("/agent/mixed-case"));
  });

  it("deduplicates identical roots shared by memory.qmd.paths and memorySearch.extraPaths", () => {
    const cfg = {
      memory: {
        backend: "qmd",
        qmd: {
          paths: [{ path: "docs", pattern: "**/*.md", name: "workspace-docs" }],
        },
      },
      agents: {
        defaults: {
          workspace: "/workspace/root",
          memorySearch: {
            extraPaths: ["./docs"],
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const docsCollections = customQmdCollections(result).filter(
      (collection) =>
        collection.path === resolveComparablePath("./docs") && collection.pattern === "**/*.md",
    );

    expect(docsCollections).toHaveLength(1);
  });
});
