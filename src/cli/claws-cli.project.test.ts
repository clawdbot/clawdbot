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
  getRuntimeConfig: () => ({}),
}));

vi.mock("../config/mcp-config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/mcp-config.js")>("../config/mcp-config.js")),
  listConfiguredMcpServers: async () => ({ ok: true, mcpServers: {} }),
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
  });
});

type ClawPlan = {
  mutationAllowed: boolean;
  blockers: unknown[];
  claw: { integrityKind: string; integrity: string };
};
