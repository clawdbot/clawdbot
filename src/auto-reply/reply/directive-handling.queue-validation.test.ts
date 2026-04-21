import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { maybeHandleQueueDirective } from "./directive-handling.queue-validation.js";

describe("maybeHandleQueueDirective", () => {
  it("reports invalid queue options and current queue settings", () => {
    const invalid = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue collect debounce:bogus cap:zero drop:maybe"),
      cfg: {} as OpenClawConfig,
      channel: "quietchat",
    });
    expect(invalid?.text).toContain("Invalid debounce");
    expect(invalid?.text).toContain("Invalid cap");
    expect(invalid?.text).toContain("Invalid drop policy");

    const current = maybeHandleQueueDirective({
      directives: parseInlineDirectives("/queue"),
      cfg: {
        messages: {
          queue: {
            mode: "collect",
            debounceMs: 1500,
            cap: 9,
            drop: "summarize",
          },
        },
      } as OpenClawConfig,
      channel: "quietchat",
    });
    expect(current?.text).toContain(
      "Current queue settings: mode=collect, debounce=1500ms, cap=9, drop=summarize.",
    );
    expect(current?.text).toContain(
      "Options: modes steer, followup, collect, steer+backlog, interrupt; debounce:<ms|s|m>, cap:<n>, drop:old|new|summarize.",
    );
  });
});
