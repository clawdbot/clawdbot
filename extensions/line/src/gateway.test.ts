// Line tests cover gateway startup plugin behavior.
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
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

function lineAccount(config: ResolvedLineAccount["config"] = {}): ResolvedLineAccount {
  return {
    accountId: "default",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config",
    config,
  };
}

// The helper types `log` as the plain sink, so the test owns the sink it asserts on.
async function startWithProbe(probe: LineProbeResult, account = lineAccount()) {
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
    setLineRuntime(createPluginRuntimeMock());
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
      webhook: { status: "disabled" },
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
        webhook: { status: "active" },
      },
    },
    { name: "the probe reported no webhook state", probe: { ok: true } },
    { name: "the probe failed", probe: { ok: false, error: "timeout" } },
  ] satisfies { name: string; probe: LineProbeResult }[])(
    "starts without a webhook warning when $name",
    async ({ probe }) => {
      const warn = await startWithProbe(probe);

      expect(warn).not.toHaveBeenCalled();
      expect(monitorLineProviderMock).toHaveBeenCalledTimes(1);
    },
  );

  // The startup warning reaches gateway logs, which are read far more widely than
  // authenticated status. An operator using an unguessable route as a weak secret
  // must not find it there; the remedy names the config key instead.
  it("keeps an opaque configured route out of the startup warning", async () => {
    const warn = await startWithProbe(
      { ok: true, webhook: { status: "unset" } },
      lineAccount({ webhookPath: "/hooks/line-primary" }),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toContain("/hooks/line-primary");
    expect(warn.mock.calls[0]?.[0]).toContain("channels.line.webhookPath");
  });
});
