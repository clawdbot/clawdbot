import { describe, expect, it } from "vitest";
import {
  DEFAULT_SILENT_REPLY_POLICY,
  DEFAULT_SILENT_REPLY_REWRITE,
  classifySilentReplyConversationType,
  resolveSilentReplyPolicyFromPolicies,
  resolveSilentReplyRewriteFromPolicies,
  resolveSilentReplyRewriteText,
} from "./silent-reply-policy.js";

describe("classifySilentReplyConversationType", () => {
  it("prefers an explicit conversation type", () => {
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:group:123",
        conversationType: "internal",
      }),
    ).toBe("internal");
  });

  it("classifies direct and group session keys", () => {
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:telegram:direct:123",
      }),
    ).toBe("direct");
    expect(
      classifySilentReplyConversationType({
        sessionKey: "agent:main:discord:group:123",
      }),
    ).toBe("group");
  });

  it("treats webchat as direct by default and unknown surfaces as internal", () => {
    expect(classifySilentReplyConversationType({ surface: "webchat" })).toBe("direct");
    expect(classifySilentReplyConversationType({ surface: "subagent" })).toBe("internal");
  });
});

describe("resolveSilentReplyPolicyFromPolicies", () => {
  it("uses defaults when no overrides exist", () => {
    expect(resolveSilentReplyPolicyFromPolicies({ conversationType: "direct" })).toBe(
      DEFAULT_SILENT_REPLY_POLICY.direct,
    );
    expect(resolveSilentReplyPolicyFromPolicies({ conversationType: "group" })).toBe(
      DEFAULT_SILENT_REPLY_POLICY.group,
    );
  });

  it("prefers surface policy over defaults", () => {
    expect(
      resolveSilentReplyPolicyFromPolicies({
        conversationType: "direct",
        defaultPolicy: { direct: "disallow" },
        surfacePolicy: { direct: "allow" },
      }),
    ).toBe("allow");
  });
});

describe("resolveSilentReplyRewriteFromPolicies", () => {
  it("uses default rewrite flags when no overrides exist", () => {
    expect(resolveSilentReplyRewriteFromPolicies({ conversationType: "direct" })).toBe(
      DEFAULT_SILENT_REPLY_REWRITE.direct,
    );
    expect(resolveSilentReplyRewriteFromPolicies({ conversationType: "group" })).toBe(
      DEFAULT_SILENT_REPLY_REWRITE.group,
    );
  });

  it("prefers surface rewrite flags over defaults", () => {
    expect(
      resolveSilentReplyRewriteFromPolicies({
        conversationType: "direct",
        defaultRewrite: { direct: true },
        surfaceRewrite: { direct: false },
      }),
    ).toBe(false);
  });
});

describe("resolveSilentReplyRewriteText", () => {
  it("picks a deterministic rewrite for a given seed", () => {
    const first = resolveSilentReplyRewriteText({ seed: "main:NO_REPLY" });
    const second = resolveSilentReplyRewriteText({ seed: "main:NO_REPLY" });
    expect(first).toBe(second);
    expect(first).not.toBe("NO_REPLY");
    expect(first.length).toBeGreaterThan(0);
  });
});
