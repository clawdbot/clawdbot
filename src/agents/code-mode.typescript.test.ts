/** Tests Code Mode TypeScript execution. */

import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { observeWorkerActivity } from "../../test/helpers/worker-activity.js";
import * as workerUrls from "../infra/runtime-worker-url.js";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  resultDetails,
  createCodeModeHarness,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog, registerHeadlessToolSearchCatalog } from "./tool-search.js";

async function observeTypeScriptPreparation(source: string) {
  const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
  const dir = tempDirs.make("code-mode-typescript-load-");
  const channelName = `typescript-load-${crypto.randomUUID()}`;
  const loading = observeWorkerActivity(channelName);
  await writeFile(
    path.join(dir, "observed-typescript.mjs"),
    `import { BroadcastChannel, threadId } from "node:worker_threads";
     new BroadcastChannel(${JSON.stringify(channelName)}).postMessage(threadId);
     ${source}`,
  );
  const workerPath = path.join(dir, "observed-worker.ts");
  await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  // Observe the real worker's lazy import; parent-isolate mocks cannot prove this boundary.
  await writeFile(
    workerPath,
    `import { registerHooks } from "node:module";
     registerHooks({ resolve(specifier, context, nextResolve) {
       return specifier === "typescript"
         ? { url: new URL("./observed-typescript.mjs", import.meta.url).href, shortCircuit: true }
         : nextResolve(specifier, context);
     }});
     await import(${JSON.stringify(new URL("./code-mode.worker.ts", import.meta.url).href)});`,
  );
  const resolveWorker = vi
    .spyOn(workerUrls, "resolveRuntimeWorkerUrl")
    .mockReturnValue(pathToFileURL(workerPath));
  onTestFinished(() => resolveWorker.mockRestore());
  return { loading };
}

describe("Code Mode TypeScript execution", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it.each(
    (["exec", "headless"] as const).flatMap((mode) =>
      (["aborted", "timeout"] as const).map((outcome) => ({ mode, outcome })),
    ),
  )(
    "stops $mode source preparation on $outcome before any tool dispatch",
    async ({ mode, outcome }) => {
      const { loading } = await observeTypeScriptPreparation("await new Promise(() => {});");
      const h = createCodeModeHarness();
      const tool = pluginTool("fake_noop", "Noop");
      onTestFinished(() => clearToolSearchCatalog(h.ctx));
      (h.config as { tools: { codeMode: unknown } }).tools.codeMode = {
        enabled: true,
        timeoutMs: 1_000,
      };
      // Controls capture limits once; construct them after applying this execution's budget.
      const codeModeTools = createCodeModeTools(h.ctx);
      if (mode === "headless") {
        registerHeadlessToolSearchCatalog({ catalogRef: h.catalogRef, tools: [tool] });
      } else {
        applyCodeModeCatalog({ ...h.ctx, tools: [...codeModeTools, tool] });
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const controller = new AbortController();
      const code = "await fake_noop({}); return 42;";
      const execution =
        mode === "headless"
          ? runCodeModeScriptHeadless({
              ctx: h.ctx,
              code,
              language: "typescript",
              wallClockMs: 1_000,
              signal: controller.signal,
            })
          : expectDefined(codeModeTools[0], "Code Mode exec test invariant")
              .execute("typescript-load", { code, language: "typescript" }, controller.signal)
              .then(resultDetails);
      onTestFinished(async () => {
        controller.abort();
        await execution;
      });
      const worker = await Promise.race([
        loading,
        execution.then((result) => {
          throw new Error(`Code Mode settled before source preparation: ${JSON.stringify(result)}`);
        }),
      ]);
      if (outcome === "aborted") {
        controller.abort();
      } else {
        await vi.advanceTimersByTimeAsync(3_000);
      }
      expect(await execution).toMatchObject({ status: "failed", code: outcome, output: [] });
      expect(tool.execute).not.toHaveBeenCalled();
      expect(worker.threadId).toBe(-1);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it.each([
    {
      name: "short guest",
      code: "const value: number = 42; return value;",
      expected: { status: "completed", value: 42 },
    },
    {
      name: "CPU-bound guest",
      code: "while (true) {}",
      expected: { status: "failed", code: "timeout" },
    },
  ])(
    "keeps headless preparation outside the guest budget for a $name",
    async ({ code, expected }) => {
      const typescriptUrl = pathToFileURL(createRequire(import.meta.url).resolve("typescript"));
      const { loading } = await observeTypeScriptPreparation(`
      export * from ${JSON.stringify(typescriptUrl.href)};
      const now = performance.now.bind(performance);
      Object.defineProperty(performance, "now", { value: () => now() + 2_000 });
    `);
      const h = createCodeModeHarness();
      registerHeadlessToolSearchCatalog({ catalogRef: h.catalogRef, tools: [] });
      onTestFinished(() => clearToolSearchCatalog(h.ctx));
      const controller = new AbortController();
      const execution = runCodeModeScriptHeadless({
        ctx: h.ctx,
        code,
        language: "typescript",
        overrides: { timeoutMs: 100 },
        wallClockMs: 10_000,
        signal: controller.signal,
      });
      onTestFinished(async () => {
        controller.abort();
        await execution;
      });
      const [, result] = await Promise.all([loading, execution]);
      expect(result).toMatchObject({ ...expected, toolCallCount: 0 });
    },
    15_000,
  );
});
