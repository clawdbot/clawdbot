import { describe, expect, it, vi } from "vitest";
import {
  createTelemetryConfig,
  createTraceContextProvider,
  type CopilotTraceContextErrorInfo,
} from "./telemetry-bridge.js";

describe("createTelemetryConfig", () => {
  it("returns undefined for undefined input", () => {
    expect(createTelemetryConfig()).toBeUndefined();
  });

  it("returns undefined when every field is undefined", () => {
    expect(createTelemetryConfig({})).toBeUndefined();
    expect(
      createTelemetryConfig({
        otlpEndpoint: undefined,
        filePath: undefined,
      }),
    ).toBeUndefined();
  });

  it("includes only the fields that were explicitly set", () => {
    expect(createTelemetryConfig({ otlpEndpoint: "https://otel.example/v1/traces" })).toEqual({
      otlpEndpoint: "https://otel.example/v1/traces",
    });
    expect(createTelemetryConfig({ sourceName: "openclaw" })).toEqual({
      sourceName: "openclaw",
    });
  });

  it("round-trips a fully populated config", () => {
    const result = createTelemetryConfig({
      otlpEndpoint: "https://otel.example/v1/traces",
      filePath: "/tmp/openclaw-traces.jsonl",
      exporterType: "otlp-http",
      sourceName: "openclaw",
      captureContent: true,
    });
    expect(result).toEqual({
      otlpEndpoint: "https://otel.example/v1/traces",
      filePath: "/tmp/openclaw-traces.jsonl",
      exporterType: "otlp-http",
      sourceName: "openclaw",
      captureContent: true,
    });
  });

  it("preserves captureContent: false (explicit disable, not undefined)", () => {
    expect(createTelemetryConfig({ captureContent: false })).toEqual({
      captureContent: false,
    });
  });

  it("preserves empty-string values (caller chose to set them)", () => {
    expect(createTelemetryConfig({ otlpEndpoint: "" })).toEqual({ otlpEndpoint: "" });
  });
});

describe("createTraceContextProvider", () => {
  it("returns an empty context when no sources are configured", async () => {
    const provider = createTraceContextProvider();
    await expect(provider()).resolves.toEqual({});
  });

  it("prefers getTraceContext over the convenience sources", async () => {
    const getTraceContext = vi.fn().mockResolvedValue({
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      tracestate: "vendor=value",
    });
    const getTraceparent = vi.fn().mockResolvedValue("00-ffff-ffff-01");
    const provider = createTraceContextProvider({ getTraceContext, getTraceparent });
    const ctx = await provider();
    expect(ctx).toEqual({
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      tracestate: "vendor=value",
    });
    expect(getTraceparent).not.toHaveBeenCalled();
  });

  it("falls back to getTraceparent when getTraceContext returns undefined", async () => {
    const getTraceContext = vi.fn().mockResolvedValue(undefined);
    const getTraceparent = vi
      .fn()
      .mockResolvedValue("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    const provider = createTraceContextProvider({ getTraceContext, getTraceparent });
    await expect(provider()).resolves.toEqual({
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    });
    expect(getTraceContext).toHaveBeenCalledTimes(1);
    expect(getTraceparent).toHaveBeenCalledTimes(1);
  });

  it("includes tracestate when both convenience sources return non-empty values", async () => {
    const provider = createTraceContextProvider({
      getTraceparent: () => "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      getTracestate: () => "vendor=value",
    });
    await expect(provider()).resolves.toEqual({
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      tracestate: "vendor=value",
    });
  });

  it("omits empty/undefined tracestate even when traceparent is present", async () => {
    const providerUndef = createTraceContextProvider({
      getTraceparent: () => "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      getTracestate: () => undefined,
    });
    await expect(providerUndef()).resolves.toEqual({
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    });
    const providerEmpty = createTraceContextProvider({
      getTraceparent: () => "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      getTracestate: () => "",
    });
    await expect(providerEmpty()).resolves.toEqual({
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    });
  });

  it("does not propagate tracestate without traceparent (W3C requirement)", async () => {
    const getTracestate = vi.fn().mockResolvedValue("vendor=value");
    const provider = createTraceContextProvider({
      getTraceparent: () => undefined,
      getTracestate,
    });
    await expect(provider()).resolves.toEqual({});
    expect(getTracestate).not.toHaveBeenCalled();
  });

  it("re-reads sources on every invocation (so caching the provider is safe)", async () => {
    let parent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const provider = createTraceContextProvider({ getTraceparent: () => parent });
    await expect(provider()).resolves.toEqual({ traceparent: parent });
    parent = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01";
    await expect(provider()).resolves.toEqual({ traceparent: parent });
  });

  it("getTraceContext failure → empty context + notifier called with the original error", async () => {
    const onError = vi.fn();
    const provider = createTraceContextProvider({
      getTraceContext: () => {
        throw new Error("ctx-boom");
      },
      getTraceparent: () => "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      onError,
    });
    await expect(provider()).resolves.toEqual({});
    expect(onError).toHaveBeenCalledTimes(1);
    const info = onError.mock.calls[0]?.[0] as CopilotTraceContextErrorInfo;
    expect(info.part).toBe("traceContext");
    expect(info.error.message).toBe("ctx-boom");
  });

  it("getTraceparent failure → empty context + notifier called", async () => {
    const onError = vi.fn();
    const provider = createTraceContextProvider({
      getTraceparent: async () => {
        throw new Error("parent-boom");
      },
      getTracestate: () => "vendor=value",
      onError,
    });
    await expect(provider()).resolves.toEqual({});
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as CopilotTraceContextErrorInfo).part).toBe("traceparent");
  });

  it("getTracestate failure → partial success (traceparent kept) + notifier called", async () => {
    const onError = vi.fn();
    const provider = createTraceContextProvider({
      getTraceparent: () => "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      getTracestate: () => {
        throw new Error("state-boom");
      },
      onError,
    });
    await expect(provider()).resolves.toEqual({
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as CopilotTraceContextErrorInfo).part).toBe("tracestate");
  });

  it("default notifier uses console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const provider = createTraceContextProvider({
        getTraceparent: () => {
          throw new Error("default-warn-path");
        },
      });
      await expect(provider()).resolves.toEqual({});
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("traceparent");
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("default-warn-path");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("normalizes non-Error throws into Error before notifying", async () => {
    const onError = vi.fn();
    const provider = createTraceContextProvider({
      getTraceparent: () => {
        throw "string-boom";
      },
      onError,
    });
    await expect(provider()).resolves.toEqual({});
    const info = onError.mock.calls[0]?.[0] as CopilotTraceContextErrorInfo;
    expect(info.error).toBeInstanceOf(Error);
    expect(info.error.message).toBe("string-boom");
  });

  it("notifier throws are swallowed (provider always resolves)", async () => {
    const provider = createTraceContextProvider({
      getTraceparent: () => {
        throw new Error("boom");
      },
      onError: () => {
        throw new Error("notifier-boom");
      },
    });
    await expect(provider()).resolves.toEqual({});
  });

  it("treats only-traceContext source returning empty object as a valid context (no fallback)", async () => {
    const getTraceparent = vi.fn();
    const provider = createTraceContextProvider({
      getTraceContext: () => ({}),
      getTraceparent,
    });
    await expect(provider()).resolves.toEqual({});
    expect(getTraceparent).not.toHaveBeenCalled();
  });
});
