// Qa E2E tests cover qa e2e script behavior.
import { describe, expect, it } from "vitest";
import { enablePrivateQaScriptEnv, resolveQaE2eOutputPath } from "../../scripts/qa-e2e.js";

describe("qa-e2e script", () => {
  it("enables private QA plugin SDK subpaths before loading QA Lab", () => {
    const env: NodeJS.ProcessEnv = {};

    enablePrivateQaScriptEnv(env);

    expect(env.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(env.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS).toBe("0");
  });

  it("overrides inherited environment that would break the private QA self-check", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_BUILD_PRIVATE_QA: "0",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "0",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };

    enablePrivateQaScriptEnv(env);

    expect(env.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(env.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS).toBe("0");
  });

  it("resolves the default self-check report path", () => {
    expect(resolveQaE2eOutputPath([])).toBe(".artifacts/qa-e2e/self-check.md");
    expect(resolveQaE2eOutputPath([".artifacts/custom.md"])).toBe(".artifacts/custom.md");
  });
});
