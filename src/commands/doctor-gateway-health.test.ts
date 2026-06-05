// Doctor gateway health tests cover gateway probe failures, auth requirements, and repair messages.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
} from "./gateway-health-auth-diagnostic.js";

const callGateway = vi.hoisted(() => vi.fn());
const isGatewayCredentialsRequiredError = vi.hoisted(() => vi.fn(() => false));
const probeGatewayStatus = vi.hoisted(() => vi.fn());
const note = vi.hoisted(() => vi.fn());
const TEST_GATEWAY_URL = "ws://127.0.0.1:18789";
const TEST_AUTH_CLOSE_ERROR = "gateway closed (1008):";
const TEST_TLS_FINGERPRINT = "sha256:test-doctor-gateway-fingerprint";

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: vi.fn(() => ({
    message: `Gateway target: ${TEST_GATEWAY_URL}`,
    url: TEST_GATEWAY_URL,
  })),
  buildGatewayProbeConnectionDetails: vi.fn(() => ({
    preauthHandshakeTimeoutMs: 4321,
    tlsFingerprint: TEST_TLS_FINGERPRINT,
    url: TEST_GATEWAY_URL,
  })),
  callGateway,
  isGatewayCredentialsRequiredError,
}));

vi.mock("../cli/daemon-cli/probe.js", () => ({
  probeGatewayStatus,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("./health.js", () => ({
  healthCommand: vi.fn(),
}));

import { checkGatewayHealth, probeGatewayMemoryStatus } from "./doctor-gateway-health.js";

describe("checkGatewayHealth", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    callGateway.mockReset();
    isGatewayCredentialsRequiredError.mockReset();
    isGatewayCredentialsRequiredError.mockReturnValue(false);
    probeGatewayStatus.mockReset();
    note.mockReset();
  });

  it("uses a lightweight status RPC for the restart liveness gate", async () => {
    callGateway.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({});
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: true, healthOk: true, status: { ok: true } });

    expect(callGateway).toHaveBeenNthCalledWith(1, {
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: 3000,
      config: cfg,
    });
    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "channels.status",
      params: { probe: true, timeoutMs: 5000 },
      timeoutMs: 6000,
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(note.mock.calls.map(([, title]) => title)).not.toContain("OpenClaw version mismatch");
  });

  it("notes CLI and gateway version mismatch when the gateway reports another runtime version", async () => {
    callGateway.mockResolvedValueOnce({ runtimeVersion: "2026.4.23" }).mockResolvedValueOnce({});
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({
      authenticated: true,
      healthOk: true,
      status: { runtimeVersion: "2026.4.23" },
    });

    const mismatchNotes = note.mock.calls
      .filter(([, title]) => title === "OpenClaw version mismatch")
      .map(([message]) => String(message));
    const mismatchOutput = mismatchNotes.join("\n");
    expect(mismatchOutput).toContain("the running Gateway is OpenClaw 2026.4.23");
    expect(mismatchOutput).not.toContain("That usually means");
    expect(mismatchOutput).toContain("Check `openclaw --version`, `which openclaw`");
    expect(mismatchOutput).toContain(
      "If this mismatch is unexpected, update PATH so `openclaw` points to the version you want",
    );
  });

  it("does not run follow-up channel probes when liveness fails", async () => {
    callGateway.mockRejectedValueOnce(new Error("gateway timeout after 3000ms"));
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: false, healthOk: false, status: undefined });

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("gateway timeout after 3000ms"),
    );
  });

  it("reports credentials-required when status RPC auth blocks a reachable gateway", async () => {
    callGateway.mockRejectedValueOnce(new Error());
    isGatewayCredentialsRequiredError.mockReturnValueOnce(true);
    probeGatewayStatus.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: TEST_AUTH_CLOSE_ERROR,
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: false, healthOk: true });

    expect(probeGatewayStatus).toHaveBeenCalledWith({
      url: TEST_GATEWAY_URL,
      timeoutMs: 3000,
      tlsFingerprint: TEST_TLS_FINGERPRINT,
      preauthHandshakeTimeoutMs: 4321,
      config: cfg,
      json: true,
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
    );
    expect(callGateway).toHaveBeenCalledTimes(1);
  });
});

describe("probeGatewayMemoryStatus", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    callGateway.mockReset();
  });

  it("requests cached memory status without a live embedding probe", async () => {
    callGateway.mockResolvedValue({ embedding: { ok: true } });

    await expect(probeGatewayMemoryStatus({ cfg, timeoutMs: 1234 })).resolves.toEqual({
      checked: true,
      ready: true,
      error: undefined,
      skipped: false,
    });

    expect(callGateway).toHaveBeenCalledWith({
      method: "doctor.memory.status",
      params: { probe: false },
      timeoutMs: 1234,
      config: cfg,
    });
  });

  it("treats outer gateway timeouts as inconclusive (skipped: false)", async () => {
    // A transport timeout must NOT be treated as a skipped probe. It is a real
    // diagnostic signal and the renderer should warn for key-optional providers.
    callGateway.mockRejectedValue(
      new Error(`gateway timeout after 8000ms\nGateway target: ${TEST_GATEWAY_URL}`),
    );

    const result = await probeGatewayMemoryStatus({ cfg });
    expect(result.checked).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.error).toContain("gateway memory probe timed out");
    expect(result.skipped).toBe(false);
  });

  it("propagates checked: false and skipped: true when gateway skipped the embedding probe", async () => {
    // Gateway returns checked: false when called with probe: false and no cached
    // availability data (SKIPPED_MEMORY_EMBEDDING_PROBE shape). The adapter must
    // also set skipped: true so renderers can distinguish this from a transport
    // timeout (which also returns checked: false but skipped: false).
    callGateway.mockResolvedValue({
      embedding: {
        ok: false,
        checked: false,
        error:
          "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
      },
    });

    const result = await probeGatewayMemoryStatus({ cfg });
    expect(result.checked).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.error).toContain("not checked");
    expect(result.skipped).toBe(true);
  });

  it("keeps gateway request timeouts as explicit failures", async () => {
    callGateway.mockRejectedValue(new Error("gateway request timeout for doctor.memory.status"));

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: true,
      ready: false,
      error: "gateway memory probe unavailable: gateway request timeout for doctor.memory.status",
      skipped: false,
    });
  });

  it("keeps non-timeout gateway errors as explicit failures", async () => {
    callGateway.mockRejectedValue(new Error("gateway closed (1006): no close reason"));

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: true,
      ready: false,
      error: "gateway memory probe unavailable: gateway closed (1006): no close reason",
      skipped: false,
    });
  });
});
