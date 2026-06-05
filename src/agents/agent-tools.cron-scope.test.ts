/**
 * Tests cron-triggered tool assembly.
 * Ensures cron runs scope cron tool behavior to self-removal of the current
 * job only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

const mocks = vi.hoisted(() => {
  const stubTool = (name: string) =>
    ({
      name,
      label: name,
      displaySummary: name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    }) satisfies AnyAgentTool;

  return {
    createOpenClawToolsOptions: vi.fn(),
    stubTool,
  };
});

vi.mock("./openclaw-tools.js", () => ({
  createOpenClawTools: (options: unknown) => {
    mocks.createOpenClawToolsOptions(options);
    return [mocks.stubTool("cron")];
  },
}));

import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

function firstOpenClawToolsOptions(): { cronSelfRemoveOnlyJobId?: string } | undefined {
  return mocks.createOpenClawToolsOptions.mock.calls[0]?.[0] as
    | { cronSelfRemoveOnlyJobId?: string }
    | undefined;
}

describe("createOpenClawCodingTools cron scope", () => {
  beforeEach(() => {
    mocks.createOpenClawToolsOptions.mockClear();
  });

  it("scopes cron-triggered jobs to self-removal", () => {
    const tools = createOpenClawCodingTools({
      trigger: "cron",
      jobId: "job-current",
    });

    expect(tools.map((tool) => tool.name)).toContain("cron");
    expect(firstOpenClawToolsOptions()?.cronSelfRemoveOnlyJobId).toBe("job-current");
  });

  it("does not scope non-cron sessions", () => {
    createOpenClawCodingTools({
      trigger: "user",
      jobId: "job-current",
    });

    expect(firstOpenClawToolsOptions()?.cronSelfRemoveOnlyJobId).toBeUndefined();
  });
});
