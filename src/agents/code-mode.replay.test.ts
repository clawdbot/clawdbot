/** Tests Code Mode restart-safe replay. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  resetCodeModeTestState,
  fakeTool,
  pluginTool,
  mcpTool,
  resultDetails,
  createCodeModeHarness,
  runUntilCompleted,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import type { AnyAgentTool } from "./tools/common.js";

describe("Code Mode restart-safe replay", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("completes audited core reads inline in restart-safe mode", async () => {
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

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-replay-safety",
        {
          restartSafe: true,
          code: `
          const [read] = await catalog.search(${JSON.stringify(targetTool.name)});
          return await read({});
        `,
        },
      ),
    );
    expect(first.status).toBe("completed");
    expect(first.replaySafe).toBe(true);
    expect(targetTool.execute).toHaveBeenCalledOnce();
  });

  it("keeps restart safety when an audited read outlives the inline deadline", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const targetTool = fakeTool("read", "Read");
    const execute = targetTool.execute;
    targetTool.execute = vi.fn(async (...args: Parameters<AnyAgentTool["execute"]>) => {
      started.resolve();
      await release.promise;
      return await execute(...args);
    }) as AnyAgentTool["execute"];
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, targetTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const running = expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
      "code-call-slow-replay-safety",
      { restartSafe: true, code: 'return await read({ value: "slow" });' },
    );
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      const waiting = resultDetails(await running);
      expect(waiting).toMatchObject({ status: "waiting", replaySafe: true });

      vi.useRealTimers();
      release.resolve();
      const completed = await waitUntilCompleted({
        details: waiting,
        waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      });
      expect(completed).toMatchObject({ status: "completed", replaySafe: true });
      expect(targetTool.execute).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      release.resolve();
      await running;
    }
  });

  it("allows explicitly replay-safe plugin tools through callable search", async () => {
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
        const [read] = await catalog.search("fake_plugin_read");
        return await read({});
      `,
    });

    expect(completed.status).toBe("completed");
    expect(completed.replaySafe).toBe(true);
    expect(targetTool.execute).toHaveBeenCalledTimes(1);
  });

  it("resolves a replay-safe tool through its reserved-name catalog handle", async () => {
    const targetTool = pluginTool("catalog", "Reserved-name plugin read");
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
        const [read] = await catalog.search("catalog");
        return await read({});
      `,
    });

    expect(completed.status).toBe("completed");
    expect(completed.replaySafe).toBe(true);
    expect(targetTool.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects MCP tools even when their metadata claims replay safety", async () => {
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
      code: 'return await MCP.github.readFile({ path: "README.md" });',
    });

    expect(completed.status).toBe("failed");
    expect(completed.replaySafe).toBe(true);
    expect(completed.error).toContain("cannot call namespace tools");
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
          const [write] = await catalog.search("fake_write");
          return await write({});
        `,
        },
      ),
    );
    expect(failed.status).toBe("failed");
    expect(failed.replaySafe).toBe(true);
    expect(failed.error).toContain("not proven replay-safe");
    expect(failed.error).toContain("audited read, grep, or find tools");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });

  it("preserves bridge evidence when a later restart-safe call is rejected", async () => {
    const readTool = pluginTool("fake_safe_read", "Read");
    setPluginToolMeta(readTool, {
      pluginId: "fake-code-mode",
      optional: true,
      replaySafe: true,
    });
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
        const [read] = await catalog.search("fake_safe_read");
        await read({});
        const [write] = await catalog.search("fake_unsafe_write");
        return await write({});
      `,
    });

    expect(failed).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
      replaySafe: true,
    });
    expect(failed.error).toContain("not proven replay-safe");
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
          const [write] = await catalog.search("fake_forced_write");
          return await write({});
        `,
        },
      ),
    );
    expect(failed.status).toBe("failed");
    expect(failed.replaySafe).toBe(true);
    expect(failed.error).toContain("not proven replay-safe");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });
});
