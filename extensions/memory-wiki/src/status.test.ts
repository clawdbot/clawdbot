// Memory Wiki tests cover status plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryPluginPublicArtifact } from "openclaw/plugin-sdk/memory-host-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import {
  buildMemoryWikiDoctorReport,
  renderMemoryWikiDoctor,
  renderMemoryWikiStatus,
  resolveMemoryWikiStatus,
} from "./status.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

async function resolveBridgeMissingArtifactsStatus() {
  const config = resolveMemoryWikiConfig(
    {
      vaultMode: "bridge",
      bridge: {
        enabled: true,
        readMemoryArtifacts: true,
      },
    },
    { homedir: "/Users/tester" },
  );

  return resolveMemoryWikiStatus(config, {
    appConfig: {
      agents: {
        list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
      },
    } as OpenClawConfig,
    listPublicArtifacts: async () => [],
    pathExists: async () => true,
    resolveCommand: async () => null,
  });
}

describe("resolveMemoryWikiStatus", () => {
  it("reports missing vault and missing requested obsidian cli", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vault: { path: "/tmp/wiki" },
        obsidian: { enabled: true, useOfficialCli: true },
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => false,
      resolveCommand: async () => null,
    });

    expect(status.vaultExists).toBe(false);
    expect(status.vaultScope).toBe("global");
    expect(status.agentId).toBeNull();
    expect(status.obsidianCli.requested).toBe(true);
    expect(status.warnings.map((warning) => warning.code)).toEqual([
      "vault-missing",
      "obsidian-cli-missing",
    ]);
    expect(status.sourceCounts).toEqual({
      native: 0,
      bridge: 0,
      bridgeEvents: 0,
      unsafeLocal: 0,
      other: 0,
    });
  });

  it("warns when unsafe-local is selected without explicit private access", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "unsafe-local",
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => "/usr/local/bin/obsidian",
    });

    expect(status.warnings.map((warning) => warning.code)).toContain("unsafe-local-disabled");
  });

  it("warns when bridge mode has no exported memory artifacts", async () => {
    const status = await resolveBridgeMissingArtifactsStatus();

    expect(status.bridgePublicArtifactCount).toBe(0);
    expect(status.warnings.map((warning) => warning.code)).toContain("bridge-artifacts-missing");
  });

  it("skips artifact enumeration when readMemoryArtifacts is disabled", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: false,
        },
      },
      { homedir: "/Users/tester" },
    );

    let listCalls = 0;
    const status = await resolveMemoryWikiStatus(config, {
      appConfig: {
        agents: {
          list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
        },
      } as OpenClawConfig,
      listPublicArtifacts: async () => {
        listCalls += 1;
        return [];
      },
      pathExists: async () => true,
      resolveCommand: async () => null,
    });

    expect(listCalls).toBe(0);
    expect(status.bridgePublicArtifactCount).toBeNull();
    expect(status.warnings.map((warning) => warning.code)).not.toContain(
      "bridge-artifacts-missing",
    );
  });

  it("counts only artifacts owned by the resolved agent in agent scope", async () => {
    const unresolvedConfig = resolveMemoryWikiConfig(
      {
        vaultMode: "bridge",
        vault: { scope: "agent", path: "/tmp/wiki/support" },
        bridge: { enabled: true, readMemoryArtifacts: true },
      },
      { homedir: "/Users/tester" },
    );
    const config = { ...unresolvedConfig, agentId: "support" };
    const artifacts: MemoryPluginPublicArtifact[] = [
      {
        kind: "memory-root",
        workspaceDir: "/tmp/support",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/support/MEMORY.md",
        agentIds: [" SUPPORT "],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir: "/tmp/marketing",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/marketing/MEMORY.md",
        agentIds: ["marketing"],
        contentType: "markdown",
      },
      {
        kind: "daily-note",
        workspaceDir: "/tmp/shared",
        relativePath: "memory/2026-07-09.md",
        absolutePath: "/tmp/shared/memory/2026-07-09.md",
        agentIds: ["support", "marketing"],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir: "/tmp/unknown",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/unknown/MEMORY.md",
        agentIds: [],
        contentType: "markdown",
      },
    ];

    const status = await resolveMemoryWikiStatus(config, {
      appConfig: {
        agents: { list: [{ id: "support", default: true, workspace: "/tmp/support" }] },
      },
      listPublicArtifacts: async () => artifacts,
      pathExists: async () => true,
      resolveCommand: async () => null,
    });

    expect(status.vaultScope).toBe("agent");
    expect(status.agentId).toBe("support");
    expect(status.bridgePublicArtifactCount).toBe(2);
  });

  it("scopes global-vault status metadata when called by an agent tool", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "bridge",
        bridge: { enabled: true, readMemoryArtifacts: true },
      },
      { homedir: "/Users/tester" },
    );
    const artifacts: MemoryPluginPublicArtifact[] = [
      {
        kind: "memory-root",
        workspaceDir: "/tmp/support",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/support/MEMORY.md",
        agentIds: ["support"],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir: "/tmp/marketing",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/marketing/MEMORY.md",
        agentIds: ["marketing"],
        contentType: "markdown",
      },
      {
        kind: "daily-note",
        workspaceDir: "/tmp/shared",
        relativePath: "memory/2026-07-09.md",
        absolutePath: "/tmp/shared/memory/2026-07-09.md",
        agentIds: ["support", "marketing"],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir: "/tmp/legacy",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/legacy/MEMORY.md",
        agentIds: [],
        contentType: "markdown",
      },
    ];
    const deps = {
      appConfig: {} as OpenClawConfig,
      listPublicArtifacts: async () => artifacts,
      pathExists: async () => true,
      resolveCommand: async () => null,
    };

    const agentStatus = await resolveMemoryWikiStatus(config, {
      ...deps,
      callerAgentId: " SUPPORT ",
    });
    const operatorStatus = await resolveMemoryWikiStatus(config, deps);

    expect(agentStatus.vaultScope).toBe("global");
    expect(agentStatus.agentId).toBeNull();
    expect(agentStatus.bridgePublicArtifactCount).toBe(2);
    expect(operatorStatus.bridgePublicArtifactCount).toBe(4);
  });

  it("rejects status for an unresolved agent-scoped config", async () => {
    const config = resolveMemoryWikiConfig(
      { vault: { scope: "agent", path: "/tmp/wiki/support" } },
      { homedir: "/Users/tester" },
    );

    await expect(
      resolveMemoryWikiStatus(config, {
        pathExists: async () => true,
        resolveCommand: async () => null,
      }),
    ).rejects.toThrow("Memory Wiki agent-scoped vault requires a resolved agent id");
  });

  it("discovers pages in nested subdirectories", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-nested-",
      initialize: true,
    });

    await fs.mkdir(path.join(rootDir, "sources", "sub"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "top.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.top", title: "Top Source" },
        body: "# Top Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "sub", "nested.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.nested", title: "Nested Source" },
        body: "# Nested Source\n",
      }),
      "utf8",
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => null,
    });

    expect(status.pageCounts.source).toBe(2);
    expect(status.sourceCounts.native).toBe(2);
  });

  it("excludes malformed pages from status counts (#96125)", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-status-invalid-frontmatter-",
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "broken.md"),
      [
        "---",
        "pageType: source",
        "id: source.broken",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
        "---",
        "",
        "# Broken",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "healthy.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.healthy", title: "Healthy" },
        body: "# Healthy\n",
      }),
      "utf8",
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => null,
    });

    expect(status.pageCounts.source).toBe(1);
    expect(status.sourceCounts.native).toBe(1);
  });

  it("counts source provenance from the vault", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-status-",
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "native.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.native", title: "Native Source" },
        body: "# Native Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge",
          title: "Bridge Source",
          sourceType: "memory-bridge",
        },
        body: "# Bridge Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "events.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.events",
          title: "Event Source",
          sourceType: "memory-bridge-events",
        },
        body: "# Event Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "unsafe.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.unsafe",
          title: "Unsafe Source",
          sourceType: "memory-unsafe-local",
          provenanceMode: "unsafe-local",
        },
        body: "# Unsafe Source\n",
      }),
      "utf8",
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => null,
    });

    expect(status.pageCounts.source).toBe(4);
    expect(status.sourceCounts).toEqual({
      native: 1,
      bridge: 1,
      bridgeEvents: 1,
      unsafeLocal: 1,
      other: 0,
    });
  });
});

