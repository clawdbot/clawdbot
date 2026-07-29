/** Tests ACP stream settings normalization from config. */
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

  it("applies retained stream overrides while preserving built-in tuning", () => {
    const settings = resolveAcpProjectionSettings(
      createAcpTestConfig({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "final_only",
            repeatSuppression: false,
            tagVisibility: {
              usage_update: true,
            },
          },
        },
      }),
    );
    expect(settings.deliveryMode).toBe("final_only");
    expect(settings.hiddenBoundarySeparator).toBe("paragraph");
    expect(settings.repeatSuppression).toBe(false);
    expect(settings.maxOutputChars).toBe(24_000);
    expect(settings.maxSessionUpdateChars).toBe(320);
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

  it("resolves built-in ACP chunking and coalescing", () => {
    const streaming = resolveAcpStreamingConfig({
      cfg: createAcpTestConfig(),
      provider: "quietchat",
    });
    expect(streaming.chunking.maxChars).toBe(1800);
    expect(streaming.coalescing.idleMs).toBe(350);
  });

  it("applies live-mode delivery with built-in streaming tuning", () => {
    const streaming = resolveAcpStreamingConfig({
      cfg: createAcpTestConfig({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "live",
          },
        },
      }),
      provider: "quietchat",
      deliveryMode: "live",
    });
    expect(streaming.chunking.minChars).toBe(1);
    expect(streaming.chunking.maxChars).toBe(1800);
    expect(streaming.coalescing.minChars).toBe(1);
    expect(streaming.coalescing.maxChars).toBe(1800);
    expect(streaming.coalescing.joiner).toBe("");
    expect(streaming.coalescing.idleMs).toBe(350);
  });
});
