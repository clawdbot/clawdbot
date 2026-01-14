import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HealthSummary } from "./health.js";
import { healthCommand } from "./health.js";

const callGatewayMock = vi.fn();
const logWebSelfIdMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../web/auth-store.js", () => ({
  webAuthExists: vi.fn(async () => true),
  getWebAuthAgeMs: vi.fn(() => 0),
  logWebSelfId: (...args: unknown[]) => logWebSelfIdMock(...args),
}));

describe("healthCommand (coverage)", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints the rich text summary when linked and configured", async () => {
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      ts: Date.now(),
      durationMs: 5,
      channels: {
        whatsapp: {
          linked: true,
          authAgeMs: 5 * 60_000,
        },
        telegram: {
          configured: true,
          probe: {
            ok: true,
            elapsedMs: 7,
            bot: { username: "bot" },
            webhook: { url: "https://example.com/h" },
          },
        },
        discord: {
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
      sessions: {
        path: "/tmp/sessions.json",
        count: 2,
        recent: [
          { key: "main", updatedAt: Date.now() - 60_000, age: 60_000 },
          { key: "foo", updatedAt: null, age: null },
        ],
      },
    } satisfies HealthSummary);

    await healthCommand({ json: false, timeoutMs: 1000 }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /WhatsApp: linked/i,
    );
    expect(logWebSelfIdMock).toHaveBeenCalled();
  });
});
