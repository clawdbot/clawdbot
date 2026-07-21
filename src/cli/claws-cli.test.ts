// Tests for the experimental grouped Claws CLI.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn((value: unknown) => errors.push(String(value))),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return { logs, errors, runtime, loadConfig: vi.fn<() => Record<string, unknown>>(() => ({})) };
});

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
}));

const { registerClawsCli } = await import("./claws-cli.js");

const minimalManifest = { schemaVersion: 1, agent: { id: "demo-agent", name: "Demo Agent" } };

async function writeManifest(value: unknown = minimalManifest): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-"));
  const path = join(dir, "openclaw.claw.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

async function writePackage(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "openclaw-claws-cli-package-"));
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Demo\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/demo-agent",
      version: "1.2.3",
      openclaw: { claw: "openclaw.claw.json" },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "openclaw.claw.json"),
    JSON.stringify({
      schemaVersion: 1,
      agent: { id: "demo-agent", name: "Demo Agent" },
      workspace: {
        bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
      },
      packages: [{ kind: "skill", source: "clawhub", ref: "@acme/demo-skill", version: "1.0.0" }],
    }),
    "utf8",
  );
  return { root, workspace: join(root, "target-workspace") };
}

async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerClawsCli(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

describe("claws cli", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({});
  });

  it("does not register without the process opt-in", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    const program = new Command();

    registerClawsCli(program);

    expect(program.commands.map((command) => command.name())).not.toContain("claws");
  });

  it("registers inspect and add without exposing the prototype apply or feed commands", () => {
    const program = new Command();
    registerClawsCli(program);
    const claws = program.commands.find((command) => command.name() === "claws");

    expect(claws?.commands.map((command) => command.name())).toEqual(["inspect", "add"]);
  });

  it("prints versioned experimental JSON for a development manifest", async () => {
    const manifestPath = await writeManifest();

    await runCli(["claws", "inspect", manifestPath, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawInspect.v1",
      stability: "experimental",
      valid: true,
      source: { kind: "development", version: "0.0.0-development" },
      manifest: { schemaVersion: 1, agent: { id: "demo-agent" } },
    });
  });

  it("takes identity from package.json and plans one new agent", async () => {
    const { root, workspace } = await writePackage();

    await runCli(["claws", "add", root, "--dry-run", "--workspace", workspace, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawAddPlan.v1",
      stability: "experimental",
      claw: { kind: "package", name: "@acme/demo-agent", version: "1.2.3" },
      agent: { finalId: "demo-agent", workspace },
      summary: { agentActions: 1, workspaceActions: 2, packageActions: 1, blockedActions: 1 },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("blocks adding into an existing agent instead of merging", async () => {
    const { root, workspace } = await writePackage();
    mocks.loadConfig.mockReturnValue({ agents: { list: [{ id: "demo-agent" }] } });

    await runCli(["claws", "add", root, "--dry-run", "--workspace", workspace, "--json"]);

    const payload = JSON.parse(mocks.logs[0] ?? "{}");
    expect(payload.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_id_collision" }),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("honors an explicit unused agent id in the plan", async () => {
    const { root, workspace } = await writePackage();
    mocks.loadConfig.mockReturnValue({ agents: { list: [{ id: "demo-agent" }] } });

    await runCli([
      "claws",
      "add",
      root,
      "--dry-run",
      "--agent-id",
      "demo-agent-two",
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}").agent).toMatchObject({
      requestedId: "demo-agent",
      finalId: "demo-agent-two",
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("discloses capability escalations in the human dry-run", async () => {
    const path = await writeManifest({
      schemaVersion: 1,
      agent: { id: "demo-agent", tools: { allow: ["read"] } },
      mcpServers: {
        docs: {
          command: "node",
          env: { API_TOKEN: "${GITHUB_TOKEN}" },
          toolFilter: { include: ["search_*"] },
        },
      },
    });

    await runCli(["claws", "add", path, "--dry-run"]);

    expect(mocks.logs).toContain("Capability escalations (2):");
    expect(mocks.logs.some((line) => line.startsWith("  ! agent:demo-agent"))).toBe(true);
    expect(mocks.logs.some((line) => line.startsWith("  ! mcpServer:docs"))).toBe(true);
    expect(
      mocks.logs.some(
        (line) =>
          line.includes('"name":"API_TOKEN"') && line.includes('"reference":"GITHUB_TOKEN"'),
      ),
    ).toBe(true);
    expect(mocks.logs).toContain("The plan integrity binds every capability line above.");
  });

  it("fails closed when add is invoked without dry-run", async () => {
    const path = await writeManifest();

    await runCli(["claws", "add", path, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      stability: "experimental",
      ok: false,
      error: { code: "dry_run_required" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
