import { describe, expect, it } from "vitest";
import {
  assertConfigWriteAllowedInCurrentMode,
  blockConfigWritesForRuntime,
} from "./nix-mode-write-guard.js";

describe("runtime config write blocks", () => {
  it("supports overlapping owners released out of order", () => {
    const configPath = "/tmp/openclaw.json";
    const restoreFirst = blockConfigWritesForRuntime({ configPath, reason: "first owner" });
    const restoreSecond = blockConfigWritesForRuntime({ configPath, reason: "second owner" });

    try {
      restoreFirst();
      expect(() => assertConfigWriteAllowedInCurrentMode({ configPath, env: {} })).toThrow(
        "second owner",
      );

      restoreSecond();
      expect(() => assertConfigWriteAllowedInCurrentMode({ configPath, env: {} })).not.toThrow();
    } finally {
      restoreFirst();
      restoreSecond();
    }
  });

  it("treats an omitted path as the canonical config path", () => {
    const env = { OPENCLAW_CONFIG_PATH: "/tmp/canonical/openclaw.json" };
    const restore = blockConfigWritesForRuntime({
      configPath: env.OPENCLAW_CONFIG_PATH,
      reason: "canonical owner",
    });

    try {
      expect(() => assertConfigWriteAllowedInCurrentMode({ env })).toThrow("canonical owner");
    } finally {
      restore();
    }
  });

  it("does not block an unrelated config path", () => {
    const restore = blockConfigWritesForRuntime({
      configPath: "/tmp/layered/openclaw.json",
      reason: "layered owner",
    });

    try {
      expect(() =>
        assertConfigWriteAllowedInCurrentMode({
          configPath: "/tmp/ordinary/openclaw.json",
          env: {},
        }),
      ).not.toThrow();
    } finally {
      restore();
    }
  });
});
