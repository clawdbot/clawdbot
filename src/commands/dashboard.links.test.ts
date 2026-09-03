// Dashboard link tests cover dashboard command URL resolution and config snapshot handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand } from "./dashboard.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const resolveControlUiLinksMock = vi.hoisted(() => vi.fn());
const detectBrowserOpenSupportMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn());
const formatControlUiSshHintMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const issueDeviceBootstrapTokenMock = vi.hoisted(() => vi.fn());
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const ensureGatewayReadyForOperationMock = vi.hoisted(() => vi.fn());
const waitForControlUiDocumentMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  resolveGatewayPort: resolveGatewayPortMock,
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: resolveControlUiLinksMock,
  detectBrowserOpenSupport: detectBrowserOpenSupportMock,
  openUrl: openUrlMock,
  formatControlUiSshHint: formatControlUiSshHintMock,
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: copyToClipboardMock,
}));

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: issueDeviceBootstrapTokenMock,
}));

vi.mock("./gateway-readiness.js", () => ({
  ensureGatewayReadyForOperation: ensureGatewayReadyForOperationMock,
}));

vi.mock("./control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-handoff.js")>()),
  waitForControlUiDocument: waitForControlUiDocumentMock,
}));

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function resetRuntime() {
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
}

function logMessages(): string[] {
  return runtime.log.mock.calls.map(([message]) => String(message));
}

function expectLogWith(text: string): void {
  expect(logMessages().join("\n")).toContain(text);
}

function expectNoLogWith(text: string): void {
  expect(logMessages().join("\n")).not.toContain(text);
}

function mockSnapshot(
  token: unknown = "abc",
  gatewayOptions?: {
    controlUi?: { basePath: string };
    tls?: { enabled: boolean };
  },
) {
  readConfigFileSnapshotMock.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: { gateway: { auth: { token }, ...gatewayOptions } },
    issues: [],
    legacyIssues: [],
  });
  resolveGatewayPortMock.mockReturnValue(18789);
  resolveControlUiLinksMock.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  resolveSecretRefValuesMock.mockReset();
}

