import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION } from "./provenance-schema-version.js";
import { persistClawPackageRef } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawPackage } from "./types.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import {
  createUpdatePlanFixture,
  packagePreflight,
  targetSource,
} from "./update-plan.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture() {
  const root = tempDirs.make("openclaw-claw-update-");
  return await createUpdatePlanFixture(root);
}

describe("buildClawUpdatePlan", () => {
  it("reads pre-bootstrap-column v6 state without mutating it", async () => {
    const current = await fixture();
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(current.env);
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(databasePath);
    try {
      database.exec(`
        ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path;
        ALTER TABLE claw_installs DROP COLUMN bootstrap_content_digest;
      `);
    } finally {
      database.close();
    }
    const beforeBytes = await readFile(databasePath);
    const beforeStat = await stat(databasePath);

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan).toMatchObject({ found: true, agentId: "worker", blockers: [] });
    expect((await readFile(databasePath)).equals(beforeBytes)).toBe(true);
    expect((await stat(databasePath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("moves a portable plugin dependency into a profile extension edge without reinstalling", async () => {
    const current = await fixture();
    const parsed = parseClawManifest({
      ...current.manifest,
      packages: current.manifest.packages.filter((pkg) => pkg.ref !== "obsolete"),
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetOpenClawProfile: {
        schemaVersion: 1,
        agent: {},
        extensions: [
          {
            id: "obsolete-tools",
            kind: "plugin",
            format: "claude",
            source: "clawhub",
            ref: "obsolete",
            version: "1.0.0",
          },
        ],
      },
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: {
        env: current.env,
        packageDeps: {
          resolvePlugin: async () => ({
            status: "found" as const,
            pluginId: "obsolete",
            installedVersion: "1.0.0",
            record: { source: "clawhub", integrity: `sha256:${"a".repeat(64)}` },
          }),
        },
      },
      packagePreflight: async () => ({
        ok: true,
        action: "reuse",
        integrity: `sha256:${"a".repeat(64)}`,
        installId: "obsolete",
        detectedFormat: "claude",
        mapped: ["skills"],
        unavailable: ["agents"],
        adapterIdentity: "openclaw/test",
      }),
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "package",
        id: "plugin:obsolete",
        action: "change",
        reason: expect.stringContaining("without reinstalling"),
      }),
    );
    expect(plan.actions).not.toContainEqual(
      expect.objectContaining({ kind: "package", id: "plugin:obsolete", action: "release" }),
    );
    const extensionChange = plan.capabilityChanges.find(
      (change) => change.kind === "package" && change.id === "plugin:obsolete",
    );
    expect(extensionChange?.effect.extension).toMatchObject({
      id: "obsolete-tools",
      mapped: ["skills"],
      unavailable: ["agents"],
    });
    expect(extensionChange?.current?.digest).not.toBe(extensionChange?.desired?.digest);
  });

  it("plans missing package restoration without mutating state", async () => {
    const current = await fixture();
    const beforeConfig = structuredClone(current.config);
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(current.env);
    const beforeBytes = await readFile(databasePath);
    const beforeStat = await stat(databasePath);

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      found: true,
      summary: {
        totalActions: 7,
        unchanged: 5,
        added: 0,
        changed: 2,
        removed: 0,
        released: 0,
      },
      blockers: [],
    });
    expect(current.config).toEqual(beforeConfig);
    expect((await readFile(databasePath)).equals(beforeBytes)).toBe(true);
    expect((await stat(databasePath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("resolves an unambiguous installed package name to its final local agent id", async () => {
    const current = await fixture();

    const plan = await buildClawUpdatePlan({
      agentId: "@acme/worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan).toMatchObject({ found: true, agentId: "worker", blockers: [] });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "worker", action: "unchanged" }),
    );
  });

  it("plans restoration when the owned agent entry is missing", async () => {
    const current = await fixture();
    current.config.agents = { ...current.config.agents, entries: {} };

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    const agentAction = plan.actions.find(
      (action) => action.kind === "agent" && action.id === "worker",
    );
    expect(agentAction).toMatchObject({ action: "change", blocked: false });
    expect(agentAction).not.toHaveProperty("currentDigest");
  });

  it("preserves an adopted agent default marker when planning an update", async () => {
    const current = await fixture();
    const entry = current.config.agents?.entries?.worker;
    if (!entry) {
      throw new Error("fixture agent missing");
    }
    entry.default = true;
    const recordedAgent = { id: "worker", ...entry };
    const recordedDigest = `sha256:${createHash("sha256")
      .update(stableStringify(recordedAgent))
      .digest("hex")}`;
    openOpenClawStateDatabase({ env: current.env })
      .db.prepare(
        `UPDATE claw_installs
            SET schema_version = ?, agent_config_digest = ?, agent_owned_paths_json = ?
          WHERE agent_id = ?`,
      )
      .run(
        CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION,
        recordedDigest,
        JSON.stringify({ origin: "adopted", paths: ['agents.entries["worker"]'] }),
        "worker",
      );
    current.config.agents = {
      ...current.config.agents,
      entries: { WORKER: entry },
    };

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "worker", action: "unchanged" }),
    );
  });

  it("never restores a missing adopted agent without its captured default marker", async () => {
    const current = await fixture();
    const db = openOpenClawStateDatabase({ env: current.env }).db;
    db.prepare(
      `UPDATE claw_installs SET schema_version = ?, agent_owned_paths_json = ? WHERE agent_id = ?`,
    ).run(
      CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION,
      JSON.stringify({ origin: "adopted", paths: ['agents.entries["worker"]'] }),
      "worker",
    );
    current.config.agents = { ...current.config.agents, entries: {} };

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "worker", action: "manual", blocked: true }),
    );
  });

  it("plans workspace restoration when the owned workspace directory is missing", async () => {
    const current = await fixture();
    await rm(join(current.root, "workspace-worker"), { recursive: true, force: true });

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspaceFile", id: "SOUL.md", action: "change" }),
        expect.objectContaining({ kind: "workspaceFile", id: "OLD.md", action: "change" }),
      ]),
    );
  });

  it("plans grouped add, change, and removal actions", async () => {
    const current = await fixture();
    await writeFile(join(current.root, "SOUL-v2.md"), "new soul\n", "utf8");
    await writeFile(join(current.root, "NEW.md"), "new\n", "utf8");
    const raw = {
      schemaVersion: 1,
      agent: {
        id: "requested-id",
        name: "Worker v2",
      },
      workspace: {
        bootstrapFiles: { "SOUL.md": { source: "SOUL-v2.md" } },
        files: [{ source: "NEW.md", path: "NEW.md" }],
      },
      packages: [
        {
          kind: "skill",
          source: "clawhub",
          ref: "triage",
          version: "2.0.0",
        },
        {
          kind: "plugin",
          source: "clawhub",
          ref: "new-plugin",
          version: "1.0.0",
        },
      ],
      mcpServers: {
        docs: { command: "uvx", args: ["docs-mcp-v2"] },
        search: {
          url: "https://mcp.example.com/search",
          transport: "streamable-http",
          auth: "oauth",
        },
      },
      cronJobs: [
        {
          id: "daily",
          schedule: { cron: "0 10 * * *", timezone: "UTC" },
          session: "isolated",
          message: "Updated report",
        },
        {
          id: "weekly",
          schedule: { cron: "0 9 * * 1", timezone: "UTC" },
          session: "isolated",
          message: "Weekly report",
        },
      ],
    };
    const parsed = parseClawManifest(raw);
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetOpenClawProfile: {
        schemaVersion: 1,
        agent: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" },
          tools: { allow: ["web.fetch"] },
        },
      },
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.summary).toMatchObject({
      totalActions: 11,
      added: 4,
      changed: 5,
      removed: 1,
      released: 0,
      unchanged: 0,
      manual: 1,
      blocked: 1,
      capabilityEscalations: expect.any(Number),
    });
    expect(plan.summary.capabilityEscalations).toBeGreaterThan(0);
    expect(plan.capabilityChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent",
          path: "agent.sandbox.mode",
          desired: expect.objectContaining({ digest: expect.any(String) }),
          effect: expect.objectContaining({ path: "sandbox.mode" }),
          classification: "reduction",
          requiresDistinctConsent: false,
        }),
        expect.objectContaining({
          kind: "agent",
          path: "agent.tools.allow",
          desired: expect.objectContaining({ digest: expect.any(String) }),
          effect: expect.objectContaining({ path: "tools.allow" }),
          classification: "reduction",
          requiresDistinctConsent: false,
        }),
        expect.objectContaining({
          kind: "package",
          id: "plugin:new-plugin",
          effect: expect.objectContaining({
            version: "1.0.0",
            integrity: `sha256:${"a".repeat(64)}`,
            installId: "new-plugin",
          }),
          requiresDistinctConsent: true,
        }),
        expect.objectContaining({
          kind: "mcpServer",
          id: "search",
          effect: expect.objectContaining({
            connection: "remote-server",
            transport: "streamable-http",
            authConfigured: true,
          }),
          desired: expect.objectContaining({
            summary: "remote server; auth configured",
            digest: expect.any(String),
          }),
          requiresDistinctConsent: true,
        }),
        expect.objectContaining({
          kind: "cronJob",
          id: "daily",
          effect: expect.objectContaining({
            schedule: "cron",
            payloadWithheld: true,
          }),
          requiresDistinctConsent: true,
        }),
      ]),
    );
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", action: "change", id: "worker" }),
        expect.objectContaining({ kind: "workspaceFile", action: "remove", id: "OLD.md" }),
        expect.objectContaining({ kind: "package", action: "change", id: "skill:triage" }),
        expect.objectContaining({ kind: "mcpServer", action: "add", id: "search" }),
        expect.objectContaining({ kind: "cronJob", action: "change", id: "daily" }),
      ]),
    );
    const serializedPlan = JSON.stringify(plan);
    expect(serializedPlan).not.toContain("mcp.example.com");
    expect(serializedPlan).not.toContain("docs-mcp-v2");
    expect(serializedPlan).not.toContain("Updated report");
    expect(serializedPlan).toContain("remote server; auth configured");
    expect(serializedPlan).toContain("payload withheld");
  });

  it.each(["modified", "ambiguous"] as const)(
    "blocks removal when an installed plugin is %s",
    async (state) => {
      const current = await fixture();
      const parsed = parseClawManifest({
        ...current.manifest,
        packages: current.manifest.packages.filter((pkg) => pkg.ref !== "obsolete"),
      });
      if (!parsed.ok) {
        throw new Error(JSON.stringify(parsed.diagnostics));
      }

      const plan = await buildClawUpdatePlan({
        agentId: "worker",
        targetManifest: parsed.manifest,
        targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
        config: current.config,
        sourceMcpServers: current.config.mcp?.servers ?? {},
        stateOptions: {
          env: current.env,
          packageDeps: {
            resolvePlugin: async () =>
              state === "ambiguous"
                ? { status: "ambiguous", pluginIds: ["obsolete-a", "obsolete-b"] }
                : {
                    status: "found",
                    pluginId: "obsolete-runtime",
                    record: {
                      source: "clawhub",
                      integrity: `sha256:${"b".repeat(64)}`,
                      installedAt: "2000-01-01T00:00:00.000Z",
                    },
                    installedVersion: "1.0.0",
                  },
          },
        },
        packagePreflight,
      });

      expect(plan.actions).toContainEqual(
        expect.objectContaining({
          kind: "package",
          id: "plugin:obsolete",
          action: "manual",
          blocked: true,
          reason: expect.stringContaining(state),
        }),
      );
      const capabilityChange = plan.capabilityChanges.find(
        (change) => change.kind === "package" && change.id === "plugin:obsolete",
      );
      expect(capabilityChange).toMatchObject({
        action: "manual",
        classification: "reduction",
        requiresDistinctConsent: false,
        current: expect.objectContaining({ summary: "version 1.0.0" }),
      });
      expect(capabilityChange).not.toHaveProperty("desired");
    },
  );

  it("marks operator drift and unresolved ownership as manual", async () => {
    const current = await fixture();
    await writeFile(join(current.root, "workspace-worker", "SOUL.md"), "operator edit\n", "utf8");
    current.config.mcp!.servers!.docs = { command: "node", args: ["operator.mjs"] };
    openOpenClawStateDatabase({ env: current.env })
      .db.prepare("UPDATE claw_cron_refs SET status = 'pending' WHERE agent_id = 'worker'")
      .run();

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspaceFile", id: "SOUL.md", action: "manual" }),
        expect.objectContaining({ kind: "mcpServer", id: "docs", action: "manual" }),
        expect.objectContaining({ kind: "cronJob", id: "daily", action: "manual" }),
      ]),
    );
    expect(plan.summary.manual).toBe(3);
    expect(plan.summary.blocked).toBe(3);
    expect(plan.actions.filter((action) => action.action === "manual")).toEqual(
      expect.arrayContaining([expect.objectContaining({ blocked: true })]),
    );
  });

  it("classifies blocked MCP and cron removals as capability reductions", async () => {
    const current = await fixture();
    const database = openOpenClawStateDatabase({ env: current.env }).db;
    database
      .prepare("UPDATE claw_mcp_server_refs SET status = 'pending' WHERE agent_id = 'worker'")
      .run();
    database
      .prepare("UPDATE claw_cron_refs SET status = 'pending' WHERE agent_id = 'worker'")
      .run();
    const parsed = parseClawManifest({
      ...current.manifest,
      mcpServers: {},
      cronJobs: [],
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    for (const [kind, id] of [
      ["mcpServer", "docs"],
      ["cronJob", "daily"],
    ] as const) {
      const capabilityChange = plan.capabilityChanges.find(
        (change) => change.kind === kind && change.id === id,
      );
      expect(capabilityChange).toMatchObject({
        action: "manual",
        classification: "reduction",
        requiresDistinctConsent: false,
      });
      expect(capabilityChange).not.toHaveProperty("desired");
    }
  });

  it("blocks unowned workspace, MCP, and incompatible shared plugin claims", async () => {
    const current = await fixture();
    await writeFile(join(current.root, "NOTES-source.md"), "managed notes\n", "utf8");
    await writeFile(join(current.root, "workspace-worker", "NOTES.md"), "operator notes\n", "utf8");
    current.config.mcp = {
      ...current.config.mcp,
      servers: {
        ...current.config.mcp?.servers,
        search: { command: "node", args: ["operator-search.mjs"] },
      },
    };
    persistClawPackageRef(
      {
        ...current.addPlan,
        agent: { ...current.addPlan.agent, finalId: "other-agent" },
      },
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "0.9.0",
        integrity: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
      },
      { env: current.env },
    );
    const parsed = parseClawManifest({
      ...current.manifest,
      workspace: {
        ...current.manifest.workspace,
        files: [
          ...current.manifest.workspace.files,
          { source: "NOTES-source.md", path: "NOTES.md" },
        ],
      },
      packages: [
        ...current.manifest.packages,
        {
          kind: "plugin",
          source: "clawhub",
          ref: "audit",
          version: "1.0.0",
        },
      ],
      mcpServers: {
        ...current.manifest.mcpServers,
        search: { command: "uvx", args: ["search-mcp"] },
      },
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workspaceFile",
          id: "NOTES.md",
          action: "manual",
          blocked: true,
        }),
        expect.objectContaining({
          kind: "mcpServer",
          id: "search",
          action: "manual",
          blocked: true,
        }),
        expect.objectContaining({
          kind: "package",
          id: "plugin:audit",
          action: "manual",
          blocked: true,
        }),
      ]),
    );
    expect(plan.summary.blocked).toBe(3);
  });

  it("blocks incomplete packages and independently owned MCP changes", async () => {
    const current = await fixture();
    const database = openOpenClawStateDatabase({ env: current.env }).db;
    database
      .prepare(
        "UPDATE claw_package_refs SET package_status = 'pending' WHERE agent_id = 'worker' AND package_ref = 'triage'",
      )
      .run();
    database
      .prepare(
        "UPDATE claw_mcp_server_refs SET relationship = 'referenced', origin = 'pre-existing', independent_owner = 1 WHERE agent_id = 'worker' AND name = 'docs'",
      )
      .run();
    const parsed = parseClawManifest({
      ...current.manifest,
      mcpServers: { docs: { command: "uvx", args: ["docs-mcp-v2"] } },
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "package",
          id: "skill:triage",
          action: "manual",
          blocked: true,
        }),
        expect.objectContaining({
          kind: "mcpServer",
          id: "docs",
          action: "manual",
          blocked: true,
        }),
      ]),
    );
  });

  it("blocks restoring independently owned packages and MCP configuration", async () => {
    const current = await fixture();
    const database = openOpenClawStateDatabase({ env: current.env }).db;
    database
      .prepare(
        "UPDATE claw_package_refs SET relationship = 'referenced', origin = 'pre-existing', independent_owner = 1 WHERE agent_id = 'worker' AND package_ref = 'triage'",
      )
      .run();
    database
      .prepare(
        "UPDATE claw_mcp_server_refs SET relationship = 'referenced', origin = 'pre-existing', independent_owner = 1 WHERE agent_id = 'worker' AND name = 'docs'",
      )
      .run();
    delete current.config.mcp!.servers!.docs;

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "package",
          id: "skill:triage",
          action: "manual",
          blocked: true,
          reason: expect.stringContaining("independently owned"),
        }),
        expect.objectContaining({
          kind: "mcpServer",
          id: "docs",
          action: "manual",
          blocked: true,
          reason: expect.stringContaining("independently owned"),
        }),
      ]),
    );
  });

  it("releases a removed package declaration without uninstalling its artifact", async () => {
    const current = await fixture();
    const parsed = parseClawManifest({
      ...current.manifest,
      packages: current.manifest.packages.filter((pkg) => pkg.ref !== "triage"),
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: {
        env: current.env,
        packageDeps: {
          planSkill: async () => ({
            ok: true as const,
            plan: {
              workspaceDir: current.addPlan.agent.workspace,
              requestedRef: "triage",
              slug: "triage",
              version: "1.0.0",
              installedAt: 0,
              targetDir: join(current.addPlan.agent.workspace, "skills", "triage"),
              skillFilePath: join(current.addPlan.agent.workspace, "skills", "triage", "SKILL.md"),
              skillFileSha256: "a".repeat(64),
              fileTreeSha256: `sha256:${"a".repeat(64)}`,
            },
          }),
        },
      },
      packagePreflight,
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "package",
        id: "skill:triage",
        action: "release",
        blocked: false,
      }),
    );
  });

  it("uses update package semantics instead of add-time conflicts", async () => {
    const current = await fixture();
    const parsed = parseClawManifest({
      ...current.manifest,
      packages: [
        current.manifest.packages[0],
        { ...current.manifest.packages[1], version: "2.0.0" },
        {
          kind: "plugin",
          source: "clawhub",
          ref: "new-plugin",
          version: "1.0.0",
        },
      ],
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }
    const unavailablePreflight = async (pkg: ClawPackage) =>
      pkg.ref === "obsolete"
        ? {
            ok: false as const,
            code: "plugin_version_conflict",
            installedVersion: "1.0.0",
            message: `Installed ${pkg.ref} has the previous owned version.`,
          }
        : {
            ok: false as const,
            code:
              pkg.kind === "skill"
                ? "skill_package_preflight_unavailable"
                : "plugin_version_conflict",
            message: `Cannot add ${pkg.ref}.`,
          };

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: {
        env: current.env,
        packageDeps: {
          resolvePlugin: async () => ({
            status: "found",
            pluginId: "obsolete-runtime",
            record: {
              source: "clawhub",
              integrity: `sha256:${"a".repeat(64)}`,
              installedAt: "2000-01-01T00:00:00.000Z",
            },
            installedVersion: "1.0.0",
          }),
        },
      },
      packagePreflight: unavailablePreflight,
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "package",
          id: "skill:triage",
          action: "manual",
          blocked: true,
        }),
        expect.objectContaining({ kind: "package", id: "plugin:obsolete", action: "change" }),
        expect.objectContaining({
          kind: "package",
          id: "plugin:new-plugin",
          action: "manual",
          blocked: true,
        }),
      ]),
    );
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "skill_package_preflight_unavailable",
          path: "$.packages[0]",
        }),
        expect.objectContaining({
          code: "plugin_version_conflict",
          path: "$.packages[2]",
        }),
      ]),
    );
  });

  it("blocks changing an MCP declaration shared by another Claw", async () => {
    const current = await fixture();
    openOpenClawStateDatabase({ env: current.env })
      .db.prepare(
        `INSERT INTO claw_mcp_server_refs (
           agent_id, name, schema_version, config_digest, relationship, origin,
           independent_owner, status, error,
           created_at_ms, updated_at_ms
         ) SELECT
           'other-agent', name, schema_version, config_digest, 'referenced', origin,
           independent_owner, status, error,
           created_at_ms, updated_at_ms
         FROM claw_mcp_server_refs
         WHERE agent_id = 'worker' AND name = 'docs'`,
      )
      .run();
    const parsed = parseClawManifest({
      ...current.manifest,
      mcpServers: { docs: { command: "uvx", args: ["docs-mcp-v2"] } },
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "mcpServer",
        id: "docs",
        action: "manual",
        blocked: true,
        reason: expect.stringContaining("Another Claw shares"),
      }),
    );
  });

  it("releases shared and independently owned MCP declarations without removing config", async () => {
    const current = await fixture();
    const database = openOpenClawStateDatabase({ env: current.env }).db;
    database
      .prepare(
        `INSERT INTO claw_mcp_server_refs (
           agent_id, name, schema_version, config_digest, relationship, origin,
           independent_owner, status, error,
           created_at_ms, updated_at_ms
         ) SELECT
           'other-agent', name, schema_version, config_digest, 'referenced', origin,
           independent_owner, status, error,
           created_at_ms, updated_at_ms
         FROM claw_mcp_server_refs
         WHERE agent_id = 'worker' AND name = 'docs'`,
      )
      .run();
    current.config.mcp!.servers!.docs = { command: "node", args: ["operator-docs.mjs"] };
    const parsed = parseClawManifest({ ...current.manifest, mcpServers: {} });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const shared = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });
    expect(shared.actions).toContainEqual(
      expect.objectContaining({ kind: "mcpServer", id: "docs", action: "release", blocked: false }),
    );
    expect(shared.summary.released).toBe(1);

    database
      .prepare("DELETE FROM claw_mcp_server_refs WHERE agent_id = 'other-agent' AND name = 'docs'")
      .run();
    database
      .prepare(
        "UPDATE claw_mcp_server_refs SET relationship = 'referenced', origin = 'pre-existing', independent_owner = 1 WHERE agent_id = 'worker' AND name = 'docs'",
      )
      .run();
    const independent = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });
    expect(independent.actions).toContainEqual(
      expect.objectContaining({ kind: "mcpServer", id: "docs", action: "release", blocked: false }),
    );
  });

  it("fails closed for missing agents and mismatched package identity", async () => {
    const current = await fixture();
    const missing = await buildClawUpdatePlan({
      agentId: "missing",
      targetManifest: current.manifest,
      targetSource: current.source,
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });
    expect(missing.blockers).toContainEqual(expect.objectContaining({ code: "claw_not_found" }));

    const mismatch = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: current.manifest,
      targetSource: { ...current.source, name: "@other/worker" },
      config: current.config,
      sourceMcpServers: current.config.mcp?.servers ?? {},
      stateOptions: { env: current.env },
      packagePreflight,
    });
    expect(mismatch.blockers).toContainEqual(
      expect.objectContaining({ code: "claw_identity_mismatch" }),
    );
    const { planIntegrity, ...authenticatedPlan } = mismatch;
    expect(planIntegrity).toBe(
      `sha256:${createHash("sha256").update(stableStringify(authenticatedPlan)).digest("hex")}`,
    );
  });
});
