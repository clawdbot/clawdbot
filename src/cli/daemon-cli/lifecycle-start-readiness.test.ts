// Gateway service-start readiness tests cover separate liveness and usable-readiness proof.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatGatewayRestartFailure } from "./restart-health-diagnostics.js";

const service = vi.hoisted(() => ({ readCommand: vi.fn() }));
const runServiceStart = vi.hoisted(() => vi.fn());
const resolveGatewayStartupTiming = vi.hoisted(() => vi.fn(() => ({ deadlineMs: 45_000 })));
const waitForGatewayHealthyRestart = vi.hoisted(() => vi.fn());
const waitForGatewayHttpReadiness = vi.hoisted(() => vi.fn());
const renderRestartDiagnostics = vi.hoisted(() => vi.fn(() => ["runtime diagnostics"]));
const readServiceConfig = vi.hoisted(() => vi.fn());

vi.mock("../../commands/gateway-startup-timing.js", () => ({ resolveGatewayStartupTiming }));
vi.mock("../../config/config.js", () => ({
  readBestEffortConfig: vi.fn(async () => ({})),
  resolveGatewayPort: vi.fn(() => 18_789),
}));
vi.mock("../../config/io.js", () => ({
  createConfigIO: vi.fn(() => ({ readBestEffortConfig: () => readServiceConfig() })),
}));
vi.mock("../../daemon/service.js", () => ({ resolveGatewayService: () => service }));
vi.mock("../../infra/gateway-supervision.js", () => ({
  assertGatewayServiceMutationAllowed: vi.fn(),
  formatExternalSupervisorActionRequired: vi.fn(),
  isGatewayExternallySupervised: vi.fn(),
  resolveGatewayServiceMutationError: vi.fn(),
}));
vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart: vi.fn(),
  runServiceStart,
  runServiceStop: vi.fn(),
  runServiceUninstall: vi.fn(),
}));
vi.mock("./start-repair.js", () => ({ repairLoadedGatewayServiceForStart: vi.fn() }));
vi.mock("./restart-health.js", () => ({
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  formatGatewayRestartFailure,
  renderGatewayPortHealthDiagnostics: vi.fn(),
  renderRestartDiagnostics,
  terminateStaleGatewayPids: vi.fn(),
  waitForGatewayHealthyListener: vi.fn(),
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
}));

const { runDaemonStart } = await import("./lifecycle.js");

type StartPostCheck = (params: {
  fail: (message: string, hints?: string[]) => void;
  json: boolean;
  stdout: NodeJS.WritableStream;
  warnings: string[];
}) => Promise<void>;

function invokeStartPostCheck() {
  runServiceStart.mockImplementation(
    async ({ postStartCheck }: { postStartCheck?: StartPostCheck }) => {
      await postStartCheck?.({
        json: true,
        stdout: process.stdout,
        warnings: [],
        fail: (message) => {
          throw new Error(message);
        },
      });
    },
  );
}

describe("Gateway service start readiness", () => {
  beforeEach(() => {
    service.readCommand.mockReset().mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    runServiceStart.mockReset();
    readServiceConfig.mockReset().mockResolvedValue({});
    resolveGatewayStartupTiming.mockClear();
    waitForGatewayHealthyRestart.mockReset().mockResolvedValue({ healthy: true });
    waitForGatewayHttpReadiness.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
    renderRestartDiagnostics.mockClear();
  });

  it("proves Gateway health and readiness before start reports success", async () => {
    const config = { gateway: { tls: { enabled: true } } };
    readServiceConfig.mockResolvedValue(config);
    invokeStartPostCheck();

    await runDaemonStart({ json: true });

    expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
      expect.objectContaining({ service, port: 18_789, attempts: 90, delayMs: 500 }),
    );
    expect(waitForGatewayHttpReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        port: 18_789,
        attempts: 90,
        deadlineAt: expect.any(Number),
        delayMs: 500,
      }),
    );
  });

  it("reports /healthz and /readyz separately when service start remains unready", async () => {
    waitForGatewayHttpReadiness.mockResolvedValue({ healthz: 200, readyz: 503 });
    invokeStartPostCheck();

    await expect(runDaemonStart({ json: true })).rejects.toThrow(
      "waiting for /healthz and /readyz",
    );
    expect(renderRestartDiagnostics).toHaveBeenCalledOnce();
  });
});
