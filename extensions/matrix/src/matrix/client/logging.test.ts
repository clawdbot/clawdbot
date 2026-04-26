import { logger as matrixJsSdkRootLogger } from "matrix-js-sdk/lib/logger.js";
import { describe, expect, it, vi } from "vitest";
import { ensureMatrixSdkLoggingConfigured, setMatrixSdkLogMode } from "./logging.js";

type MatrixJsSdkTestLogger = typeof matrixJsSdkRootLogger & {
  getLevel?: () => number | string;
  levels: { WARN: number };
  methodFactory?: unknown;
  rebuild?: () => void;
  setLevel?: (level: number | string, persist?: boolean) => void;
};

describe("Matrix SDK logging", () => {
  it("restores the Matrix JS SDK global logger level after quiet mode", () => {
    const logger = matrixJsSdkRootLogger as MatrixJsSdkTestLogger;
    const originalLevel = logger.getLevel?.();
    const originalMethodFactory = logger.methodFactory;
    try {
      logger.setLevel?.("warn", false);
      ensureMatrixSdkLoggingConfigured();
      setMatrixSdkLogMode("quiet");
      setMatrixSdkLogMode("default");

      expect(logger.getLevel?.()).toBe(logger.levels.WARN);
      expect(logger.methodFactory).toBe(originalMethodFactory);
    } finally {
      if (typeof originalLevel === "string" || typeof originalLevel === "number") {
        logger.setLevel?.(originalLevel, false);
      }
      logger.methodFactory = originalMethodFactory;
      logger.rebuild?.();
      setMatrixSdkLogMode("default");
    }
  });

  it("quiets the Matrix JS SDK global logger for JSON-safe CLI commands", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      ensureMatrixSdkLoggingConfigured();
      setMatrixSdkLogMode("quiet");

      matrixJsSdkRootLogger.getChild("[MatrixRTCSession test]").debug("noisy diagnostic");

      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      setMatrixSdkLogMode("default");
      debugSpy.mockRestore();
    }
  });
});
