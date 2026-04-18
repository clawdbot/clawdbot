import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../test/helpers/import-fresh.js";

const applyCliProfileEnvMock = vi.hoisted(() => vi.fn());
const attachChildProcessBridgeMock = vi.hoisted(() => vi.fn());
const installProcessWarningFilterMock = vi.hoisted(() => vi.fn());
const isMainModuleMock = vi.hoisted(() => vi.fn(() => true));
const isRootHelpInvocationMock = vi.hoisted(() => vi.fn(() => false));
const isRootVersionInvocationMock = vi.hoisted(() => vi.fn(() => true));
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const normalizeWindowsArgvMock = vi.hoisted(() => vi.fn((argv: string[]) => argv));
const parseCliProfileArgsMock = vi.hoisted(() => vi.fn((argv: string[]) => ({ ok: true, argv })));
const resolveCliContainerTargetMock = vi.hoisted(() => vi.fn<() => string | null>(() => null));
const resolveCommitHashMock = vi.hoisted(() => vi.fn<() => string | null>(() => "abc1234"));
const runCliMock = vi.hoisted(() => vi.fn(async () => {}));
const shouldSkipRespawnForArgvMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("./cli/argv.js", () => ({
  isRootHelpInvocation: isRootHelpInvocationMock,
  isRootVersionInvocation: isRootVersionInvocationMock,
}));

vi.mock("./cli/container-target.js", () => ({
  parseCliContainerArgs: (argv: string[]) => ({ ok: true, container: null, argv }),
  resolveCliContainerTarget: resolveCliContainerTargetMock,
}));

vi.mock("./cli/profile.js", () => ({
  applyCliProfileEnv: applyCliProfileEnvMock,
  parseCliProfileArgs: parseCliProfileArgsMock,
}));

vi.mock("./cli/run-main.js", () => ({
  runCli: runCliMock,
}));

vi.mock("./cli/respawn-policy.js", () => ({
  shouldSkipRespawnForArgv: shouldSkipRespawnForArgvMock,
}));

vi.mock("./cli/windows-argv.js", () => ({
  normalizeWindowsArgv: normalizeWindowsArgvMock,
}));

vi.mock("./infra/env.js", () => ({
  isTruthyEnvValue: () => false,
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("./infra/git-commit.js", () => ({
  resolveCommitHash: resolveCommitHashMock,
}));

vi.mock("./infra/gaxios-fetch-compat.js", () => ({
  installGaxiosFetchCompat: vi.fn(async () => {}),
}));

vi.mock("./infra/is-main.js", () => ({
  isMainModule: isMainModuleMock,
}));

vi.mock("./infra/warning-filter.js", () => ({
  installProcessWarningFilter: installProcessWarningFilterMock,
}));

vi.mock("./process/child-process-bridge.js", () => ({
  attachChildProcessBridge: attachChildProcessBridgeMock,
}));

vi.mock("./version.js", () => ({
  VERSION: "9.9.9-test",
}));

async function importEntry(scope: string) {
  return await importFreshModule<typeof import("./entry.js")>(
    import.meta.url,
    `./entry.js?scope=${scope}`,
  );
}

async function flushEntrySideEffects() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("entry root version fast path", () => {
  let originalArgv: string[];
  let originalGatewayToken: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = [...process.argv];
    originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    process.argv = ["node", "openclaw", "--version"];
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as typeof process.exit);
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
    exitSpy.mockRestore();
  });

  it("prints commit-tagged version output when commit metadata is available", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await importEntry("commit-tagged");
    await flushEntrySideEffects();
    expect(logSpy).toHaveBeenCalledWith("OpenClaw 9.9.9-test (abc1234)");
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockRestore();
  });

  it("falls back to plain version output when commit metadata is unavailable", async () => {
    resolveCommitHashMock.mockReturnValueOnce(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await importEntry("plain-version");
    await flushEntrySideEffects();
    expect(logSpy).toHaveBeenCalledWith("OpenClaw 9.9.9-test");
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockRestore();
  });

  it("skips the host version fast path when a container target is active", async () => {
    resolveCliContainerTargetMock.mockReturnValue("demo");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await importEntry("container-target");
    await flushEntrySideEffects();
    expect(runCliMock).toHaveBeenCalledWith(["node", "openclaw", "--version"]);
    expect(logSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("allows root version container mode when gateway override env vars are set", async () => {
    resolveCliContainerTargetMock.mockReturnValue("demo");
    process.env.OPENCLAW_GATEWAY_TOKEN = "demo-token";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await importEntry("gateway-override");
    await flushEntrySideEffects();
    expect(runCliMock).toHaveBeenCalledWith(["node", "openclaw", "--version"]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