describe("dashboardCommand", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    resetRuntime();
    readConfigFileSnapshotMock.mockClear();
    resolveGatewayPortMock.mockClear();
    resolveControlUiLinksMock.mockClear();
    detectBrowserOpenSupportMock.mockClear();
    openUrlMock.mockClear();
    formatControlUiSshHintMock.mockClear();
    copyToClipboardMock.mockClear();
    issueDeviceBootstrapTokenMock.mockReset();
    issueDeviceBootstrapTokenMock.mockResolvedValue({
      token: "browser-bootstrap",
      expiresAtMs: 123_456,
    });
    ensureGatewayReadyForOperationMock.mockReset();
    ensureGatewayReadyForOperationMock.mockResolvedValue({
      ready: true,
      status: {},
      recovered: false,
    });
    waitForControlUiDocumentMock.mockReset();
    waitForControlUiDocumentMock.mockResolvedValue({ ready: true });
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.CUSTOM_GATEWAY_TOKEN;
  });

  it("opens and copies the dashboard link by default", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);

    await dashboardCommand(runtime);

    expect(ensureGatewayReadyForOperationMock).toHaveBeenCalledWith({
      runtime,
      operation: "open the dashboard",
      yes: undefined,
      probeUrl: "ws://127.0.0.1:18789",
      readyWhenReachable: true,
    });
    expect(resolveControlUiLinksMock).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: undefined,
      basePath: undefined,
      tlsEnabled: false,
    });
    expect(issueDeviceBootstrapTokenMock).toHaveBeenCalledWith({
      profile: {
        roles: ["operator"],
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.questions",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
        purpose: "control-ui-owner",
      },
    });
    expect(copyToClipboardMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner",
    );
    expect(openUrlMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Opened in your browser. Keep that tab to control OpenClaw.",
    );
  });

  it("never logs the gateway token in the dashboard URL (CVE regression)", async () => {
    const secretToken = "super-secret-bearer-token";
    mockSnapshot(secretToken);
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);

    await dashboardCommand(runtime);

    // Clipboard and browser receive only the short-lived browser bootstrap.
    expect(copyToClipboardMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner",
    );
    expect(openUrlMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner",
    );

    // The logged output must never contain the token — it flows into
    // console-captured log files readable by operator.read-scoped devices.
    for (const call of runtime.log.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain(secretToken);
      expect(line).not.toContain("#token=");
    }

    // Base URL should be logged without the fragment.
    expect(runtime.log).toHaveBeenCalledWith("Dashboard URL: http://127.0.0.1:18789/");
    expect(runtime.log).toHaveBeenCalledWith(
      "One-time browser pairing included in browser/clipboard URL.",
    );
  });

  it("prints SSH hint when browser cannot open", async () => {
    mockSnapshot("shhhh");
    copyToClipboardMock.mockResolvedValue(false);
    detectBrowserOpenSupportMock.mockResolvedValue({
      ok: false,
      reason: "ssh",
    });
    formatControlUiSshHintMock.mockReturnValue("ssh hint");

    await dashboardCommand(runtime);

    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("ssh hint");
  });

  it("preserves Gateway TLS after remote browser delivery fails", async () => {
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");
    mockSnapshot("shhhh", {
      controlUi: { basePath: "/control" },
      tls: { enabled: true },
    });
    resolveControlUiLinksMock.mockReturnValue({
      httpUrl: "https://127.0.0.1:18789/control/",
      wsUrl: "wss://127.0.0.1:18789/control",
    });
    copyToClipboardMock.mockResolvedValue(false);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(false);
    formatControlUiSshHintMock.mockReturnValue("ssh hint");

    await dashboardCommand(runtime);

    expect(formatControlUiSshHintMock).toHaveBeenCalledWith({
      port: 18789,
      basePath: "/control",
      tlsEnabled: true,
    });
  });

  it("reports opener failure without claiming the host has no GUI", async () => {
    mockSnapshot("shhhh");
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(false);

    await dashboardCommand(runtime);

    expect(formatControlUiSshHintMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Browser launch failed. Open the one-time pairing URL copied to clipboard.",
    );
  });

  it("prints the SSH hint when browser and clipboard delivery fail after support detection", async () => {
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");
    mockSnapshot("shhhh");
    copyToClipboardMock.mockResolvedValue(false);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(false);
    formatControlUiSshHintMock.mockReturnValue("ssh hint");

    await dashboardCommand(runtime);

    expect(formatControlUiSshHintMock).toHaveBeenCalledWith({
      port: 18789,
      basePath: undefined,
      tlsEnabled: false,
    });
    expect(runtime.log).toHaveBeenCalledWith("ssh hint");
  });

  it("never passes token to SSH hint (CVE regression — SSH path)", async () => {
    const secretToken = "super-secret-bearer-token";
    mockSnapshot(secretToken);
    copyToClipboardMock.mockResolvedValue(false);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: false, reason: "ssh" });
    formatControlUiSshHintMock.mockReturnValue("ssh hint without token");

    await dashboardCommand(runtime);

    // formatControlUiSshHint must NOT receive the token — the returned
    // hint string is written to runtime.log, which flows into the same
    // console-captured log file readable by operator.read-scoped devices.
    expect(formatControlUiSshHintMock).toHaveBeenCalledWith({
      port: 18789,
      basePath: undefined,
      tlsEnabled: false,
    });
    const [sshHintOptions] = formatControlUiSshHintMock.mock.calls[0] ?? [];
    expect(sshHintOptions).not.toHaveProperty("token");

    // Double-check: no logged line contains the secret.
    for (const call of runtime.log.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain(secretToken);
      expect(line).not.toContain("#token=");
    }
  });

  it("guides user to manual auth when delivery channels both fail (CVE-safe)", async () => {
    const secretToken = "super-secret-bearer-token";
    mockSnapshot(secretToken);
    copyToClipboardMock.mockResolvedValue(false);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: false, reason: "ssh" });
    formatControlUiSshHintMock.mockReturnValue("ssh hint without token");

    await dashboardCommand(runtime);

    const allLogs = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");

    // CVE: token value and fragment marker must not appear in logs.
    expect(allLogs).not.toContain(secretToken);
    expect(allLogs).not.toContain("#token=");

    // UX: user must be pointed to where their token lives so they can self-recover.
    expect(allLogs).toMatch(/OPENCLAW_GATEWAY_TOKEN/);
    // UX: hint must name the URL fragment key so the user knows the syntax.
    expect(allLogs).toContain("key `token`");
  });

  it("respects --no-open and tells user the pairing URL is in clipboard", async () => {
    mockSnapshot("abc");
    copyToClipboardMock.mockResolvedValue(true);

    await dashboardCommand(runtime, { noOpen: true });

    expect(detectBrowserOpenSupportMock).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Browser launch disabled (--no-open). One-time browser pairing URL copied to clipboard.",
    );
  });

  it("respects --no-open and falls through to manual-auth hint when clipboard fails (token configured)", async () => {
    mockSnapshot("abc");
    copyToClipboardMock.mockResolvedValue(false);

    await dashboardCommand(runtime, { noOpen: true });

    // Redundant fallback hint is suppressed when the manual-auth hint speaks.
    expect(runtime.log).not.toHaveBeenCalledWith(
      "Browser launch disabled (--no-open). Use the URL above.",
    );
    expectLogWith("OPENCLAW_GATEWAY_TOKEN");
  });

  it("guides no-token users to the explicit JSON handoff when clipboard delivery fails", async () => {
    mockSnapshot("");
    copyToClipboardMock.mockResolvedValue(false);

    await dashboardCommand(runtime, { noOpen: true });

    expect(runtime.log).not.toHaveBeenCalledWith(
      "Browser launch disabled (--no-open). Use the URL above.",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "One-time pairing URL not delivered. Run `openclaw dashboard --json` and open its `browserUrl` within ten minutes.",
    );
  });

  it("uses browser bootstrap when the shared-token SecretRef is unresolved", async () => {
    mockSnapshot({
      source: "env",
      provider: "default",
      id: "MISSING_GATEWAY_TOKEN",
    });
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);
    resolveSecretRefValuesMock.mockRejectedValue(new Error("missing env var"));

    await dashboardCommand(runtime);

    expect(copyToClipboardMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner",
    );
    expectNoLogWith("Token auto-auth unavailable");
    expectNoLogWith("missing env var");
  });

  it("keeps URL non-tokenized when token SecretRef is unresolved but env fallback exists", async () => {
    mockSnapshot({
      source: "env",
      provider: "default",
      id: "MISSING_GATEWAY_TOKEN",
    });
    process.env.OPENCLAW_GATEWAY_TOKEN = "fallback-token";
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);
    resolveSecretRefValuesMock.mockRejectedValue(new Error("missing env var"));

    await dashboardCommand(runtime);

    expect(copyToClipboardMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner",
    );
    expect(openUrlMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner",
    );
    expectNoLogWith("Token auto-auth is disabled for SecretRef-managed");
    expectNoLogWith("Token auto-auth unavailable");
  });

  it("keeps URL non-tokenized when env-template gateway.auth.token is unresolved", async () => {
    mockSnapshot("${CUSTOM_GATEWAY_TOKEN}");
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);

    await dashboardCommand(runtime);

    expect(copyToClipboardMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner",
    );
    expect(openUrlMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/#bootstrapToken=browser-bootstrap&bootstrapProfile=owner",
    );
    expectNoLogWith("Token auto-auth unavailable");
    expectNoLogWith("Token auto-auth is disabled for SecretRef-managed");
  });

  it("does not copy or open when gateway readiness fails", async () => {
    mockSnapshot("abc");
    ensureGatewayReadyForOperationMock.mockResolvedValueOnce({
      ready: false,
      status: {},
      reason: "Gateway is not running.",
      recoverable: true,
    });

    await dashboardCommand(runtime);

    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    expect(copyToClipboardMock).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(issueDeviceBootstrapTokenMock).not.toHaveBeenCalled();
  });

  it("fails closed when a browser pairing link cannot be issued", async () => {
    mockSnapshot("abc");
    issueDeviceBootstrapTokenMock.mockRejectedValue(new Error("state store unavailable"));

    await dashboardCommand(runtime);

    expect(copyToClipboardMock).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      "Could not create a one-time browser pairing link: state store unavailable",
    );
  });
});
