import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { buildStatusMessage } from "./status-message.js";

const buildFastStatus = (model: string, fastMode: boolean) =>
  normalizeTestText(
    buildStatusMessage({
      modelAuth: "api-key",
      activeModelAuth: "api-key",
      agent: { model },
      sessionEntry: {
        sessionId: "fast-status",
        updatedAt: 0,
        fastMode,
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    }),
  );

describe("buildStatusMessage fast mode labels", () => {
  it("shows fast mode when enabled", () => {
    expect(buildFastStatus("openai/gpt-5.4", true)).toContain("Fast");
  });

  it("hides fast mode when disabled", () => {
    expect(buildFastStatus("anthropic/claude-opus-4-6", false)).not.toContain("Fast");
  });
});
