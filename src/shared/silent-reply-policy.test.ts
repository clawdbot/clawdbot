import { describe, expect, it } from "vitest";
import {
  DEFAULT_SILENT_REPLY_POLICY,
  DEFAULT_SILENT_REPLY_REWRITE,
  classifySilentReplyConversationType,
  resolveSilentReplyPolicyFromPolicies,
  resolveSilentReplyRewriteFromPolicies,
  resolveSilentReplyRewriteText,
} from "./silent-reply-policy.js";

const defaultPolicyResolverCases = [
  {
    name: "resolveSilentReplyRewriteFromPolicies",
    resolve: resolveSilentReplyRewriteFromPolicies,
    defaults: DEFAULT_SILENT_REPLY_REWRITE,
  },
  {
    name: "resolveSilentReplyPolicyFromPolicies",
    resolve: resolveSilentReplyPolicyFromPolicies,
    defaults: DEFAULT_SILENT_REPLY_POLICY,
  },
];

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

describe("silent reply default policy resolution", () => {
  it.each(defaultPolicyResolverCases)(
    "$name uses defaults when no overrides exist",
    ({ defaults, resolve }) => {
      expect(resolve({ conversationType: "direct" })).toBe(defaults.direct);
      expect(resolve({ conversationType: "group" })).toBe(defaults.group);
    },
  );
});

describe("resolveSilentReplyRewriteFromPolicies", () => {
  it("prefers surface rewrite settings over defaults", () => {
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

describe("resolveSilentReplyPolicyFromPolicies", () => {
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
