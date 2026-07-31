/** Tests Code Mode restart-safe replay. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tools.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  resetCodeModeTestState,
  fakeTool,
  pluginTool,
  pluginToolWithExecute,
  mcpTool,
  resultDetails,
  createCodeModeHarness,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";

describe("Code Mode restart-safe replay", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("keeps restart-safe mode across audited core reads", async () => {
    const targetTool = fakeTool("read", "Read");
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const completed = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-replay-safety",
        {
          restartSafe: true,
          code: `
          const matches = await tools.search(${JSON.stringify(targetTool.name)});
          return await tools.call(matches[0].id, {});
        `,
        },
      ),
    );
    expect(completed.status).toBe("completed");
    expect(completed.replaySafe).toBe(true);
  });

  it("allows explicitly replay-safe plugin tools by exact catalog id", async () => {
    const targetTool = pluginTool("fake_plugin_read", "Plugin read");
    setPluginToolMeta(targetTool, {
      pluginId: "fake-code-mode",
      optional: true,
      replaySafe: true,
    });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const completed = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      restartSafe: true,
      code: `
        const matches = await tools.search("fake_plugin_read");
        return await tools.call(matches[0].id, {});
      `,
    });

    expect(completed.status).toBe("completed");
    expect(completed.replaySafe).toBe(true);
    expect(completed.sideEffectFree).toBe(false);
    expect(targetTool.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects MCP tools even when their metadata claims replay safety", async () => {
    const readTool = fakeTool("read", "Read");
    const targetTool = mcpTool({
      name: "mcp_github_read_file",
      serverName: "github",
      toolName: "read_file",
    });
    setPluginToolMeta(targetTool, {
      pluginId: "bundle-mcp",
      optional: false,
      replaySafe: true,
      mcp: {
        serverName: "github",
        safeServerName: "github",
        toolName: "read_file",
        operation: "tool",
      },
    });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, readTool, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const completed = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      restartSafe: true,
      code: `
        await tools.read({ path: "facts.txt" });
        return await MCP.github.readFile({ path: "README.md" });
      `,
    });

    expect(completed.status).toBe("failed");
    expect(completed.replaySafe).toBe(true);
    expect(completed.sideEffectFree).toBe(true);
    expect(completed.bridgeDispatchStarted).toBe(true);
    expect(completed.error).toContain("cannot call namespace tools");
    expect(readTool.execute).toHaveBeenCalledTimes(1);
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("rejects side-effecting calls before executing them in restart-safe mode", async () => {
    const targetTool = pluginTool("fake_write", "Write");
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const failed = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-unsafe-restart",
        {
          restartSafe: true,
          code: `
          const matches = await tools.search("fake_write");
          return await tools.call(matches[0].id, {});
        `,
        },
      ),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("cannot call side-effecting tools");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("preserves bridge evidence when a later restart-safe call is rejected", async () => {
    const readTool = fakeTool("read", "Read");
    const writeTool = pluginTool("fake_unsafe_write", "Write");
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, readTool, writeTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const failed = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      restartSafe: true,
      code: `
        await tools.read({ path: "facts.txt" });
        const writes = await tools.search("fake_unsafe_write");
        return await tools.call(writes[0].id, {});
      `,
    });

    expect(failed).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
      replaySafe: true,
      sideEffectFree: true,
    });
    expect(failed.error).toContain("cannot call side-effecting tools");
    expect(readTool.execute).toHaveBeenCalledTimes(1);
    expect(writeTool.execute).not.toHaveBeenCalled();
  });

  it("keeps host-forced restart safety when the model clears the exec flag", async () => {
    const targetTool = pluginTool("fake_forced_write", "Write");
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      forceRestartSafeTools: true,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const failed = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-forced-restart",
        {
          restartSafe: false,
          code: `
          const matches = await tools.search("fake_forced_write");
          return await tools.call(matches[0].id, {});
        `,
        },
      ),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("cannot call side-effecting tools");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("preserves restart safety when a replay-safe call is parked", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 100,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      forceRestartSafeTools: true,
    };
    const codeModeTools = createCodeModeTools(ctx);
    const slowRead = pluginToolWithExecute(
      "fake_slow_read",
      "Slow read",
      async () => await new Promise<never>(() => {}),
    );
    setPluginToolMeta(slowRead, {
      pluginId: "fake-code-mode",
      optional: true,
      replaySafe: true,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, slowRead],
      config,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
      catalogRef,
    });

    const parked = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-restart-safe-park",
        {
          code: `
            const matches = await tools.search("fake_slow_read");
            return await tools.call(matches[0].id, {});
          `,
        },
      ),
    );

    expect(parked).toMatchObject({
      status: "waiting",
      replaySafe: true,
    });
    const stillWaiting = resultDetails(
      await expectDefined(codeModeTools[1], "Code Mode wait test invariant").execute(
        "code-wait-restart-safe-park",
        { runId: parked.runId },
      ),
    );
    expect(stillWaiting).toMatchObject({
      status: "waiting",
      replaySafe: true,
    });
  });

  it("keeps host-forced read-only mode across audited core reads", async () => {
    const targetTool = fakeTool("read", "Read");
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      forceReadOnlyTools: true,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    expect(codeModeTools).toHaveLength(2);
    const completed = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-forced-read-only",
        {
          restartSafe: false,
          code: `
          const matches = await tools.search("read");
          return await tools.call(matches[0].id, { path: "facts.txt" });
        `,
        },
      ),
    );

    expect(completed.status).toBe("completed");
    expect(completed.replaySafe).toBe(true);
    expect(completed.sideEffectFree).toBe(true);
    expect(targetTool.execute).toHaveBeenCalledTimes(1);
  });

  it("blocks replay-safe plugin tools during host-forced read-only verification", async () => {
    const targetTool = pluginTool("fake_plugin_read", "Plugin read");
    setPluginToolMeta(targetTool, {
      pluginId: "fake-code-mode",
      optional: true,
      replaySafe: true,
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      forceReadOnlyTools: true,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const failed = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-forced-read-only-plugin",
        {
          restartSafe: false,
          code: `
          const matches = await tools.search("fake_plugin_read");
          return await tools.call(matches[0].id, {});
        `,
        },
      ),
    );

    expect(failed).toMatchObject({
      status: "failed",
      replaySafe: true,
      sideEffectFree: true,
    });
    expect(failed.error).toContain("read-only code mode cannot call side-effecting tools");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("resumes a run parked under host-forced read-only verification", async () => {
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      forceReadOnlyTools: true,
    });
    applyCodeModeCatalog({
      tools: codeModeTools,
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const suspended = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-forced-read-only-yield",
        {
          code: 'await yield_control("verify"); return "verified";',
        },
      ),
    );

    expect(suspended.status).toBe("waiting");
    const completed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-forced-read-only-yield",
        { runId: suspended.runId },
      ),
    );
    expect(completed).toMatchObject({
      status: "completed",
      value: "verified",
      readOnly: true,
      replaySafe: true,
      sideEffectFree: true,
    });
  });

  it("does not resume an unrestricted parked run through a read-only wait", async () => {
    const { config, catalogRef, tools: normalTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: normalTools,
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const suspended = resultDetails(
      await expectDefined(normalTools[0], "normalTools[0] test invariant").execute(
        "code-call-unrestricted-yield",
        {
          code: 'await yield_control("pause"); return "done";',
        },
      ),
    );
    expect(suspended.status).toBe("waiting");

    const { tools: readOnlyTools } = createCodeModeHarness({
      forceReadOnlyTools: true,
    });
    await expect(
      expectDefined(readOnlyTools[1], "readOnlyTools[1] test invariant").execute(
        "code-wait-forced-read-only-unrestricted",
        { runId: suspended.runId },
      ),
    ).rejects.toThrow("was not created under the read-only policy");
  });
});
