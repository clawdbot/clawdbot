import { asRecord } from "@openclaw/normalization-core/record-coerce";
/**
 * Android node capability policy-config regression tests.
 */
import { describe, expect, it } from "vitest";
import { unwrapRemoteConfigSnapshot } from "../../test/helpers/gateway/android-node-capabilities-policy-config.js";

describe("unwrapRemoteConfigSnapshot", () => {
  it("reads direct config snapshot payload from GatewayClient.request", () => {
    const cfg = unwrapRemoteConfigSnapshot({ gateway: { bind: "127.0.0.1" } });
    expect(asRecord(cfg.gateway).bind).toBe("127.0.0.1");
  });

  it("prefers resolved snapshot payload when present", () => {
    const cfg = unwrapRemoteConfigSnapshot({
      config: { gateway: { bind: "127.0.0.2" } },
      resolved: { gateway: { bind: "127.0.0.3" } },
    });
    expect(asRecord(cfg.gateway).bind).toBe("127.0.0.3");
  });

  it("supports wrapped config payload fallback", () => {
    const cfg = unwrapRemoteConfigSnapshot({ config: { gateway: { bind: "127.0.0.2" } } });
    expect(asRecord(cfg.gateway).bind).toBe("127.0.0.2");
  });

  it("supports legacy nested payload fallback", () => {
    const cfg = unwrapRemoteConfigSnapshot({
      payload: { config: { gateway: { bind: "::1" } } },
    });
    expect(asRecord(cfg.gateway).bind).toBe("::1");
  });

  it("supports legacy nested resolved payload fallback", () => {
    const cfg = unwrapRemoteConfigSnapshot({
      payload: { resolved: { gateway: { bind: "::2" } } },
    });
    expect(asRecord(cfg.gateway).bind).toBe("::2");
  });

  it("throws when no usable config payload exists", () => {
    expect(() => unwrapRemoteConfigSnapshot({ payload: {} })).toThrow(
      "remote gateway config.get returned empty config payload",
    );
  });
});
