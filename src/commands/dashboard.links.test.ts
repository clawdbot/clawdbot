import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand } from "./dashboard.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const resolveControlUiLinksMock = vi.hoisted(() => vi.fn());
const detectBrowserOpenSupportMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn());
const formatControlUiSshHintMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());

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
  expect(logMessages().some((message) => message.includes(text))).toBe(true);
}

function expectNoLogWith(text: string): void {
  expect(logMessages().some((message) => message.includes(text))).toBe(false);
}

function mockSnapshot(token: unknown = "abc") {
  readConfigFileSnapshotMock.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: { gateway: { auth: { token } } },
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
  beforeEach(() => {
    resetRuntime();
    readConfigFileSnapshotMock.mockClear();
    resolveGatewayPortMock.mockClear();
    resolveControlUiLinksMock.mockClear();
    detectBrowserOpenSupportMock.mockClear();
    openUrlMock.mockClear();
    formatControlUiSshHintMock.mockClear();
    copyToClipboardMock.mockClear();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.CUSTOM_GATEWAY_TOKEN;
  });

  it("opens and copies the dashboard link by default", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);

    await dashboardCommand(runtime);

    expect(resolveControlUiLinksMock).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: undefined,
      basePath: undefined,
      tlsEnabled: false,
    });
    // clipboard and browser still get the full authenticated URL
    expect(copyToClipboardMock).toHaveBeenCalledWith("http://127.0.0.1:18789/#token=abc123");
    expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:18789/#token=abc123");
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

    // Clipboard and browser should still receive the tokenized URL.
    expect(copyToClipboardMock).toHaveBeenCalledWith(
      `http://127.0.0.1:18789/#token=${secretToken}`,
    );
    expect(openUrlMock).toHaveBeenCalledWith(`http://127.0.0.1:18789/#token=${secretToken}`);

    // The logged output must never contain the token — it flows into
    // console-captured log files readable by operator.read-scoped devices.
    for (const call of runtime.log.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain(secretToken);
      expect(line).not.toContain("#token=");
    }

    // Base URL should be logged without the fragment.
    expect(runtime.log).toHaveBeenCalledWith("Dashboard URL: http://127.0.0.1:18789/");
    expect(runtime.log).toHaveBeenCalledWith("Token auto-auth included in browser/clipboard URL.");
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
    expect(formatControlUiSshHintMock).toHaveBeenCalledWith({ port: 18789, basePath: undefined });
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

  it("respects --no-open and tells user token URL is in clipboard", async () => {
    mockSnapshot("abc");
    copyToClipboardMock.mockResolvedValue(true);

    await dashboardCommand(runtime, { noOpen: true });

    expect(detectBrowserOpenSupportMock).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Browser launch disabled (--no-open). Token-authenticated URL copied to clipboard.",
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

  it("respects --no-open with plain URL hint when clipboard fails and no token is configured", async () => {
    mockSnapshot("");
    copyToClipboardMock.mockResolvedValue(false);

    await dashboardCommand(runtime, { noOpen: true });

    expect(runtime.log).toHaveBeenCalledWith(
      "Browser launch disabled (--no-open). Use the URL above.",
    );
  });

  it("prints non-tokenized URL with guidance when token SecretRef is unresolved", async () => {
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

    expect(copyToClipboardMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expectLogWith("Token auto-auth unavailable");
    expectLogWith(
      "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
    );
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

    expect(copyToClipboardMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expectLogWith("Token auto-auth is disabled for SecretRef-managed");
    expectNoLogWith("Token auto-auth unavailable");
  });

  it("keeps URL non-tokenized when env-template gateway.auth.token is unresolved", async () => {
    mockSnapshot("${CUSTOM_GATEWAY_TOKEN}");
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);

    await dashboardCommand(runtime);

    expect(copyToClipboardMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:18789/");
    expectLogWith(
      "Token auto-auth unavailable: gateway.auth.token SecretRef is unresolved (env:default:CUSTOM_GATEWAY_TOKEN).",
    );
    expectNoLogWith("Token auto-auth is disabled for SecretRef-managed");
  });
});
