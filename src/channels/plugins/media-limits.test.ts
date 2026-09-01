import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChannelMediaMaxBytes } from "./media-limits.js";

const MB = 1024 * 1024;

function resolve(params: { channelLimitMb?: number; defaultLimitMb?: number }) {
  const cfg = {
    agents:
      params.defaultLimitMb === undefined
        ? undefined
        : { defaults: { mediaMaxMb: params.defaultLimitMb } },
  } as OpenClawConfig;
  return resolveChannelMediaMaxBytes({
    cfg,
    resolveChannelLimitMb: () => params.channelLimitMb,
  });
}

describe("resolveChannelMediaMaxBytes", () => {
  it("normalizes channel limits to finite positive whole bytes", () => {
    expect(resolve({ channelLimitMb: 1.5 / MB })).toBe(1);
    expect(resolve({ channelLimitMb: 2.9 / MB })).toBe(2);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back from invalid channel limit %s",
    (channelLimitMb) => {
      expect(resolve({ channelLimitMb, defaultLimitMb: 4 / MB })).toBe(4);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "ignores invalid default limit %s",
    (defaultLimitMb) => {
      expect(resolve({ defaultLimitMb })).toBeUndefined();
    },
  );
});
