import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import {
  buildSilentFallbackFailurePayload,
  resolveAdmittedRunSessionFile,
  resolveReplyRunDeliveryContext,
} from "./agent-runner-core.js";

describe("resolveAdmittedRunSessionFile", () => {
  it("uses the scoped session key when one is available", () => {
    expect(
      resolveAdmittedRunSessionFile({
        agentId: "main",
        sessionId: "session",
        sessionFile: "legacy-target",
        sessionKey: " agent:main:session ",
        storePath: "/tmp/sessions.json",
      }),
    ).toBe("agent:main:session");
  });

  it("preserves the admitted fallback when a persisted run has no session key", () => {
    expect(
      resolveAdmittedRunSessionFile({
        agentId: "main",
        sessionId: "session",
        sessionFile: "legacy-target",
        storePath: "/tmp/sessions.json",
      }),
    ).toBe("legacy-target");
  });
});

describe("resolveReplyRunDeliveryContext", () => {
  it.each([
    { name: "numeric message topic", messageThreadId: 99, threadId: 99 },
    { name: "numeric transport topic", transportThreadId: 99, threadId: 99 },
    { name: "message topic precedence", messageThreadId: 99, transportThreadId: 77, threadId: 99 },
    { name: "string message topic", messageThreadId: "99", threadId: "99" },
    { name: "session identity fallback", threadId: "12345:99" },
  ])("preserves the $name", ({ messageThreadId, transportThreadId, threadId }) => {
    expect(
      resolveReplyRunDeliveryContext({
        cfg: {},
        sessionCtx: {
          Provider: "telegram",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:12345",
          AccountId: "work",
          MessageThreadId: messageThreadId,
          TransportThreadId: transportThreadId,
          SessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
        } as TemplateContext,
        sessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
      }),
    ).toEqual({
      channel: "telegram",
      to: "telegram:12345",
      accountId: "work",
      threadId,
    });
  });
});

describe("buildSilentFallbackFailurePayload", () => {
  const transition = {
    fallbackActive: true,
    selectedModelRef: "openrouter/z-ai/glm-5.3",
    activeModelRef: "amazon-bedrock/claude-haiku",
  } as Parameters<typeof buildSilentFallbackFailurePayload>[0]["fallbackTransition"];

  const base = {
    fallbackTransition: transition,
    fallbackFailureKnown: true,
    isHeartbeat: false,
    hasSuccessfulTerminalDelivery: false,
  };

  it("keeps couldn't-reach wording for transport-class attempts", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      fallbackAttempts: [{ reason: "timeout" }, { reason: "server_error" }],
    });
    expect(payload?.text).toContain("couldn't reach the configured model backend");
    expect(payload?.text).toContain(transition.selectedModelRef);
    expect(payload?.text).toContain(transition.activeModelRef);
  });

  it("uses responded wording when every attempt is format/4xx", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      fallbackAttempts: [{ reason: "format" }, { reason: "format" }],
    });
    expect(payload?.text).toContain("responded but produced no usable reply");
    expect(payload?.text).not.toContain("couldn't reach");
  });

  it("uses neutral wording when attempts are empty", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      fallbackAttempts: [],
    });
    expect(payload?.text).toContain("produced no usable reply");
    expect(payload?.text).not.toContain("responded");
    expect(payload?.text).not.toContain("couldn't reach");
  });

  it("uses neutral wording for unknown reasons", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      fallbackAttempts: [{ reason: "unknown" }],
    });
    expect(payload?.text).toContain("produced no usable reply");
    expect(payload?.text).not.toContain("responded");
    expect(payload?.text).not.toContain("couldn't reach");
  });

  it("uses neutral wording for mixed transport and format attempts", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      fallbackAttempts: [{ reason: "timeout" }, { reason: "format" }],
    });
    expect(payload?.text).toContain("produced no usable reply");
    expect(payload?.text).not.toContain("responded");
    expect(payload?.text).not.toContain("couldn't reach");
  });

  it("uses neutral wording for local auth cooldown skips without provider status", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      fallbackAttempts: [{ reason: "auth" }],
    });
    expect(payload?.text).toContain("produced no usable reply");
    expect(payload?.text).not.toContain("responded");
    expect(payload?.text).not.toContain("couldn't reach");
  });

  it("uses responded wording for real auth failures that carry provider status", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      fallbackAttempts: [{ reason: "auth", status: 401 }],
    });
    expect(payload?.text).toContain("responded but produced no usable reply");
    expect(payload?.text).not.toContain("couldn't reach");
  });

  it("uses neutral wording when a skipped primary leaves an empty fallback path", () => {
    const payload = buildSilentFallbackFailurePayload({
      ...base,
      fallbackAttempts: [{ reason: "auth" }, { reason: "rate_limit" }],
    });
    expect(payload?.text).toContain("produced no usable reply");
    expect(payload?.text).not.toContain("responded");
    expect(payload?.text).not.toContain("couldn't reach");
  });
});
