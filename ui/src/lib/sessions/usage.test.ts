import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { buildSessionUsageDateParams, requestSessionUsage } from "./usage.ts";

describe("buildSessionUsageDateParams", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses UTC mode without local timezone parameters", () => {
    expect(buildSessionUsageDateParams("utc")).toEqual({ mode: "utc" });
  });

  it("sends the browser IANA timezone with the current UTC offset in local mode", () => {
    const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...resolvedOptions,
      timeZone: "Europe/Vienna",
    });
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-120);

    expect(buildSessionUsageDateParams("local")).toEqual({
      mode: "specific",
      timeZone: "Europe/Vienna",
      utcOffset: "UTC+2",
    });
  });
});

describe("requestSessionUsage", () => {
  it("requests canonical family grouping", async () => {
    const result = { sessions: [] };
    const request = vi.fn().mockResolvedValue(result);

    await expect(
      requestSessionUsage({ request } as never, {
        startDate: "2026-07-01",
        endDate: "2026-07-28",
        scope: "family",
        timeZone: "utc",
      }),
    ).resolves.toBe(result);
    expect(request).toHaveBeenCalledWith("sessions.usage", {
      startDate: "2026-07-01",
      endDate: "2026-07-28",
      agentScope: "all",
      mode: "utc",
      groupBy: "family",
      limit: 1000,
      includeContextWeight: true,
    });
  });

  it("surfaces a rejected request without retrying an older Gateway shape", async () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "invalid sessions.usage params: at root: unexpected property 'timeZone'",
    });
    const request = vi.fn().mockRejectedValue(error);

    await expect(
      requestSessionUsage({ request } as never, {
        startDate: "2026-07-01",
        endDate: "2026-07-28",
        scope: "instance",
        timeZone: "local",
      }),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
  });
});
