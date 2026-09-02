import type {
  AgentMessage,
  EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { buildTurnStartParams } from "./turn-params.js";

describe("Codex working context", () => {
  it("keeps snapshots out of user input and carries a stable native context revision", () => {
    const params = { prompt: "hello" } as EmbeddedRunAttemptParamsV2;
    const snapshot = (
      workContext: string | null,
      revision: string,
    ): Extract<AgentMessage, { role: "custom" }> => ({
      role: "custom",
      customType: "openclaw.work-context",
      display: false,
      content: workContext ?? "Work context cleared.",
      timestamp: 1,
      details: { workContext, revision },
    });
    const build = (workContextMessage?: Extract<AgentMessage, { role: "custom" }>) =>
      buildTurnStartParams(params, {
        threadId: "thread-1",
        cwd: "/workspace",
        appServer: resolveCodexAppServerRuntimeOptions({}),
        preserveNativeTurnSettings: true,
        workContextMessage,
      });
    const first = snapshot("Selected task", "revision-1");
    const initial = build(first);
    expect(initial.input).toEqual([{ type: "text", text: "hello", text_elements: [] }]);
    expect(initial.additionalContext?.openclaw_work_context).toEqual({
      kind: "untrusted",
      value: JSON.stringify({ revision: "revision-1", context: first.content }),
    });
    expect(build(first).additionalContext).toEqual(initial.additionalContext);
    const restored = build(snapshot("Selected task", "revision-2"));
    expect(restored.additionalContext).not.toEqual(initial.additionalContext);
    expect(build(snapshot(null, "revision-3")).additionalContext).toMatchObject({
      openclaw_work_context: { kind: "untrusted", value: expect.stringContaining("cleared") },
    });
    expect(build().additionalContext?.openclaw_work_context).toBeUndefined();
  });
});
