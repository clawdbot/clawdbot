import { describe, expect, it } from "vitest";
import {
  attachMemoryFlushAppendBudget,
  copyAttachedMemoryFlushAppendBudget,
  getAttachedMemoryFlushAppendBudget,
} from "./memory-flush-budget.js";
import type { RunEmbeddedAgentParams } from "./params.js";

function createParams(): RunEmbeddedAgentParams {
  return {
    sessionId: "session-memory-flush-budget",
    workspaceDir: "/tmp/openclaw-memory-flush-budget",
    prompt: "flush memory",
    trigger: "memory",
    memoryFlushWritePath: "memory/2026-03-24.md",
  };
}

describe("memory flush append budget attachment", () => {
  it("ignores caller-supplied budget-looking object properties", () => {
    const params = {
      ...createParams(),
      memoryFlushAppendBudget: { acceptedChars: -10_000, acceptedLines: -10_000 },
    };

    expect(getAttachedMemoryFlushAppendBudget(params)).toBeUndefined();
  });

  it("returns only the host-attached budget for the same params object", () => {
    const params = createParams();
    const budget = { acceptedChars: 0, acceptedLines: 0 };

    attachMemoryFlushAppendBudget(params, budget);

    expect(getAttachedMemoryFlushAppendBudget(params)).toBe(budget);
  });

  it("copies the host-attached budget across the public runner params clone", () => {
    const params = createParams();
    const budget = { acceptedChars: 17, acceptedLines: 2 };
    const clonedParams = { ...params };
    attachMemoryFlushAppendBudget(params, budget);
    Object.assign(clonedParams, {
      memoryFlushAppendBudget: { acceptedChars: -10_000, acceptedLines: -10_000 },
    });

    copyAttachedMemoryFlushAppendBudget(params, clonedParams);

    expect(clonedParams).not.toBe(params);
    expect(getAttachedMemoryFlushAppendBudget(clonedParams)).toBe(budget);
  });
});
