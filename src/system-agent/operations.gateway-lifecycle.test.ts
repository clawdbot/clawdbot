import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDaemonStart, runDaemonStop } from "../cli/daemon-cli/lifecycle.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import type { GatewayService } from "../daemon/service.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import type { GatewayHostLifecycle } from "../gateway/server-public.js";
import { defaultRuntime } from "../runtime.js";
import { executeSystemAgentOperation } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const { service, appendAudit } = vi.hoisted(() => ({
  service: {
    label: "Test service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn<GatewayService["stage"]>(),
    install: vi.fn<GatewayService["install"]>(),
    uninstall: vi.fn<GatewayService["uninstall"]>(),
    start: vi.fn<GatewayService["start"]>(),
    stop: vi.fn<GatewayService["stop"]>(),
    restart: vi.fn<GatewayService["restart"]>(),
    isLoaded: vi.fn<GatewayService["isLoaded"]>(),
    readCommand: vi.fn<GatewayService["readCommand"]>(),
    readRuntime: vi.fn<GatewayService["readRuntime"]>(),
  } satisfies GatewayService,
  appendAudit: vi.fn<typeof import("./audit.js").appendSystemAgentAuditEntry>(),
}));

// Keep load-state normalization and CLI failure handling real; only the OS adapter is replaced.
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => service,
}));

vi.mock("../config/config.js", async () => {
  const { resolveGatewayPort } = await import("../config/paths.js");
  const snapshot: ConfigFileSnapshot = {
    path: "/test/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    sourceConfig: {},
    resolved: {},
    runtimeConfig: {},
    config: {},
    valid: true,
    hash: "lifecycle-test-config",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
  return {
    getRuntimeConfig: () => ({}),
    readBestEffortConfig: async () => ({}),
    readConfigFileSnapshot: async () => snapshot,
    resolveGatewayPort,
  };
});

vi.mock("./audit.js", () => ({
  SYSTEM_AGENT_AUDIT_STORE_LABEL: "test audit",
  appendSystemAgentAuditEntry: appendAudit,
}));

describe("SystemAgent hosted gateway lifecycle", () => {
  const exitSentinel = new Error("native CLI attempted to exit the host");

  beforeEach(() => {
    vi.clearAllMocks();
    service.isLoaded.mockReset().mockResolvedValue(true);
    service.stop.mockReset().mockResolvedValue(undefined);
    // Preserve the real service-identity guard within the wrapper's isolated HOME.
    mockSystemAccountHome();
    for (const key of [
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_PROFILE",
      "OPENCLAW_SUPERVISOR_MODE",
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw exitSentinel;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { kind: "gateway-start", outcome: "already-running", summary: "Gateway already running" },
    { kind: "gateway-stop", outcome: "scheduled", summary: "Scheduled Gateway stop" },
    { kind: "gateway-restart", outcome: "scheduled", summary: "Scheduled Gateway restart" },
  ] as const)(
    "audits the hosted $kind outcome without claiming native completion",
    async ({ kind, outcome, summary }) => {
      const request = vi.fn<GatewayHostLifecycle["request"]>(async (_action, assertCaller) => {
        assertCaller();
        return { ok: true, value: { outcome } };
      });
      const { runtime, lines } = createSystemAgentTestRuntime();
      const guard = vi.fn();
      const deps = { setupSurface: "gateway" as const, gatewayHostLifecycle: { request } };
      await expect(executeSystemAgentOperation({ kind }, runtime, { deps })).resolves.toMatchObject(
        { applied: false },
      );
      expect(request).not.toHaveBeenCalled();
      await expect(
        executeSystemAgentOperation({ kind }, runtime, {
          approved: true,
          beforePersistentApply: guard,
          deps,
        }),
      ).resolves.toMatchObject({ applied: true });
      expect(guard).toHaveBeenCalledOnce();
      expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({ summary }));
      expect(lines).toContain(summary);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.stop).not.toHaveBeenCalled();
    },
  );

  it("does not audit a rejected hosted stop as an applied operation", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    await expect(
      executeSystemAgentOperation({ kind: "gateway-stop" }, runtime, {
        approved: true,
        deps: {
          setupSurface: "gateway",
          gatewayHostLifecycle: {
            request: async () => ({ ok: false, error: "native service ownership changed" }),
          },
        },
      }),
    ).rejects.toThrow("native service ownership changed");
    expect(appendAudit).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] done:");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "gateway-start", fault: "service inspection failure" },
    { kind: "gateway-stop", fault: "service inspection failure" },
    { kind: "gateway-stop", fault: "native stop refusal" },
  ] as const)("keeps $kind in the host after $fault", async ({ kind, fault }) => {
    const serviceError = new Error(fault);
    if (fault === "service inspection failure") {
      service.isLoaded.mockRejectedValue(serviceError);
    } else {
      service.stop.mockRejectedValue(serviceError);
    }

    // This control proves the fault reaches the exiting CLI boundary and preserves CLI semantics.
    const native = kind === "gateway-start" ? runDaemonStart() : runDaemonStop({ force: true });
    await expect(native).rejects.toBe(exitSentinel);
    expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(fault));
    vi.clearAllMocks();

    const { runtime, lines } = createSystemAgentTestRuntime();
    const captureExit = vi.spyOn(runtime, "exit");
    const [outcome] = await Promise.allSettled([
      executeSystemAgentOperation({ kind }, runtime, {
        approved: true,
        deps: { setupSurface: "gateway" },
      }),
    ]);

    // A thrown sentinel keeps Vitest alive but must never count as a recoverable host error.
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(captureExit).not.toHaveBeenCalled();
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({
        summary: kind === "gateway-start" ? "Started Gateway" : "Stopped Gateway",
      }),
    );

    if (outcome.status === "rejected") {
      // No hosted owner is installed here. Its unavailability may be an ordinary domain error.
      expect(outcome.reason).toBeInstanceOf(Error);
      expect(outcome.reason).not.toBe(exitSentinel);
      expect(outcome.reason).toMatchObject({ message: expect.stringMatching(/gateway|host/i) });
      expect(appendAudit).not.toHaveBeenCalled();
      expect(lines.join("\n")).not.toContain("[openclaw] done:");
      return;
    }

    expect(outcome.value.exitsInteractive).not.toBe(true);
    const report = [...lines, outcome.value.message ?? ""].join("\n");
    if (outcome.value.applied) {
      expect(report).toMatch(
        kind === "gateway-start" ? /already running/i : /scheduled|requested|accepted/i,
      );
      return;
    }
    expect(report).toMatch(
      kind === "gateway-start"
        ? /already running|unavailable|not available|cannot/i
        : /scheduled|requested|accepted|unavailable|not available|cannot/i,
    );
    expect(appendAudit).not.toHaveBeenCalled();
    expect(report).not.toContain("[openclaw] done:");
  });
});
