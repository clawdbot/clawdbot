import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { markClawMcpServerIndependentlyOwned } from "../state/claw-mcp-adoption.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { deleteClawMcpServerRef, installClawMcpServers, planClawMcpServerRemoval } from "./mcp.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(agentId = "worker", root?: string) {
  const packageRoot = root ?? tempDirs.make("openclaw-claw-mcp-");
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: agentId },
    mcpServers: {
      docs: {
        command: "uvx",
        args: ["docs-mcp"],
        env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      },
      linear: {
        url: "https://mcp.linear.app/mcp",
        transport: "streamable-http",
        auth: "oauth",
      },
    },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: `@acme/${agentId}`,
    version: "1.0.0",
    packageRoot,
    manifestPath: join(packageRoot, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 100,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(packageRoot, "workspace") },
  });
  return { root: packageRoot, plan, env: { OPENCLAW_STATE_DIR: join(packageRoot, "state") } };
}

function listedMcpServers(mcpServers: Record<string, Record<string, unknown>> = {}) {
  return { ok: true as const, path: "config", config: {}, mcpServers };
}

describe("installClawMcpServers", () => {
  it("uses create-only config writes and stores digest-only ownership", async () => {
    const current = await fixture();
    const setMcpServer = vi
      .fn()
      .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {} });

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      nowMs: 42,
    });

    expect(setMcpServer).toHaveBeenNthCalledWith(1, {
      name: "docs",
      server: {
        command: "uvx",
        args: ["docs-mcp"],
        env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      },
      createOnly: true,
      recordIndependentOwner: false,
    });
    expect(setMcpServer).toHaveBeenNthCalledWith(2, {
      name: "linear",
      server: {
        url: "https://mcp.linear.app/mcp",
        transport: "streamable-http",
        auth: "oauth",
      },
      createOnly: true,
      recordIndependentOwner: false,
    });
    expect(refs).toMatchObject([
      {
        schemaVersion: "openclaw.clawMcpServerRef.v1",
        agentId: "worker",
        name: "docs",
        configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
        status: "complete",
      },
      {
        schemaVersion: "openclaw.clawMcpServerRef.v1",
        agentId: "worker",
        name: "linear",
        configDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        status: "complete",
      },
    ]);
    expect(JSON.stringify(refs)).not.toContain("DOCS_TOKEN");
  });

  it("rejects a conflicting existing server without claiming ownership", async () => {
    const current = await fixture();
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        listMcpServers: vi
          .fn()
          .mockResolvedValue(listedMcpServers({ docs: { command: "different" } })),
      }),
    ).rejects.toMatchObject({
      code: "mcp_config_conflict",
      mcpServers: [],
    });
  });

  it("reuses an exact pre-existing server as a referenced resource", async () => {
    const current = await fixture();
    const setMcpServer = vi.fn();
    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(
        listedMcpServers({
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
          linear: {
            url: "https://mcp.linear.app/mcp",
            transport: "streamable-http",
            auth: "oauth",
          },
        }),
      ),
    });

    expect(setMcpServer).not.toHaveBeenCalled();
    expect(refs).toMatchObject([
      {
        name: "docs",
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
        status: "complete",
      },
      {
        name: "linear",
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
        status: "complete",
      },
    ]);
    expect(planClawMcpServerRemoval(refs[0]!, { env: current.env }).action).toBe("release");
  });

  it("allows another Claw to share an exact Claw-created server", async () => {
    const first = await fixture("worker");
    const firstRefs = await installClawMcpServers(first.plan, {
      env: first.env,
      setMcpServer: vi.fn().mockResolvedValue(listedMcpServers()),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });
    const second = await fixture("analyst", first.root);
    const setMcpServer = vi.fn();
    const refs = await installClawMcpServers(second.plan, {
      env: second.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(
        listedMcpServers({
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
          linear: {
            url: "https://mcp.linear.app/mcp",
            transport: "streamable-http",
            auth: "oauth",
          },
        }),
      ),
    });

    expect(setMcpServer).not.toHaveBeenCalled();
    expect(refs).toMatchObject([
      {
        agentId: "analyst",
        name: "docs",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
      {
        agentId: "analyst",
        name: "linear",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
    ]);
    const firstDocs = firstRefs[0]!;
    expect(planClawMcpServerRemoval(firstDocs, { env: first.env }).action).toBe("release");
    const secondDocs = refs[0]!;
    deleteClawMcpServerRef("worker", "docs", { env: first.env });
    expect(
      planClawMcpServerRemoval(secondDocs, {
        env: first.env,
        referencedCleanup: { mode: "remove-if-unused" },
      }).action,
    ).toBe("remove");
    deleteClawMcpServerRef("analyst", "docs", { env: first.env });
    expect(planClawMcpServerRemoval(firstDocs, { env: first.env }).action).toBe("remove");
  });

  it("requires explicit conflict consent to remove a pre-existing reference", async () => {
    const current = await fixture();
    const [ref] = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue(
        listedMcpServers({
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
          linear: {
            url: "https://mcp.linear.app/mcp",
            transport: "streamable-http",
            auth: "oauth",
          },
        }),
      ),
    });
    const selector = `mcp:${ref!.name}`;

    expect(
      planClawMcpServerRemoval(ref!, {
        env: current.env,
        referencedCleanup: { mode: "remove-selected", selected: [selector] },
      }),
    ).toMatchObject({ action: "release", blocked: true });
    expect(
      planClawMcpServerRemoval(ref!, {
        env: current.env,
        referencedCleanup: {
          mode: "remove-selected",
          selected: [selector],
          allowConflicts: true,
        },
      }),
    ).toMatchObject({ action: "remove", blocked: false });
  });

  it("leaves ownership pending when a config write throws", async () => {
    const current = await fixture();
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer: vi.fn().mockRejectedValue(new Error("write result unknown")),
        listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      }),
    ).rejects.toMatchObject({
      code: "mcp_install_uncertain",
      mcpServers: [{ name: "docs", status: "pending" }],
    });
  });

  it("retains a managed server after an ordinary MCP owner adopts it", async () => {
    const current = await fixture();
    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer: vi.fn().mockResolvedValue(listedMcpServers()),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });

    expect(markClawMcpServerIndependentlyOwned("docs", { env: current.env, nowMs: 50 })).toBe(1);
    const status = planClawMcpServerRemoval(
      { ...refs[0]!, independentOwner: true },
      { env: current.env },
    );
    expect(status).toMatchObject({ action: "release", blocked: false });
  });

  it("reconciles an ambiguous write from source config on retry", async () => {
    const current = await fixture();
    const setMcpServer = vi
      .fn()
      .mockRejectedValueOnce(new Error("write result unknown"))
      .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {} });
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer,
        listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      }),
    ).rejects.toMatchObject({ code: "mcp_install_uncertain" });

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue({
        ok: true,
        path: "config",
        config: {},
        mcpServers: {
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
        },
      }),
    });

    expect(setMcpServer).toHaveBeenCalledTimes(2);
    expect(refs[0]).toMatchObject({ name: "docs", status: "complete" });
    expect(refs[1]).toMatchObject({ name: "linear", status: "complete" });
  });

  it("retries an ambiguous write that did not reach source config", async () => {
    const current = await fixture();
    const setMcpServer = vi
      .fn()
      .mockRejectedValueOnce(new Error("write result unknown"))
      .mockResolvedValue(listedMcpServers());
    await expect(
      installClawMcpServers(current.plan, {
        env: current.env,
        setMcpServer,
        listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
      }),
    ).rejects.toMatchObject({ code: "mcp_install_uncertain" });

    const refs = await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer,
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers()),
    });

    expect(setMcpServer).toHaveBeenCalledTimes(3);
    expect(refs).toEqual([
      expect.objectContaining({ name: "docs", status: "complete" }),
      expect.objectContaining({ name: "linear", status: "complete" }),
    ]);
  });
});
