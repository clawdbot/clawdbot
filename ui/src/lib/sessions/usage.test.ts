import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { buildSessionUsageDateParams, requestSessionsUsage } from "./usage.ts";

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

describe("requestSessionsUsage", () => {
  it.each([
    [
      "legacy single-quoted",
      "invalid sessions.usage params: at root: unexpected property 'timeZone'",
    ],
    ["JSON-quoted", 'invalid sessions.usage params: at root: unexpected property "timeZone"'],
  ])(
    "retries older gateways with the legacy UTC offset (%s rejection)",
    async (_label, message) => {
      const result = { sessions: [] };
      const request = vi
        .fn()
        .mockRejectedValueOnce(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message,
          }),
        )
        .mockResolvedValueOnce(result);
      const params = {
        range: "all",
        mode: "specific",
        timeZone: "Europe/Vienna",
        utcOffset: "UTC+2",
      };

      await expect(requestSessionsUsage({ request } as never, params)).resolves.toBe(result);
      expect(request).toHaveBeenNthCalledWith(1, "sessions.usage", params);
      expect(request).toHaveBeenNthCalledWith(2, "sessions.usage", {
        range: "all",
        mode: "specific",
        utcOffset: "UTC+2",
      });
    },
  );

  it("does not retry unrelated invalid usage parameters", async () => {
    const error = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "invalid sessions.usage params: invalid IANA timeZone",
    });
    const request = vi.fn().mockRejectedValue(error);

    await expect(
      requestSessionsUsage({ request } as never, {
        mode: "specific",
        timeZone: "Not/AZone",
        utcOffset: "UTC+2",
      }),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
  });
});
