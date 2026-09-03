import { describe, expect, it } from "vitest";
import { resolveTargetAcpAgentId } from "./acp-spawn-target.js";

describe("resolveTargetAcpAgentId", () => {
  it.each(["", "   ", "агент✨", "---"])(
    "rejects explicit unrepresentable ACP agent id %j",
    (agentId) => {
      expect(
        resolveTargetAcpAgentId({
          requestedAgentId: agentId,
          cfg: { acp: { defaultAgent: "codex" } },
        }),
      ).toEqual({ ok: false, error: `agentId "${agentId}" was not found` });
    },
  );

  it("keeps omitted ACP agent ids on the configured default path", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: { acp: { defaultAgent: "codex" } },
      }),
    ).toEqual({ ok: true, agentId: "codex" });
  });
});