describe("renderMemoryWikiStatus", () => {
  it("includes warnings in the text output", () => {
    const rendered = renderMemoryWikiStatus({
      vaultScope: "global",
      agentId: null,
      vaultMode: "isolated",
      renderMode: "native",
      vaultPath: "/tmp/wiki",
      vaultExists: false,
      bridge: {
        enabled: false,
        readMemoryArtifacts: true,
        indexDreamReports: true,
        indexDailyNotes: true,
        indexMemoryRoot: true,
        followMemoryEvents: true,
      },
      bridgePublicArtifactCount: null,
      obsidianCli: {
        enabled: true,
        requested: true,
        available: false,
        command: null,
      },
      unsafeLocal: {
        allowPrivateMemoryCoreAccess: false,
        pathCount: 0,
      },
      pageCounts: {
        source: 0,
        entity: 0,
        concept: 0,
        synthesis: 0,
        report: 0,
      },
      sourceCounts: {
        native: 0,
        bridge: 0,
        bridgeEvents: 0,
        unsafeLocal: 0,
        other: 0,
      },
      warnings: [{ code: "vault-missing", message: "Wiki vault has not been initialized yet." }],
    });

    expect(rendered).toContain("Wiki vault mode: isolated");
    expect(rendered).toContain("Vault scope: global");
    expect(rendered).toContain("Pages: 0 sources, 0 entities, 0 concepts, 0 syntheses, 0 reports");
    expect(rendered).toContain(
      "Source provenance: 0 native, 0 bridge, 0 bridge-events, 0 unsafe-local, 0 other",
    );
    expect(rendered).toContain("Warnings:");
    expect(rendered).toContain("Wiki vault has not been initialized yet.");
  });
});

describe("memory wiki doctor", () => {
  it("builds actionable fixes from status warnings", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vault: { path: "/tmp/wiki" },
        obsidian: { enabled: true, useOfficialCli: true },
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => false,
      resolveCommand: async () => null,
    });
    const report = buildMemoryWikiDoctorReport(status);
    const rendered = renderMemoryWikiDoctor(report);

    expect(report.healthy).toBe(false);
    expect(report.warningCount).toBe(2);
    expect(report.fixes.map((fix) => fix.code)).toEqual(["vault-missing", "obsidian-cli-missing"]);
    expect(rendered).toContain("Suggested fixes:");
    expect(rendered).toContain("openclaw wiki init");
  });

  it("suggests bridge fixes when no public artifacts are exported", async () => {
    const status = await resolveBridgeMissingArtifactsStatus();
    const report = buildMemoryWikiDoctorReport(status);

    expect(report.fixes.map((fix) => fix.code)).toContain("bridge-artifacts-missing");
    expect(renderMemoryWikiDoctor(report)).toContain("exports public artifacts");
  });
});
