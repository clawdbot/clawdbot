import { describe, expect, it } from "vitest";
import { buildExecRunConfig } from "./agent-exec.js";

describe("agent exec list-roster isolation", () => {
  it("pins the workspace and drops persistent state locations", () => {
    const config = buildExecRunConfig({
      base: {
        agents: {
          list: [
            {
              id: "ops",
              workspace: "/persistent/workspace",
              agentDir: "/persistent/agents/ops",
              runtime: { type: "acp", acp: { agent: "codex", cwd: "/persistent/repo" } },
            },
          ],
        },
      },
      cwd: "/run/here",
    });

    const [ops] = config.agents?.list ?? [];
    expect(ops).toMatchObject({ id: "ops", workspace: "/run/here" });
    expect(ops?.agentDir).toBeUndefined();
    expect(ops?.runtime?.type === "acp" ? ops.runtime.acp?.cwd : "unset").toBeUndefined();
    expect(ops?.runtime?.type === "acp" ? ops.runtime.acp?.agent : undefined).toBe("codex");
  });
});
