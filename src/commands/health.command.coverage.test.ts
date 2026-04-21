import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";
import type { HealthSummary } from "./health.js";
import { healthCommand } from "./health.js";

const callGatewayMock = vi.fn();
const buildGatewayConnectionDetailsMock = vi.fn(() => ({
  message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
}));
const logWebSelfIdMock = vi.fn();

function createRecentSessionRows(now = Date.now()) {
  return [
    { key: "main", updatedAt: now - 60_000, age: 60_000 },
    { key: "foo", updatedAt: null, age: null },
  ];
}

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: [unknown, ...unknown[]]) =>
    Reflect.apply(callGatewayMock, undefined, args),
  buildGatewayConnectionDetails: (...args: [unknown, ...unknown[]]) =>
    Reflect.apply(buildGatewayConnectionDetailsMock, undefined, args),
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: vi.fn(async () => ({})),
}));

vi.mock("../channels/plugins/index.js", () => {
  const whatsappPlugin = {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/channels/whatsapp",
      blurb: "WhatsApp test stub.",
    },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    status: {
      logSelfId: () => logWebSelfIdMock(),
    },
  };

  return {
    getChannelPlugin: (channelId: string) => (channelId === "whatsapp" ? whatsappPlugin : null),
    listChannelPlugins: () => [whatsappPlugin],
  };
});

describe("healthCommand (coverage)", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    buildGatewayConnectionDetailsMock.mockReturnValue({
      message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
    });
  });

  it("prints the rich text summary and verbose gateway details", async () => {
    const recent = createRecentSessionRows();
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      ts: Date.now(),
      durationMs: 5,
      channels: {
        whatsapp: {
          accountId: "default",
          linked: true,
          authAgeMs: 5 * 60_000,
        },
        telegram: {
          accountId: "default",
          configured: true,
          probe: {
            ok: true,
            elapsedMs: 7,
            bot: { username: "bot" },
            webhook: { url: "https://example.com/h" },
          },
        },
        discord: {
          accountId: "default",
          configured: false,
        },
      },
      channelOrder: ["whatsapp", "telegram", "discord"],
      channelLabels: {
        whatsapp: "WhatsApp",
        telegram: "Telegram",
        discord: "Discord",
      },
      heartbeatSeconds: 60,
      defaultAgentId: "main",
      agents: [
        {
          agentId: "main",
          isDefault: true,
          heartbeat: {
            enabled: true,
            every: "1m",
            everyMs: 60_000,
            prompt: "hi",
            target: "last",
            ackMaxChars: 160,
          },
          sessions: {
            path: "/tmp/sessions.json",
            count: 2,
            recent,
          },
        },
      ],
      sessions: {
        path: "/tmp/sessions.json",
        count: 2,
        recent,
      },
    } satisfies HealthSummary);

    await healthCommand({ json: false, verbose: true, timeoutMs: 1000 }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    const output = stripAnsi(runtime.log.mock.calls.map((c) => String(c[0])).join("\n"));
    expect(output).toMatch(/WhatsApp: linked/i);
    expect(runtime.log.mock.calls.slice(0, 3)).toEqual([
      ["Gateway connection:"],
      ["  Gateway mode: local"],
      ["  Gateway target: ws://127.0.0.1:18789"],
    ]);
    expect(buildGatewayConnectionDetailsMock).toHaveBeenCalled();
    expect(logWebSelfIdMock).not.toHaveBeenCalled();
  });
});
