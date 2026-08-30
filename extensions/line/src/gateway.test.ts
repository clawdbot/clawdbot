// Line tests cover gateway startup plugin behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lineGatewayAdapter } from "./gateway.js";
import { setLineRuntime } from "./runtime.js";
import type { LineProbeResult, ResolvedLineAccount } from "./types.js";

const { probeLineBotMock, monitorLineProviderMock } = vi.hoisted(() => ({
  probeLineBotMock: vi.fn(),
  monitorLineProviderMock: vi.fn(async () => ({ stop: async () => {} })),
}));

vi.mock("./probe.runtime.js", () => ({ probeLineBot: probeLineBotMock }));
vi.mock("./monitor.runtime.js", () => ({ monitorLineProvider: monitorLineProviderMock }));

const account = {
  accountId: "default",
  enabled: true,
  channelAccessToken: "token",
  channelSecret: "secret",
  tokenSource: "config",
  config: {},
} as unknown as ResolvedLineAccount;

// The helper types `log` as the plain sink, so the test owns the sink it asserts on.
async function startWithProbe(probe: LineProbeResult) {
  probeLineBotMock.mockResolvedValue(probe);
  const warn = vi.fn<(msg: string) => void>();
  await lineGatewayAdapter.startAccount?.({
    ...createStartAccountContext({ account }),
    log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
  });
  return warn;
}

describe("lineGatewayAdapter.startAccount", () => {
  beforeEach(() => {
    probeLineBotMock.mockReset();
    monitorLineProviderMock.mockClear();
    setLineRuntime({
      logging: { shouldLogVerbose: () => false },
      channel: {},
    } as unknown as PluginRuntime);
  });

  afterAll(() => {
    vi.doUnmock("./probe.runtime.js");
    vi.doUnmock("./monitor.runtime.js");
    vi.resetModules();
  });

  // Reaching this through status costs the operator a flag they have no reason to
  // try when nothing looks wrong, so startup has to say it where they are watching.
  it.each([
    {
      name: "registered but switched off",
      webhook: { status: "disabled", endpoint: "https://gateway.example/line/webhook" },
      expected: "webhook URL is registered but switched off",
    },
    {
      name: "never registered",
      webhook: { status: "unset" },
      expected: "no webhook URL registered",
    },
  ] as const)("warns at startup when the webhook is $name", async ({ webhook, expected }) => {
    const warn = await startWithProbe({ ok: true, webhook });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(expected);
    expect(warn.mock.calls[0]?.[0]).toContain("LINE Developers Console");
  });

  it.each([
    {
      name: "the webhook is on",
      probe: {
        ok: true,
        webhook: { status: "active", endpoint: "https://gateway.example/line/webhook" },
      },
    },
    { name: "the probe reported no webhook state", probe: { ok: true } },
    { name: "the probe failed", probe: { ok: false, error: "timeout" } },
  ] as const)("starts without a webhook warning when $name", async ({ probe }) => {
    const warn = await startWithProbe(probe as LineProbeResult);

    expect(warn).not.toHaveBeenCalled();
    expect(monitorLineProviderMock).toHaveBeenCalledTimes(1);
  });
});
