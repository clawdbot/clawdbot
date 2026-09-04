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

  it("maps a configured default ACP alias to its external harness", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: {
          acp: { defaultAgent: "codex-acp" },
          agents: {
            list: [
              {
                id: "codex-acp",
                runtime: { type: "acp", acp: { agent: "codex", backend: "acpx" } },
              },
            ],
          },
        },
      }),
    ).toEqual({
      ok: true,
      agentId: "codex",
      configAgentId: "codex-acp",
      backendId: "acpx",
    });
  });

  it("preserves ownership for a configured default allowed ACP agent", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: {
          acp: { defaultAgent: "claude-code", allowedAgents: ["claude-code"] },
          agents: { list: [{ id: "claude-code" }] },
        },
      }),
    ).toEqual({
      ok: true,
      agentId: "claude-code",
      configAgentId: "claude-code",
    });
  });
});
