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

describe("requestSessionUsage legacy timeZone retry", () => {
  const query = {
    startDate: "2026-07-01",
    endDate: "2026-07-28",
    scope: "instance",
    timeZone: "local",
  } as const;

  it("retries older gateways with the legacy UTC offset", async () => {
    const result = { sessions: [] };
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "invalid sessions.usage params: at root: unexpected property 'timeZone'",
        }),
      )
      .mockResolvedValueOnce(result);

    await expect(requestSessionUsage({ request } as never, query)).resolves.toBe(result);
    expect(request).toHaveBeenCalledTimes(2);
    const [, firstParams] = request.mock.calls[0] as [string, Record<string, unknown>];
    const [, retryParams] = request.mock.calls[1] as [string, Record<string, unknown>];
    expect(typeof firstParams.timeZone).toBe("string");
    expect(typeof firstParams.utcOffset).toBe("string");
    const { timeZone: _dropped, ...withoutTimeZone } = firstParams;
    expect(retryParams).toEqual(withoutTimeZone);
  });

  it("does not retry unrelated invalid usage parameters", async () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "invalid sessions.usage params: invalid IANA timeZone",
    });
    const request = vi.fn().mockRejectedValue(error);

    await expect(requestSessionUsage({ request } as never, query)).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
  });
});
