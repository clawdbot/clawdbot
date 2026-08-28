import { describe, expect, it } from "vitest";
import { resolveReplyHookTrigger, resolveReplyRunFireReason } from "./run-provenance.js";

describe("resolveReplyRunFireReason", () => {
  it("classifies continuation work wakes as timer-fired runs", () => {
    expect(
      resolveReplyRunFireReason({
        opts: { isHeartbeat: true, continuationTrigger: "work-wake" },
      }),
    ).toBe("timer");
  });

  it("classifies delegate-return wakes and delegate-draining turns as continuation chains", () => {
    expect(
      resolveReplyRunFireReason({
        opts: { isHeartbeat: true, continuationTrigger: "delegate-return" },
      }),
    ).toBe("continuation-chain");
    expect(resolveReplyRunFireReason({ drainsContinuationDelegateQueue: true })).toBe(
      "continuation-chain",
    );
  });

  it("classifies ordinary subagent-return turns as continuation chains", () => {
    // reclassifies an ordinary subagent completion as `subagent-return`
    // (not a mid-chain `delegate-return`) so the chain-budget reset gate fires,
    // but the run fire-reason stays `continuation-chain`: it is still an
    // internal delegate-driven turn, not an external user trigger.
    expect(
      resolveReplyRunFireReason({
        opts: { isHeartbeat: true, continuationTrigger: "subagent-return" },
      }),
    ).toBe("continuation-chain");
  });

  it("classifies ordinary inbound turns as external triggers", () => {
    expect(resolveReplyRunFireReason({})).toBe("external-trigger");
  });
});

describe("resolveReplyHookTrigger", () => {
  it("reports same-session continuation wakes as heartbeat triggers without requiring isHeartbeat", () => {
    expect(resolveReplyHookTrigger({ continuationTrigger: "work-wake" })).toBe("heartbeat");
    expect(resolveReplyHookTrigger({ continuationTrigger: "delegate-return" })).toBe("heartbeat");
    // Ordinary subagent returns are system-injected wakes too, so they stay
    // heartbeat-class for hooks/model overrides even though excludes them
    // from the mid-chain reset-gate wake set.
    expect(resolveReplyHookTrigger({ continuationTrigger: "subagent-return" })).toBe("heartbeat");
  });

  it("keeps ordinary turns as user triggers", () => {
    expect(resolveReplyHookTrigger({})).toBe("user");
  });
});
