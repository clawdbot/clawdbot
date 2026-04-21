import { describe, expect, it } from "vitest";
import {
  isAcpTagVisible,
  resolveAcpProjectionSettings,
  resolveAcpStreamingConfig,
} from "./acp-stream-settings.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

describe("acp stream settings", () => {
  it("resolves stable defaults", () => {
    const settings = resolveAcpProjectionSettings(createAcpTestConfig());
    expect(settings.deliveryMode).toBe("final_only");
    expect(settings.hiddenBoundarySeparator).toBe("paragraph");
    expect(settings.repeatSuppression).toBe(true);
    expect(settings.maxOutputChars).toBe(24_000);
    expect(settings.maxSessionUpdateChars).toBe(320);
  });

  it("applies explicit stream overrides", () => {
    const settings = resolveAcpProjectionSettings(
      createAcpTestConfig({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "final_only",
            hiddenBoundarySeparator: "space",
            repeatSuppression: false,
            maxOutputChars: 500,
            maxSessionUpdateChars: 123,
            tagVisibility: {
              usage_update: true,
            },
          },
        },
      }),
    );
    expect(settings.deliveryMode).toBe("final_only");
    expect(settings.hiddenBoundarySeparator).toBe("space");
    expect(settings.repeatSuppression).toBe(false);
    expect(settings.maxOutputChars).toBe(500);
    expect(settings.maxSessionUpdateChars).toBe(123);
    expect(settings.tagVisibility.usage_update).toBe(true);
  });

  it("accepts explicit deliveryMode=live override", () => {
    const settings = resolveAcpProjectionSettings(
      createAcpTestConfig({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "live",
          },
        },
      }),
    );
    expect(settings.deliveryMode).toBe("live");
    expect(settings.hiddenBoundarySeparator).toBe("space");
  });

  it("uses default tag visibility when no override is provided", () => {
    const settings = resolveAcpProjectionSettings(createAcpTestConfig());
    expect(isAcpTagVisible(settings, "tool_call")).toBe(false);
    expect(isAcpTagVisible(settings, "tool_call_update")).toBe(false);
    expect(isAcpTagVisible(settings, "usage_update")).toBe(false);
  });

  it("respects tag visibility overrides", () => {
    const settings = resolveAcpProjectionSettings(
      createAcpTestConfig({
        acp: {
          enabled: true,
          stream: {
            tagVisibility: {
              usage_update: true,
              tool_call: false,
            },
          },
        },
      }),
    );
    expect(isAcpTagVisible(settings, "usage_update")).toBe(true);
    expect(isAcpTagVisible(settings, "tool_call")).toBe(false);
  });

  it("resolves chunking/coalescing from ACP stream controls", () => {
    const streaming = resolveAcpStreamingConfig({
      cfg: createAcpTestConfig(),
      provider: "quietchat",
    });
    expect(streaming.chunking.maxChars).toBe(64);
    expect(streaming.coalescing.idleMs).toBe(0);
  });

  it("applies live-mode streaming overrides for incremental delivery", () => {
    const streaming = resolveAcpStreamingConfig({
      cfg: createAcpTestConfig({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "live",
            coalesceIdleMs: 350,
            maxChunkChars: 256,
          },
        },
      }),
      provider: "quietchat",
      deliveryMode: "live",
    });
    expect(streaming.chunking.minChars).toBe(1);
    expect(streaming.chunking.maxChars).toBe(256);
    expect(streaming.coalescing.minChars).toBe(1);
    expect(streaming.coalescing.maxChars).toBe(256);
    expect(streaming.coalescing.joiner).toBe("");
    expect(streaming.coalescing.idleMs).toBe(350);
  });
});
