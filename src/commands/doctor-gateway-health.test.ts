// Doctor gateway health tests cover gateway probe failures, auth requirements, and repair messages.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/index.js";
import { retainGatewayResponsePayload } from "../../packages/gateway-client/src/protocol-request.js";
import type { OpenClawConfig } from "../config/config.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import {
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
  GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
  GATEWAY_HEALTH_RATE_LIMITED_TITLE,
} from "./gateway-health-auth-diagnostic.js";

const callGateway = vi.hoisted(() => vi.fn());
const isGatewayCredentialsRequiredError = vi.hoisted(() => vi.fn(() => false));
const isGatewaySecretRefUnavailableError = vi.hoisted(() => vi.fn(() => false));
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

vi.mock("../gateway/credentials.js", () => ({
  isGatewaySecretRefUnavailableError,
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
    isGatewaySecretRefUnavailableError.mockReset();
    isGatewaySecretRefUnavailableError.mockReturnValue(false);
    probeGatewayStatus.mockReset();
    note.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports a live state-directory mismatch and continues Doctor", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/doctor-cli-state");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "/tmp/doctor-cli-state/openclaw.json");
    callGateway.mockImplementation(
      async (options: {
        method?: string;
        onHelloOk?: (hello: { snapshot: { stateDir: string; configPath: string } }) => void;
      }) => {
        if (options.method === "status") {
          options.onHelloOk?.({
            snapshot: {
              stateDir: "/tmp/doctor-gateway-state",
              configPath: "/tmp/doctor-gateway-state/openclaw.json",
            },
          });
        }
        return {};
      },
    );
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg: {} as OpenClawConfig }),
    ).resolves.toMatchObject({ authenticated: true, healthOk: true });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("CLI and live Gateway use different"),
      "Gateway state directory mismatch",
    );
  });

  it("uses a lightweight status RPC for the restart liveness gate", async () => {
    callGateway.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({});
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: true, healthOk: true, status: { ok: true } });

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "status",
        params: { includeChannelSummary: false },
        timeoutMs: 3000,
        config: cfg,
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "channels.status",
      params: { probe: true, timeoutMs: 5000 },
      timeoutMs: 6000,
      config: cfg,
    });
    expect(callGateway).toHaveBeenNthCalledWith(3, {
      method: "diagnostics.stability",
      params: { type: "telemetry.exporter", limit: 1000 },
      timeoutMs: 3000,
      config: cfg,
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(note.mock.calls.map(([, title]) => title)).not.toContain("OpenClaw version mismatch");
  });

  it("reports startup migration warnings without marking the gateway unhealthy", async () => {
    const startupMigrationWarning = 'Retained legacy state. Run "openclaw doctor --fix".';
    callGateway.mockResolvedValueOnce({ startupMigrationWarning }).mockResolvedValue({});
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await expect(checkGatewayHealth({ runtime, cfg })).resolves.toMatchObject({ healthOk: true });
    expect(note).toHaveBeenCalledWith(startupMigrationWarning, "Startup migration warnings");
  });

  it("renders the shared redacted telemetry exporter summary", async () => {
    callGateway
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        events: [
          {
            seq: 1,
            type: "telemetry.exporter",
            source: "diagnostics-otel",
            target: "logs",
            transport: "stdout",
            outcome: "started",
            reason: "configured",
            payload: "private log payload",
          },
        ],
      });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 });

    expect(note).toHaveBeenCalledWith(
      "diagnostics-otel · logs · started · stdout",
      "Telemetry exporters",
    );
    expect(JSON.stringify(note.mock.calls)).not.toContain("private log payload");
  });

  it("reports failed channel diagnostics without marking a reachable gateway unhealthy", async () => {
    callGateway
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("channel probe timed out"));
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: true, healthOk: true, status: { ok: true } });

    expect(note).toHaveBeenCalledWith(
      [
        "Channel status probe failed: channel probe timed out",
        "Retry: openclaw channels status --probe",
      ].join("\n"),
      "Channel warnings",
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("redacts credentials and terminal controls in channel probe failures", async () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    callGateway
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(
        new Error(`\u001B[31mchannel probe failed\nAuthorization: Bearer ${token}`),
      );
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await checkGatewayHealth({ runtime: runtime as never, cfg });

    const [message, title] = note.mock.calls.at(-1) ?? [];
    expect(title).toBe("Channel warnings");
    expect(message).toContain("channel probe failed\\nAuthorization: Bearer");
    expect(message).not.toContain(token);
    expect(message).not.toContain("\u001B");
    expect(message.split("\n")).toHaveLength(2);
  });

  it("reports sanitized exporter diagnostic failures with a retry command", async () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    callGateway
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new Error(`\u001B[31mexporter probe failed\nAuthorization: Bearer ${token}`),
      );
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: true, healthOk: true, status: { ok: true } });

    const [message, title] = note.mock.calls.at(-1) ?? [];
    expect(title).toBe("Telemetry exporters");
    expect(message).toContain("Exporter diagnostics failed: exporter probe failed");
    expect(message).toContain("Retry: openclaw gateway stability --type telemetry.exporter");
    expect(message).not.toContain(token);
    expect(message).not.toContain("\u001B");
    expect(message.split("\n")).toHaveLength(2);
    expect(runtime.error).not.toHaveBeenCalled();
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

  it("lists every degraded SecretRef owner reported by Gateway status", async () => {
    callGateway
      .mockResolvedValueOnce({
        degradedSecretOwners: [
          {
            ownerKind: "account",
            ownerId: "discord:ops",
            state: "unavailable",
            paths: ["channels.discord.accounts.ops.token"],
            reason: "secret reference was not found (env:default:PRIVATE_REF_ID)",
          },
          {
            ownerKind: "capability",
            ownerId: "tts",
            state: "unavailable",
            degradationState: "stale",
            paths: ["tts.providers.elevenlabs.apiKey"],
            reason: "secret provider policy denied resolution",
          },
          {
            ownerKind: "capability",
            ownerId: "web-fetch:firecrawl",
            state: "unavailable",
            paths: ["plugins.entries.firecrawl.config.webFetch.apiKey"],
            reason: "resolved secret value was invalid",
          },
        ],
      })
      .mockResolvedValueOnce({});
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 });

    expect(note).toHaveBeenCalledWith(
      [
        "- cold account:discord:ops (channels.discord.accounts.ops.token): secret resolution failed",
        "  Retry: openclaw secrets reload",
        "- stale capability:tts (tts.providers.elevenlabs.apiKey): secret provider policy denied resolution",
        "  Retry: openclaw secrets reload",
        "- cold capability:web-fetch:firecrawl (plugins.entries.firecrawl.config.webFetch.apiKey): resolved secret value was invalid",
        "  Retry: openclaw secrets reload",
      ].join("\n"),
      "Secret runtime degradation",
    );
  });

  it("lists every plugin configured unavailable by Gateway startup", async () => {
    callGateway
      .mockResolvedValueOnce({
        degradedPlugins: [
          {
            pluginId: "discord",
            state: "configured-unavailable",
            diagnostic: {
              kind: "plugin-verification",
              reason: "unreadable-package-json",
              detail: "permission denied",
            },
          },
          {
            pluginId: "matrix",
            state: "configured-unavailable",
            diagnostic: {
              kind: "plugin-verification",
              reason: "missing-main-entry",
              detail: "dist/index.js is missing",
            },
          },
        ],
      })
      .mockResolvedValueOnce({});
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 });

    expect(note).toHaveBeenCalledWith(
      [
        "- discord (unreadable-package-json): permission denied",
        "- matrix (missing-main-entry): dist/index.js is missing",
      ].join("\n"),
      "Plugins configured unavailable",
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

  it("reports a typed close without depending on gateway error wording", async () => {
    const error = new GatewayTransportError({
      message: "transport closed: \u001B]52;c;YXR0YWNr\u0007protocol version mismatch",
      kind: "closed",
      code: 1008,
      connectionDetails: {
        url: TEST_GATEWAY_URL,
        urlSource: "local loopback",
        message: `Gateway target: ${TEST_GATEWAY_URL}`,
      },
    });
    callGateway.mockRejectedValueOnce(error);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 });

    expect(note).toHaveBeenCalledWith(
      "Gateway connect failed: transport closed: protocol version mismatch",
      "Gateway",
    );
    expect(note).not.toHaveBeenCalledWith("Gateway not running.", "Gateway");
  });

  it("reports credentials-required when status RPC auth blocks a reachable gateway", async () => {
    callGateway.mockRejectedValueOnce(new Error());
    isGatewayCredentialsRequiredError.mockReturnValueOnce(true);
    probeGatewayStatus.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: TEST_AUTH_CLOSE_ERROR,
      gatewayReached: true,
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

  it("reports a temporary lockout when status auth is rate-limited", async () => {
    callGateway.mockRejectedValueOnce(new Error());
    isGatewayCredentialsRequiredError.mockReturnValueOnce(true);
    probeGatewayStatus.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: "connect failed",
      connectFailure: { kind: "rate-limited", detailCode: "AUTH_RATE_LIMITED" },
      gatewayReached: true,
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: false, healthOk: true });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
      GATEWAY_HEALTH_RATE_LIMITED_TITLE,
    );
    expect(note).not.toHaveBeenCalledWith(
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
      GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
    );
    const output = note.mock.calls.flat().join("\n");
    expect(output).not.toContain("gateway.remote.token");
    expect(output).not.toContain("devices rotate");
  });

  it("handles the real typed rate-limit error without forcing the credentials predicate", async () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "unauthorized: too many failed authentication attempts (retry later)",
      details: {
        code: "AUTH_RATE_LIMITED",
        authReason: "rate_limited",
        recommendedNextStep: "wait_then_retry",
      },
      retryable: true,
      retryAfterMs: 60_000,
    });
    retainGatewayResponsePayload(error, undefined);
    callGateway.mockRejectedValueOnce(error);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: false, healthOk: true });

    expect(isGatewayCredentialsRequiredError).not.toHaveBeenCalled();
    expect(probeGatewayStatus).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
      GATEWAY_HEALTH_RATE_LIMITED_TITLE,
    );
  });

  it("reports credentials-required when status RPC auth SecretRefs are unavailable", async () => {
    const error = new Error("gateway.auth.password unavailable");
    callGateway.mockRejectedValueOnce(error);
    isGatewaySecretRefUnavailableError.mockReturnValueOnce(true);
    probeGatewayStatus.mockResolvedValueOnce({
      ok: false,
      kind: "connect",
      error: TEST_AUTH_CLOSE_ERROR,
      gatewayReached: true,
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ authenticated: false, healthOk: true });

    expect(isGatewaySecretRefUnavailableError).toHaveBeenCalledWith(error);
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

  it("carries last-known llama.cpp facts from the gateway", async () => {
    callGateway.mockResolvedValue({
      embedding: { ok: true },
      embeddingRuntime: {
        engine: "llama.cpp",
        state: "ready",
        backend: "metal",
        buildType: "prebuilt",
      },
    });

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toMatchObject({
      checked: true,
      ready: true,
      runtimeFacts: {
        state: "ready",
        backend: "metal",
        buildType: "prebuilt",
      },
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
