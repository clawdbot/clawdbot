import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawInstallRecord } from "../claws/provenance.js";
import { readClawManifestFile } from "../claws/reader.js";
import {
  beginClawSetupState,
  isResumableClawSetupAdd,
  markClawSetupStatePartial,
} from "../claws/setup-state.js";
import { buildClawSetupPlan } from "../claws/setup.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  listConfiguredMcpServers: vi.fn(),
  applyClawAddPlan: vi.fn(),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../config/mcp-config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/mcp-config.js")>("../config/mcp-config.js")),
  listConfiguredMcpServers: mocks.listConfiguredMcpServers,
}));

vi.mock("../claws/add.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/add.js")>("../claws/add.js")),
  applyClawAddPlan: mocks.applyClawAddPlan,
}));

const { runClawsAddCommand } = await import("./claws-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

function createRuntime() {
  const logs: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn(),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  } as unknown as RuntimeEnv;
  return { logs, runtime };
}

async function runAdd(
  source: string,
  options: Parameters<typeof runClawsAddCommand>[1],
  runtime: RuntimeEnv,
): Promise<void> {
  try {
    await runClawsAddCommand(source, options, runtime);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

async function writeSetupPackage(): Promise<{
  root: string;
  workspace: string;
  answersPath: string;
}> {
  const root = tempDirs.make("openclaw-claws-cli-setup-package-");
  await mkdir(join(root, "setup"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/setup-agent",
      version: "2.0.0",
      openclaw: { claw: "openclaw.claw.json" },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "openclaw.claw.json"),
    JSON.stringify({
      schemaVersion: 2,
      agent: { id: "setup-agent" },
      setup: {
        inputs: [{ id: "principal_name", label: "Your name", type: "string", required: true }],
      },
      personalization: {
        seeds: [{ source: "setup/USER.md.tmpl", destination: "USER.md" }],
      },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "setup", "USER.md.tmpl"),
    "Name: {{ input.principal_name }}\n",
    "utf8",
  );
  const answersPath = join(root, "answers.json");
  await writeFile(answersPath, JSON.stringify({ principal_name: "Avery" }), "utf8");
  return { root, workspace: join(root, "target-workspace"), answersPath };
}

describe("claws add setup answers", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.listConfiguredMcpServers.mockResolvedValue({
      ok: true,
      path: "config",
      config: {},
      mcpServers: {},
    });
    mocks.applyClawAddPlan.mockReset();
    mocks.applyClawAddPlan.mockImplementation(async (plan) => ({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "complete",
      planIntegrity: plan.planIntegrity,
      agent: plan.agent,
    }));
  });

  it("binds a local answers document into a version 2 dry-run without echoing values", async () => {
    const { root, workspace, answersPath } = await writeSetupPackage();
    const { logs, runtime } = createRuntime();

    await runAdd(root, { dryRun: true, workspace, answers: answersPath, json: true }, runtime);

    const output = logs[0] ?? "{}";
    expect(JSON.parse(output)).toMatchObject({
      manifestSchemaVersion: 2,
      blockers: [],
      setup: {
        valid: true,
        providedInputIds: ["principal_name"],
        seeds: [
          {
            destination: "USER.md",
            blocked: false,
            digest: expect.stringMatching(/^sha256:/),
          },
        ],
      },
    });
    expect(output).not.toContain("Avery");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects answers for a schema version 1 Claw", async () => {
    const root = tempDirs.make("openclaw-claws-cli-v1-");
    const manifestPath = join(root, "openclaw.claw.json");
    const answersPath = join(root, "answers.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, agent: { id: "demo-agent" } }),
      "utf8",
    );
    await writeFile(answersPath, "{}", "utf8");
    const { logs, runtime } = createRuntime();

    await runAdd(manifestPath, { dryRun: true, answers: answersPath, json: true }, runtime);

    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      valid: false,
      diagnostics: [{ code: "setup_answers_unsupported", path: "$.answers" }],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("resumes a partial add only when exact setup handoff state exists", async () => {
    const { root, workspace, answersPath } = await writeSetupPackage();
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));
    const first = createRuntime();
    await runAdd(
      root,
      { dryRun: true, workspace, answers: answersPath, json: true },
      first.runtime,
    );
    const plan = JSON.parse(first.logs[0] ?? "{}");
    const loaded = await readClawManifestFile(root);
    if (!loaded.ok || loaded.manifest.schemaVersion !== 2) {
      throw new Error("Setup resume fixture did not load.");
    }
    const setup = await buildClawSetupPlan({
      manifest: loaded.manifest,
      packageRoot: root,
      answers: { principal_name: "Avery" },
    });
    if (!setup.materialization) {
      throw new Error("Setup resume fixture did not materialize.");
    }
    persistClawInstallRecord(plan, { status: "partial", nowMs: 1 });
    beginClawSetupState(plan, setup.materialization, { nowMs: 1 });
    markClawSetupStatePartial(plan.agent.finalId, { nowMs: 2 });
    expect(isResumableClawSetupAdd(plan)).toBe(true);
    await mkdir(workspace);
    mocks.getRuntimeConfig.mockReturnValue({ agents: { list: [plan.agent.config] } });
    const resumed = createRuntime();

    await runAdd(
      root,
      {
        yes: true,
        planIntegrity: plan.planIntegrity,
        workspace,
        answers: answersPath,
        json: true,
      },
      resumed.runtime,
    );

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity, blockers: [] }),
      expect.objectContaining({ consentPlanIntegrity: plan.planIntegrity }),
    );
    expect(resumed.runtime.exit).not.toHaveBeenCalled();
  });
});
