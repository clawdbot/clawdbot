/** Tests Code Mode TypeScript execution. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadCodeModeTypeScriptRuntime = vi.hoisted(() =>
  vi.fn<() => Promise<typeof import("typescript")>>(),
);

vi.mock("./code-mode-typescript-runtime.js", () => ({
  loadCodeModeTypeScriptRuntime,
}));
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  resultDetails,
  createCodeModeHarness,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { registerHeadlessToolSearchCatalog } from "./tool-search.js";

describe("Code Mode TypeScript execution", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    loadCodeModeTypeScriptRuntime.mockResolvedValue(await import("typescript"));
  });

  afterEach(() => {
    vi.useRealTimers();
    loadCodeModeTypeScriptRuntime.mockReset();
    resetCodeModeTestState();
  });

  it("supports TypeScript source transform", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      language: "typescript",
      code: `
        const value: number = 40 + 2;
        return { value };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({ value: 42 });

    const moduleShapedTypeScript = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      language: "typescript",
      code: "const value: number = 42; return `import('node:fs') ${value}`;",
    });

    expect(moduleShapedTypeScript.status).toBe("completed");
    expect(moduleShapedTypeScript.value).toBe("import('node:fs') 42");

    const moduleShapedTypeScriptRegex = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      language: "typescript",
      code: 'const value: number = 42; return /import.meta/.test("import.meta");',
    });

    expect(moduleShapedTypeScriptRegex.status).toBe("completed");
    expect(moduleShapedTypeScriptRegex.value).toBe(true);

    for (const moduleAccess of ["import('node:fs')", "require('node:fs')"]) {
      const unicodeModuleAccess = resultDetails(
        await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
          `code-call-typescript-unicode-${moduleAccess.startsWith("import") ? "import" : "require"}`,
          {
            language: "typescript",
            code: `const value: number = 1; const padding = "${"😀".repeat(96)}"; return ${moduleAccess};`,
          },
        ),
      );

      expect(unicodeModuleAccess.status).toBe("failed");
      expect(unicodeModuleAccess.code).toBe("invalid_input");
      expect(unicodeModuleAccess.error).toContain("module access is disabled");
    }

    const commandLikeTypeScript = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      language: "typescript",
      code: "node -1; var node: number = 7; return node;",
    });

    expect(commandLikeTypeScript.status).toBe("completed");
    expect(commandLikeTypeScript.value).toBe(7);

    const typedShell = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-typescript-shell-source",
        { code: "pwd", language: "typescript" },
      ),
    );

    expect(typedShell.status).toBe("failed");
    expect(typedShell.code).toBe("invalid_input");
    expect(typedShell.error).toMatch(/JavaScript or TypeScript, not shell commands/);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([-1, 1])(
    "keeps the headless budget when TypeScript preparation shifts the wall clock by %i",
    async (clockDirection) => {
      const typescriptRuntime = await import("typescript");
      const initialWallClockMs = Date.now();
      let wallClockJumpMs = 0;
      const wallClock = vi
        .spyOn(Date, "now")
        .mockImplementation(() => initialWallClockMs + wallClockJumpMs);
      try {
        loadCodeModeTypeScriptRuntime.mockImplementation(async () => {
          wallClockJumpMs = clockDirection * 60_000;
          return typescriptRuntime;
        });
        const { ctx, catalogRef } = createCodeModeHarness();
        registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });

        const result = await runCodeModeScriptHeadless({
          ctx,
          language: "typescript",
          code: "const value: number = 42; return value;",
          wallClockMs: 30_000,
        });

        expect(result).toMatchObject({ status: "completed", value: 42 });
        expect(loadCodeModeTypeScriptRuntime).toHaveBeenCalledOnce();
      } finally {
        wallClock.mockRestore();
      }
    },
  );

  it("times out an unfinished TypeScript runtime load without starting a worker", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    (config as { tools: { codeMode: unknown } }).tools.codeMode = {
      enabled: true,
      timeoutMs: 100,
    };
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    loadCodeModeTypeScriptRuntime.mockReturnValue(new Promise(() => {}));

    const result = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-typescript-load-timeout",
        { code: "return 42;", language: "typescript" },
      ),
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "timeout",
      error: "code mode timeout exceeded",
      failurePhase: "host",
      bridgeDispatchStarted: false,
      output: [],
    });
    expect(testing.activeRuns.size).toBe(0);
  });

  it("aborts an unfinished TypeScript runtime load without starting a worker", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    loadCodeModeTypeScriptRuntime.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const resultPromise = expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
      "code-call-typescript-load-abort",
      { code: "return 42;", language: "typescript" },
      controller.signal,
    );

    controller.abort();

    expect(resultDetails(await resultPromise)).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
      failurePhase: "host",
      bridgeDispatchStarted: false,
      output: [],
    });
    expect(testing.activeRuns.size).toBe(0);
  });
});
