// Verifies exec command highlighting resolution across global and agent-scoped config.
import { describe, expect, it } from "vitest";
import { resolveExecCommandHighlighting } from "./exec-command-highlighting.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("resolveExecCommandHighlighting", () => {
  it("defaults to false when no config is provided", () => {
    expect(resolveExecCommandHighlighting({})).toBe(false);
  });

  it("defaults to false when config is null", () => {
    expect(resolveExecCommandHighlighting({ config: null })).toBe(false);
  });

  it("reads global exec commandHighlighting", () => {
    const config = {
      tools: { exec: { commandHighlighting: true } },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config })).toBe(true);
  });

  it("returns false when global exec commandHighlighting is disabled", () => {
    const config = {
      tools: { exec: { commandHighlighting: false } },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config })).toBe(false);
  });

  it("agent-scoped true overrides global false", () => {
    const config = {
      agents: {
        list: [
          {
            id: "alpha",
            tools: { exec: { commandHighlighting: true } },
          },
        ],
      },
      tools: { exec: { commandHighlighting: false } },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(true);
  });

  it("agent-scoped false overrides global true", () => {
    const config = {
      agents: {
        list: [
          {
            id: "alpha",
            tools: { exec: { commandHighlighting: false } },
          },
        ],
      },
      tools: { exec: { commandHighlighting: true } },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(false);
  });

  it("agent without override falls back to global true", () => {
    const config = {
      agents: {
        list: [{ id: "alpha" }],
      },
      tools: { exec: { commandHighlighting: true } },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(true);
  });

  it("agent without override falls back to global false", () => {
    const config = {
      agents: {
        list: [{ id: "alpha" }],
      },
      tools: { exec: { commandHighlighting: false } },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(false);
  });

  it("agent with explicit true and no global returns true", () => {
    const config = {
      agents: {
        list: [
          {
            id: "alpha",
            tools: { exec: { commandHighlighting: true } },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(true);
  });

  it("agent with explicit false and no global falls back to false", () => {
    const config = {
      agents: {
        list: [
          {
            id: "alpha",
            tools: { exec: { commandHighlighting: false } },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(false);
  });

  it("falls back to global config when agent ID is not in the agent list", () => {
    const config = {
      tools: { exec: { commandHighlighting: true } },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config, agentId: "nonexistent" })).toBe(true);
  });

  it("agent ID normalization matches agent list entries", () => {
    // normalizeAgentId lowercases and trims the agent ID, so "ALPHA" should
    // match an entry with id "alpha".
    const config = {
      agents: {
        list: [
          {
            id: "alpha",
            tools: { exec: { commandHighlighting: true } },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config, agentId: "ALPHA" })).toBe(true);
  });

  it("unrelated agent ID does not affect the result", () => {
    const config = {
      agents: {
        list: [
          {
            id: "other",
            tools: { exec: { commandHighlighting: true } },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(resolveExecCommandHighlighting({ config, agentId: "alpha" })).toBe(false);
  });
});
