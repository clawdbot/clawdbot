/** Tests Code Mode restart-safe replay. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "./code-mode.test-support.js";

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

    const first = resultDetails(
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
    expect(first.status).toBe("waiting");
    expect(first.replaySafe).toBe(true);

    const second = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-replay-safety",
        { runId: first.runId },
      ),
    );
    expect(second.status).toBe("waiting");
    expect(second.replaySafe).toBe(true);

    const completed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-replay-safety-complete",
        {
          runId: second.runId,
        },
      ),
    );
    expect(completed.status).toBe("completed");
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

    const first = resultDetails(
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
    expect(first.status).toBe("waiting");
    expect(first.replaySafe).toBe(true);

    const failed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-unsafe-restart",
        { runId: first.runId },
      ),
    );
    expect(failed.status).toBe("failed");
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
        const reads = await tools.search("fake_safe_read");
        await tools.call(reads[0].id, {});
        const writes = await tools.search("fake_unsafe_write");
        return await tools.call(writes[0].id, {});
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

    const first = resultDetails(
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
    expect(first.status).toBe("waiting");
    expect(first.replaySafe).toBe(true);

    const failed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-forced-restart",
        { runId: first.runId },
      ),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("not proven replay-safe");
    expect(targetTool.execute).not.toHaveBeenCalled();
  });
});
