import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn(async () => ({ ok: true }));
vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("./progress.js", () => ({
  withProgress: async (_options: unknown, action: () => Promise<unknown>) => await action(),
}));

const { callGatewayFromCliRuntime } = await import("./gateway-rpc.runtime.js");

describe("callGatewayFromCliRuntime", () => {
  beforeEach(() => {
    callGatewayMock.mockClear().mockResolvedValue({ ok: true });
  });

  it.each([
    ["cron status", "cron.status"],
    ["cron list", "cron.list"],
    ["cron add", "cron.add"],
    ["cron update", "cron.update"],
    ["cron remove", "cron.remove"],
    ["cron get", "cron.get"],
    ["cron runs", "cron.runs"],
    ["cron run", "cron.run"],
    ["logs", "logs.tail"],
    ["secrets reload", "secrets.reload"],
  ])("rejects malformed shared --timeout before gateway call for %s", async (_name, method) => {
    await expect(callGatewayFromCliRuntime(method, { timeout: "10ms" })).rejects.toThrow(
      'Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "10ms".',
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5"])("rejects invalid shared --timeout value %j", async (timeout) => {
    await expect(callGatewayFromCliRuntime("cron.status", { timeout })).rejects.toThrow(
      `Received: "${timeout}"`,
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("passes strict integer timeouts to the gateway call", async () => {
    await callGatewayFromCliRuntime("cron.status", { timeout: "15000" });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.status",
        timeoutMs: 15_000,
      }),
    );
  });
});
