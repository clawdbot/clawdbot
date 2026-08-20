import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const mocks = vi.hoisted(() => {
  const payloads: unknown[] = [];
  return {
    payloads,
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      writeJson: vi.fn((value: unknown) => payloads.push(value)),
      writeStdout: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`__exit__:${code}`);
      }),
    },
  };
});

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown) => runtime.writeJson(value),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: async () => ({
    exists: true,
    valid: true,
    issues: [],
    warnings: [],
    legacyIssues: [],
    path: "/tmp/openclaw.json",
    raw: {},
    sourceConfig: {},
    resolved: {},
  }),
}));

const { runClawsBuildCommand, runClawsCreateCommand, runClawsDevCommand, runClawsValidateCommand } =
  await import("./claws-cli.project.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Claw project CLI", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    mocks.payloads.length = 0;
  });

  it("runs create, validate, build, and offline dev against the built artifact", async () => {
    const root = join(tempDirs.make("openclaw-claw-author-"), "author-flow");
    const artifact = join(tempDirs.make("openclaw-claw-author-output-"), "author-flow.tgz");

    await runClawsCreateCommand(root, { json: true });
    await runClawsValidateCommand(root, { json: true });
    await runClawsBuildCommand(root, { out: artifact, json: true });
    await runClawsDevCommand(root, {
      agentId: "author-flow-preview",
      workspace: join(root, "preview-workspace"),
      json: true,
    });

    const payloads = mocks.payloads as Array<Record<string, unknown>>;
    expect(payloads.map((payload) => payload.schemaVersion)).toEqual([
      "openclaw.clawProject.v1",
      "openclaw.clawProject.v1",
      "openclaw.clawBuild.v1",
      "openclaw.clawDev.v1",
    ]);
    expect(payloads[1]).toMatchObject({ excludedPaths: [] });
    expect(payloads[2]).toMatchObject({ excludedPaths: [] });
    const dev = payloads[3] as { mutationAllowed: boolean; offline: boolean; plan: ClawPlan };
    expect(dev).toMatchObject({ mutationAllowed: false, offline: true });
    expect(dev.plan).toMatchObject({ mutationAllowed: false, blockers: [] });
    expect(dev.plan.claw).toMatchObject({
      integrityKind: "artifact",
      integrity: (payloads[2] as { integrity: string }).integrity,
    });
    expect(dev.plan.claw.packageRoot).toBe(
      `claw-artifact:${(payloads[2] as { integrity: string }).integrity}`,
    );
  });

  it("emits stable dev plans without deleted extraction paths", async () => {
    const root = join(tempDirs.make("openclaw-claw-dev-stable-"), "stable-dev");
    await runClawsCreateCommand(root, { json: true });
    const options = {
      agentId: "stable-dev-preview",
      workspace: join(root, "preview-workspace"),
      json: true,
    };

    await runClawsDevCommand(root, options);
    await runClawsDevCommand(root, options);

    const payloads = mocks.payloads as Array<Record<string, unknown>>;
    const first = payloads[1] as { plan: ClawPlan };
    const second = payloads[2] as { plan: ClawPlan };
    expect(first.plan).toEqual(second.plan);
    expect(first.plan.planIntegrity).toBe(second.plan.planIntegrity);
    expect(JSON.stringify(first.plan)).not.toContain("openclaw-claw-artifact-");
    expect(first.plan.claw.packageRoot).toMatch(/^claw-artifact:sha256:/u);
  });

  it("uses command-specific schemas for build and dev failures", async () => {
    const missing = join(tempDirs.make("openclaw-claw-errors-"), "missing");

    await expect(
      runClawsBuildCommand(missing, {
        out: join(tempDirs.make("openclaw-claw-error-output-"), "missing.tgz"),
        json: true,
      }),
    ).rejects.toThrow("__exit__:1");
    await expect(runClawsDevCommand(missing, { json: true })).rejects.toThrow("__exit__:1");

    const payloads = mocks.payloads as Array<Record<string, unknown>>;
    expect(payloads).toMatchObject([
      { schemaVersion: "openclaw.clawBuild.v1", ok: false },
      { schemaVersion: "openclaw.clawDev.v1", ok: false },
    ]);
  });
});

type ClawPlan = {
  mutationAllowed: boolean;
  planIntegrity: string;
  blockers: unknown[];
  claw: { integrityKind: string; integrity: string; packageRoot: string };
};
