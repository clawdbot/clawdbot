import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawMcpUpdate } from "./mcp-update.js";
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  digestClawMcpServer,
  readClawMcpServerRefs,
  upsertClawMcpServerRef,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import { CLAW_OUTPUT_STABILITY, type ClawManifest, type ClawMcpServer } from "./types.js";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "./update-plan.js";

const oldDocs: ClawMcpServer = { command: "uvx", args: ["docs@1"] };
const newDocs: ClawMcpServer = { command: "uvx", args: ["docs@2"] };
const legacy: ClawMcpServer = { command: "node", args: ["legacy.mjs"] };
const remote: ClawMcpServer = {
  url: "https://example.com/mcp",
  transport: "streamable-http",
  auth: "oauth",
};

afterEach(() => closeOpenClawStateDatabaseForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function ref(name: string, server: ClawMcpServer): PersistedClawMcpServerRef {
  return {
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: "worker",
    name,
    configDigest: digestClawMcpServer(server),
    relationship: "managed",
    origin: "claw-introduced",
    independentOwner: false,
    status: "complete",
    createdAtMs: 10,
    updatedAtMs: 10,
  };
}

function plan(actions: ClawUpdatePlan["actions"]): ClawUpdatePlan {
  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:update-plan",
    found: true,
    agentId: "worker",
    currentClaw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:old" },
    targetClaw: { name: "@acme/worker", version: "2.0.0", integrity: "sha256:new" },
    summary: {
      totalActions: actions.length,
      added: actions.filter((action) => action.action === "add").length,
      changed: actions.filter((action) => action.action === "change").length,
      removed: actions.filter((action) => action.action === "remove").length,
      released: actions.filter((action) => action.action === "release").length,
      unchanged: 0,
      manual: 0,
      blocked: 0,
      capabilityChanges: 0,
      capabilityEscalations: 0,
    },
    actions,
    capabilityChanges: [],
    blockers: [],
    diagnostics: [],
  };
}

function manifest(): ClawManifest {
  return {
    schemaVersion: 1,
    agent: { id: "worker" },
    workspace: { bootstrapFiles: {}, files: [] },
    packages: [],
    mcpServers: { docs: newDocs, remote },
    cronJobs: [],
  };
}

