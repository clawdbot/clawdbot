import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { withEnv } from "../test-utils/env.js";
import {
  isFastTestRuntimeEnv,
  isTruthyEnvValue,
  logAcceptedEnvOption,
  normalizeEnv,
  normalizeZaiEnv,
} from "./env.js";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: loggerMocks.info,
  }),
}));

beforeEach(() => {
  loggerMocks.info.mockReset();
});

function waitForNextLog(): Promise<void> {
  const logged = createDeferred();
  loggerMocks.info.mockImplementationOnce(() => logged.resolve());
  return logged.promise;
}

describe("normalizeZaiEnv", () => {
  it("copies Z_AI_API_KEY to ZAI_API_KEY when missing", () => {
    withEnv({ ZAI_API_KEY: "", Z_AI_API_KEY: "zai-legacy" }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-legacy");
    });
  });

  it("does not override existing ZAI_API_KEY", () => {
    withEnv({ ZAI_API_KEY: "zai-current", Z_AI_API_KEY: "zai-legacy" }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-current");
    });
  });

  it("ignores blank legacy Z_AI_API_KEY values", () => {
    withEnv({ ZAI_API_KEY: "", Z_AI_API_KEY: "   " }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("");
    });
  });

  it("does not copy when legacy Z_AI_API_KEY is unset", () => {
    withEnv({ ZAI_API_KEY: "", Z_AI_API_KEY: undefined }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("");
    });
  });
});

describe("isTruthyEnvValue", () => {
  it("accepts common truthy values", () => {
    expect(isTruthyEnvValue("1")).toBe(true);
    expect(isTruthyEnvValue("true")).toBe(true);
    expect(isTruthyEnvValue(" yes ")).toBe(true);
    expect(isTruthyEnvValue("ON")).toBe(true);
  });

  it("rejects other values", () => {
    expect(isTruthyEnvValue("0")).toBe(false);
    expect(isTruthyEnvValue("false")).toBe(false);
    expect(isTruthyEnvValue("")).toBe(false);
    expect(isTruthyEnvValue(undefined)).toBe(false);
  });
});

describe("isFastTestRuntimeEnv", () => {
  it("ignores OPENCLAW_TEST_FAST outside a test runtime", () => {
    withEnv(
      {
        NODE_ENV: "production",
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
        OPENCLAW_TEST_FAST: "1",
      },
      () => {
        expect(isFastTestRuntimeEnv()).toBe(false);
      },
    );
  });

  it("honors OPENCLAW_TEST_FAST inside a detected test runtime", () => {
    expect(isFastTestRuntimeEnv({ VITEST: "1", OPENCLAW_TEST_FAST: "1" })).toBe(true);
  });
});

describe("logAcceptedEnvOption", () => {
  it("logs accepted env options once with redaction and formatting", async () => {
    const logged = waitForNextLog();

    withEnv(
      {
        VITEST: "",
        NODE_ENV: "development",
        OPENCLAW_TEST_ENV: "  line one\nline two  ",
      },
      () => {
        logAcceptedEnvOption({
          key: "OPENCLAW_TEST_ENV",
          description: "test option",
          redact: true,
        });
        logAcceptedEnvOption({
          key: "OPENCLAW_TEST_ENV",
          description: "test option",
          redact: true,
        });
      },
    );

    await withTestTimeout(logged, 1_000, "redacted accepted env option did not log");
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "env: OPENCLAW_TEST_ENV=<redacted> (test option)",
    );
  });

  it("skips blank values and test-mode logging", () => {
    withEnv(
      {
        VITEST: "1",
        NODE_ENV: "development",
        OPENCLAW_BLANK_ENV: "value",
      },
      () => {
        logAcceptedEnvOption({
          key: "OPENCLAW_BLANK_ENV",
          description: "skipped in vitest",
        });
      },
    );

    withEnv(
      {
        VITEST: "",
        NODE_ENV: "development",
        OPENCLAW_BLANK_ENV: "   ",
      },
      () => {
        logAcceptedEnvOption({
          key: "OPENCLAW_BLANK_ENV",
          description: "blank value",
        });
      },
    );

    expect(loggerMocks.info).not.toHaveBeenCalled();
  });

  it("keeps bounded non-secret values UTF-16 well-formed", async () => {
    const logged = waitForNextLog();
    withEnv(
      {
        VITEST: "",
        NODE_ENV: "development",
        OPENCLAW_UTF16_TEST_ENV: `${"x".repeat(159)}🚀tail`,
      },
      () => {
        logAcceptedEnvOption({
          key: "OPENCLAW_UTF16_TEST_ENV",
          description: "UTF-16 test",
        });
      },
    );

    await withTestTimeout(logged, 1_000, "UTF-16 accepted env option did not log");
    expect(loggerMocks.info).toHaveBeenCalledTimes(1);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      `env: OPENCLAW_UTF16_TEST_ENV=${"x".repeat(159)}… (UTF-16 test)`,
    );
  });
});

describe("normalizeEnv", () => {
  it("normalizes the legacy ZAI env alias", () => {
    withEnv({ ZAI_API_KEY: "", Z_AI_API_KEY: "zai-legacy" }, () => {
      normalizeEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-legacy");
    });
  });
});
