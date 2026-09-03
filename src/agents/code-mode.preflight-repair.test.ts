import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecTool } from "./bash-tools.exec-run.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { jsonResult, ToolInputError, type AnyAgentTool } from "./tools/common.js";

async function runCode(code: string, targets: AnyAgentTool[]) {
  const { config, catalogRef, tools } = createCodeModeHarness();
  applyCodeModeCatalog({
    tools: [...tools, ...targets],
    config,
    sessionId: "session-code-mode",
    sessionKey: "agent:main:main",
    runId: "run-code-mode",
    catalogRef,
  });
  return resultDetails(
    await expectDefined(tools[0], "Code Mode exec test invariant").execute(
      "code-call-preflight-repair",
      { code },
    ),
  );
}

describe("Code Mode preflight repair", () => {
  afterEach(() => resetCodeModeTestState());

  it("rejects stale exec timeout input before starting the command", async () => {
    const exec = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const execute = vi.spyOn(exec, "execute");

    const details = await runCode('await exec({ command: "printf ok", timeout: 5 });', [exec]);

    expect(execute).not.toHaveBeenCalled();
    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
    expect(details.error).toContain("timeout");
  });

  it("keeps mixed bridge settlements non-retryable", async () => {
    const completed = pluginToolWithExecute("fake_completed", "Complete", async () =>
      jsonResult({ ok: true }),
    );
    const preflight = pluginToolWithExecute("fake_preflight", "Reject input", async () =>
      jsonResult({ unexpected: true }),
    );
    preflight.prepareBeforeToolCallParams = () => {
      throw new ToolInputError("input needs repair");
    };

    const details = await runCode("await Promise.all([fake_completed({}), fake_preflight({})]);", [
      completed,
      preflight,
    ]);

    expect(completed.execute).toHaveBeenCalledOnce();
    expect(preflight.execute).not.toHaveBeenCalled();
    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
  });

  it.each([
    {
      label: "guest failure after a successful call",
      execute: async () => jsonResult({ ok: true }),
      code: 'await fake_post_dispatch({}); throw new Error("after dispatch");',
    },
    {
      label: "ToolInputError after implementation start",
      execute: async () => {
        throw new ToolInputError("implementation already started");
      },
      code: "await fake_post_dispatch({});",
    },
  ])("keeps $label non-retryable", async ({ execute, code }) => {
    const target = pluginToolWithExecute("fake_post_dispatch", "Post-dispatch failure", execute);

    const details = await runCode(code, [target]);

    expect(target.execute).toHaveBeenCalledOnce();
    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
  });
});
