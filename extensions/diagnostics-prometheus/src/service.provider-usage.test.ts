import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsPrometheusExporter } from "./service.js";
import type { TrustedExporterInternalDiagnostics } from "./service.test-helpers.js";

type ProviderUsageListener = (snapshot: {
  generation: number;
  providers: readonly {
    provider: string;
    windows: readonly {
      window: string;
      usedRatio: number;
      resetTimestampSeconds?: number;
    }[];
    lastAttemptTimestampSeconds?: number;
    lastSuccessTimestampSeconds?: number;
    refreshSuccess: boolean;
    refreshOutcome:
      | "success"
      | "timeout"
      | "auth"
      | "rate_limit"
      | "billing"
      | "format"
      | "unknown";
  }[];
}) => void;

describe("diagnostics-prometheus provider usage", () => {
  it("does not acquire provider usage while diagnostics are disabled", async () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const observeProviderUsage = vi.fn();
    await exporter.service.start({
      config: { diagnostics: { enabled: false } } as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      internalDiagnostics: {
        emit: vi.fn(),
        onEvent: () => vi.fn(),
        observeProviderUsage,
        reportExporterHealth: vi.fn(),
      } as TrustedExporterInternalDiagnostics,
    });

    expect(observeProviderUsage).not.toHaveBeenCalled();
    expect(exporter.render()).toBe("");
  });

  it("renders cache-owned provider usage and withdraws stale series", async () => {
    const exporter = createDiagnosticsPrometheusExporter();
    const unsubscribe = vi.fn();
    let publish: ProviderUsageListener | undefined;
    await exporter.service.start({
      config: {} as never,
      stateDir: "/tmp/openclaw-prometheus-test",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      internalDiagnostics: {
        emit: vi.fn(),
        onEvent: () => vi.fn(),
        observeProviderUsage: async (listener: ProviderUsageListener) => {
          publish = listener;
          return unsubscribe;
        },
        reportExporterHealth: vi.fn(),
      } as TrustedExporterInternalDiagnostics,
    });

    expectDefined(
      publish,
      "provider usage listener",
    )({
      generation: 1,
      providers: [
        {
          provider: "openai",
          windows: [{ window: "5h", usedRatio: 0.15, resetTimestampSeconds: 1_700_003_600 }],
          lastAttemptTimestampSeconds: 1_700_000_000,
          lastSuccessTimestampSeconds: 1_700_000_001,
          refreshSuccess: true,
          refreshOutcome: "success",
        },
      ],
    });
    expect(exporter.render()).toContain(
      'openclaw_provider_usage_used_ratio{provider="openai",window="5h"} 0.15',
    );
    expect(exporter.render()).toContain(
      'openclaw_provider_usage_refresh_success{provider="openai"} 1',
    );

    expectDefined(publish, "provider usage listener")({ generation: 2, providers: [] });
    expect(exporter.render()).not.toContain("openclaw_provider_usage_");

    exporter.service.stop?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
