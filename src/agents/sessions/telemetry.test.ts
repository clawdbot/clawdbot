import { describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "./settings-manager.js";
import { isInstallTelemetryEnabled } from "./telemetry.js";

describe("isInstallTelemetryEnabled", () => {
  const settings = (enabled: boolean) =>
    ({ getEnableInstallTelemetry: vi.fn(() => enabled) }) as unknown as SettingsManager;

  it("uses the canonical operator env truth table", () => {
    expect(isInstallTelemetryEnabled(settings(false), " ON ")).toBe(true);
    expect(isInstallTelemetryEnabled(settings(true), "off")).toBe(false);
  });

  it("falls back to persisted settings only when the env override is absent", () => {
    expect(isInstallTelemetryEnabled(settings(true), undefined)).toBe(true);
    expect(isInstallTelemetryEnabled(settings(true), "")).toBe(false);
  });
});
