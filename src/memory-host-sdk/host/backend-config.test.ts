import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { isQmdScopeAllowed } from "./qmd-scope.js";

const resolveComparablePath = (value: string, workspaceDir = "/workspace/root"): string =>
  path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value);

function resolveCollectionNamesForAgent(cfg: OpenClawConfig, agentId: string): Set<string> {
  return new Set(
    (resolveMemoryBackendConfig({ cfg, agentId }).qmd?.collections ?? []).map(
      (collection) => collection.name,
    ),
  );
}

function resolveCustomCollectionPathsForAgent(cfg: OpenClawConfig, agentId: string): string[] {
  return (resolveMemoryBackendConfig({ cfg, agentId }).qmd?.collections ?? [])
    .filter((collection) => collection.kind === "custom")
    .map((collection) => collection.path);
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
    expect(resolved.qmd?.collections.length).toBe(2);
    expect(resolved.qmd?.command).toBe("qmd");
    expect(resolved.qmd?.searchMode).toBe("search");
    expect(resolved.qmd?.update.intervalMs).toBeGreaterThan(0);
    expect(resolved.qmd?.update.waitForBootSync).toBe(false);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(30_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(120_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(120_000);
    const names = new Set((resolved.qmd?.collections ?? []).map((collection) => collection.name));
    expect(names.has("memory-root-main")).toBe(true);
    expect(names.has("memory-dir-main")).toBe(true);
  });

  it("allows direct and channel sessions in the default qmd scope", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {},
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });

    expect(isQmdScopeAllowed(resolved.qmd?.scope, "agent:main:discord:direct:user-123")).toBe(true);
    expect(isQmdScopeAllowed(resolved.qmd?.scope, "agent:main:discord:channel:chan-123")).toBe(
      true,
    );
    expect(isQmdScopeAllowed(resolved.qmd?.scope, "agent:main:discord:group:group-123")).toBe(
      false,
    );
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
    expect(resolved.qmd?.command).toBe("/Applications/QMD Tools/qmd");
  });

  it("preserves explicit homebrew qmd paths for service environments", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          command: "/opt/homebrew/bin/qmd",
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.command).toBe("/opt/homebrew/bin/qmd");
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
    const custom = resolved.qmd?.collections.find((c) => c.name.startsWith("custom-notes"));
    expect(custom).toBeDefined();
    const workspaceRoot = resolveAgentWorkspaceDir(cfg, "main");
    expect(custom?.path).toBe(path.resolve(workspaceRoot, "notes"));
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
    const mainNames = resolveCollectionNamesForAgent(cfg, "main");
    const devNames = resolveCollectionNamesForAgent(cfg, "dev");
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
    const names = resolveCollectionNamesForAgent(cfg, "main");
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
    const mainNames = resolveCollectionNamesForAgent(cfg, "main");
    const devNames = resolveCollectionNamesForAgent(cfg, "dev");
    expect(mainNames.has("memory-dir-main")).toBe(true);
    expect(devNames.has("memory-dir-dev")).toBe(true);
    expect(mainNames.has("notion-mirror")).toBe(true);
    expect(devNames.has("notion-mirror")).toBe(true);
  });

  it("keeps symlinked workspace paths agent-scoped when deciding custom collection names", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-backend-config-"));
    const workspaceDir = path.join(tmpRoot, "workspace");
    const workspaceAliasDir = path.join(tmpRoot, "workspace-alias");
    try {
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
      const names = resolveCollectionNamesForAgent(cfg, "main");
      expect(names.has("workspace-main")).toBe(true);
      expect(names.has("workspace")).toBe(false);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps unresolved child paths under a symlinked workspace agent-scoped", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-backend-config-"));
    const realRootDir = path.join(tmpRoot, "real-root");
    const aliasRootDir = path.join(tmpRoot, "alias-root");
    const workspaceDir = path.join(realRootDir, "workspace");
    const workspaceAliasDir = path.join(aliasRootDir, "workspace");
    try {
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
      const names = resolveCollectionNamesForAgent(cfg, "main");
      expect(names.has("notes-main")).toBe(true);
      expect(names.has("notes")).toBe(false);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
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
    expect(resolved.qmd?.update.waitForBootSync).toBe(true);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(12_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(480_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(360_000);
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
    expect(resolved.qmd?.searchMode).toBe("vsearch");
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
    expect(resolved.qmd?.searchMode).toBe("query");
    expect(resolved.qmd?.searchTool).toBe("hybrid_search");
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
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );
    expect(customCollections.length).toBeGreaterThanOrEqual(2);
    expect(customCollections.map((collection) => collection.path)).toEqual(
      expect.arrayContaining([
        resolveComparablePath("/home/user/docs"),
        resolveComparablePath("/home/user/vault"),
      ]),
    );
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
    const paths = resolveCustomCollectionPathsForAgent(cfg, "my-agent");
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
    const paths = resolveCustomCollectionPathsForAgent(cfg, "my-agent");
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

    const paths = resolveCustomCollectionPathsForAgent(cfg, "my-agent");

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
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );
    expect(customCollections.map((collection) => collection.name)).toContain("custom-1-my-agent");
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
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );

    expect(customCollections.map((collection) => collection.path)).toContain(
      resolveComparablePath("/agent/mixed-case"),
    );
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
    const customCollections = (result.qmd?.collections ?? []).filter(
      (collection) => collection.kind === "custom",
    );
    const docsCollections = customCollections.filter(
      (collection) =>
        collection.path === resolveComparablePath("./docs") && collection.pattern === "**/*.md",
    );

    expect(docsCollections).toHaveLength(1);
  });
});