describe("applyClawMcpUpdate", () => {
  it("applies add, change, and remove with CAS writes and reversible ownership", async () => {
    const currentRefs = [ref("docs", oldDocs), ref("legacy", legacy)];
    const setServer = vi.fn(async () => ({
      ok: true as const,
      path: "config",
      config: {},
      mcpServers: {},
    }));
    const unsetServer = vi.fn(async () => ({
      ok: true as const,
      path: "config",
      config: {},
      mcpServers: {},
      removed: true,
    }));
    const upsertRef = vi.fn();
    const deleteRef = vi.fn();
    const execution = await applyClawMcpUpdate(
      plan([
        {
          kind: "mcpServer",
          id: "docs",
          action: "change",
          target: "mcp.servers.docs",
          blocked: false,
          reason: "changed",
        },
        {
          kind: "mcpServer",
          id: "remote",
          action: "add",
          target: "mcp.servers.remote",
          blocked: false,
          reason: "added",
        },
        {
          kind: "mcpServer",
          id: "legacy",
          action: "remove",
          target: "mcp.servers.legacy",
          blocked: false,
          reason: "removed",
        },
      ]),
      manifest(),
      {
        config: {
          mcp: { servers: { docs: { command: "uvx", args: ["docs-resolved"] }, legacy } },
        } as OpenClawConfig,
        sourceMcpServers: { docs: oldDocs, legacy },
        nowMs: 20,
        readRefs: () => currentRefs,
        planRemoval: () => ({ action: "remove" }),
        setServer,
        unsetServer,
        upsertRef,
        deleteRef,
      },
    );

    expect(execution.appliedNames).toEqual(["docs", "remote", "legacy"]);
    expect(setServer).toHaveBeenNthCalledWith(1, {
      name: "docs",
      server: newDocs,
      expectedServer: oldDocs,
      recordIndependentOwner: false,
    });
    expect(setServer).toHaveBeenNthCalledWith(2, {
      name: "remote",
      server: remote,
      createOnly: true,
      recordIndependentOwner: false,
    });
    expect(unsetServer).toHaveBeenCalledWith({ name: "legacy", expectedServer: legacy });

    await execution.rollback();

    expect(setServer).toHaveBeenNthCalledWith(3, {
      name: "legacy",
      server: legacy,
      createOnly: true,
      recordIndependentOwner: false,
    });
    expect(unsetServer).toHaveBeenNthCalledWith(2, {
      name: "remote",
      expectedServer: remote,
    });
    expect(setServer).toHaveBeenNthCalledWith(4, {
      name: "docs",
      server: oldDocs,
      expectedServer: newDocs,
      recordIndependentOwner: false,
    });
    expect(upsertRef).toHaveBeenCalledTimes(7);
    expect(deleteRef).toHaveBeenCalledTimes(2);
  });

  it("releases ownership without removing shared or independently owned config", async () => {
    const independent = {
      ...ref("legacy", legacy),
      relationship: "referenced" as const,
      origin: "pre-existing" as const,
      independentOwner: true,
    };
    const unsetServer = vi.fn();
    const upsertRef = vi.fn();
    const deleteRef = vi.fn();
    const execution = await applyClawMcpUpdate(
      plan([
        {
          kind: "mcpServer",
          id: "legacy",
          action: "release",
          target: "mcp.servers.legacy",
          blocked: false,
          reason: "shared config survives",
        },
      ]),
      manifest(),
      {
        config: { mcp: { servers: { legacy } } },
        sourceMcpServers: { legacy },
        readRefs: () => [independent],
        planRemoval: () => ({ action: "release" }),
        unsetServer,
        upsertRef,
        deleteRef,
      },
    );

    expect(unsetServer).not.toHaveBeenCalled();
    expect(deleteRef).toHaveBeenCalledWith("worker", "legacy", expect.any(Object));
    await execution.rollback();
    expect(upsertRef).toHaveBeenCalledWith(independent, expect.any(Object));
  });

  it("rejects release when exact config becomes solely Claw-owned", async () => {
    const previous = ref("legacy", legacy);
    const deleteRef = vi.fn();
    await expect(
      applyClawMcpUpdate(
        plan([
          {
            kind: "mcpServer",
            id: "legacy",
            action: "release",
            target: "mcp.servers.legacy",
            blocked: false,
            reason: "shared at preview",
          },
        ]),
        manifest(),
        {
          config: { mcp: { servers: { legacy } } },
          sourceMcpServers: { legacy },
          readRefs: () => [previous],
          planRemoval: () => ({ action: "remove" }),
          deleteRef,
        },
      ),
    ).rejects.toThrow("no longer safely releasable");
    expect(deleteRef).not.toHaveBeenCalled();
  });

  it("restores complete MCP ownership through a real release rollback", async () => {
    const root = tempDirs.make("openclaw-mcp-release-");
    const stateOptions = { env: { OPENCLAW_STATE_DIR: join(root, "state") } };
    const independent = {
      ...ref("legacy", legacy),
      relationship: "referenced" as const,
      origin: "pre-existing" as const,
      independentOwner: true,
    };
    upsertClawMcpServerRef(independent, stateOptions);

    const execution = await applyClawMcpUpdate(
      plan([
        {
          kind: "mcpServer",
          id: "legacy",
          action: "release",
          target: "mcp.servers.legacy",
          blocked: false,
          reason: "release only",
        },
      ]),
      manifest(),
      {
        ...stateOptions,
        config: { mcp: { servers: { legacy } } },
        sourceMcpServers: { legacy },
      },
    );
    expect(readClawMcpServerRefs("worker", stateOptions)).toEqual([]);

    await execution.rollback();
    expect(readClawMcpServerRefs("worker", stateOptions)).toEqual([independent]);
  });

  it("does not compensate a config write rejected before mutation", async () => {
    const setServer = vi.fn(async () => ({ ok: false as const, path: "config", error: "changed" }));
    const unsetServer = vi.fn();

    await expect(
      applyClawMcpUpdate(
        plan([
          {
            kind: "mcpServer",
            id: "docs",
            action: "change",
            target: "mcp.servers.docs",
            blocked: false,
            reason: "changed",
          },
        ]),
        manifest(),
        {
          config: { mcp: { servers: { docs: oldDocs } } },
          sourceMcpServers: { docs: oldDocs },
          readRefs: () => [ref("docs", oldDocs)],
          setServer,
          unsetServer,
          upsertRef: vi.fn(),
        },
      ),
    ).rejects.toThrow("changed");
    expect(setServer).toHaveBeenCalledTimes(1);
    expect(unsetServer).not.toHaveBeenCalled();
  });

  it("does not overwrite an unowned server that appears before apply", async () => {
    const setServer = vi.fn();
    await expect(
      applyClawMcpUpdate(
        plan([
          {
            kind: "mcpServer",
            id: "remote",
            action: "add",
            target: "mcp.servers.remote",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          config: { mcp: { servers: { remote } } },
          sourceMcpServers: { remote },
          readRefs: () => [],
          setServer,
        },
      ),
    ).rejects.toThrow("was not claimed");
    expect(setServer).not.toHaveBeenCalled();
  });
});
