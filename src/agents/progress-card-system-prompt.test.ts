import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { appendIncognitoSystemPrompt } from "./incognito-system-prompt.js";
import { appendProgressCardSystemPrompt } from "./progress-card-system-prompt.js";

const { hasPairedCardRenderer } = vi.hoisted(() => ({
  hasPairedCardRenderer: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../infra/device-pairing.js", () => ({ hasPairedCardRenderer }));

const SENTENCE =
  "During multi-step work, keep your progress card current with the progress_card tool; the user follows it instead of reading the transcript.";

function append(params: {
  config?: Parameters<typeof appendProgressCardSystemPrompt>[0]["config"];
  extraSystemPrompt?: string;
  sessionKey?: string;
}) {
  return appendProgressCardSystemPrompt({
    agentId: "main",
    config: params.config,
    extraSystemPrompt: params.extraSystemPrompt,
    modelId: "gpt-5.6-sol",
    provider: "openai",
    sessionKey: params.sessionKey ?? "agent:main:work",
  });
}

describe("progress card system prompt", () => {
  beforeEach(() => {
    hasPairedCardRenderer.mockReset().mockResolvedValue(true);
  });

  it("injects the exact instruction when every adoption gate passes", async () => {
    await expect(append({})).resolves.toBe(SENTENCE);
  });

  it.each([
    { config: undefined, sessionKey: "main" },
    { config: { session: { scope: "global" as const } }, sessionKey: "global" },
  ])("suppresses the instruction for the agent main session $sessionKey", async (params) => {
    await expect(append(params)).resolves.toBeUndefined();
    expect(hasPairedCardRenderer).not.toHaveBeenCalled();
  });

  it("suppresses the instruction when no paired client can render the card", async () => {
    hasPairedCardRenderer.mockResolvedValue(false);

    await expect(append({})).resolves.toBeUndefined();
  });

  it("suppresses the instruction when the attempt uses the resolved utility model", async () => {
    await expect(
      append({
        config: { agents: { defaults: { utilityModel: "openai/gpt-5.6-sol" } } },
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves incognito-first composition order", async () => {
    const incognitoPrompt = appendIncognitoSystemPrompt({
      agentId: "main",
      extraSystemPrompt: "Existing context.",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });

    await expect(append({ extraSystemPrompt: incognitoPrompt })).resolves.toBe(
      "Existing context.\n\nThis chat is incognito; do not store its conversation content in memory files or long-term notes.\n\n" +
        SENTENCE,
    );
  });
});
