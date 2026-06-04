/**
 * Tests agent directory compatibility helpers.
 */
import { describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "./agent-dir-compat.js";

describe("resolveOpenClawAgentDir", () => {
  it("keeps the shipped Pi env alias for deprecated plugin SDK callers", () => {
    expect(
      resolveOpenClawAgentDir({
        PI_CODING_AGENT_DIR: "/tmp/openclaw-legacy-agent",
      }),
    ).toBe("/tmp/openclaw-legacy-agent");
  });

  it("prefers the OpenClaw env override over the deprecated Pi alias", () => {
    expect(
      resolveOpenClawAgentDir({
        OPENCLAW_AGENT_DIR: "/tmp/openclaw-agent",
        PI_CODING_AGENT_DIR: "/tmp/openclaw-legacy-agent",
      }),
    ).toBe("/tmp/openclaw-agent");
  });
});
