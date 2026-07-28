import { describe, expect, it, vi } from "vitest";
import {
  registerWorkboardOpportunityPrompt,
  WORKBOARD_OPPORTUNITY_PROMPT_SECTION,
} from "./opportunity-prompt.js";

describe("Workboard opportunity prompt", () => {
  it("registers Workboard-specific capture policy through the plugin hook", () => {
    const on = vi.fn();
    registerWorkboardOpportunityPrompt({ api: { on } as never });

    expect(on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    const handler = on.mock.calls[0]?.[1] as () => {
      prependSystemContext: string;
    };
    expect(handler()).toEqual({ prependSystemContext: WORKBOARD_OPPORTUNITY_PROMPT_SECTION });
    expect(WORKBOARD_OPPORTUNITY_PROMPT_SECTION).toContain("workboard_create");
    expect(WORKBOARD_OPPORTUNITY_PROMPT_SECTION).toContain("Opportunity idempotency key");
  });
});
