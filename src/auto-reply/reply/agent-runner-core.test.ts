import { describe, expect, it } from "vitest";
import { resolveFallbackTransition } from "../fallback-state.js";
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
  function buildPayload(reason: string) {
    const fallbackTransition = resolveFallbackTransition({
      selectedProvider: "primary",
      selectedModel: "model-a",
      activeProvider: "fallback",
      activeModel: "model-b",
      attempts: [
        {
          provider: "primary",
          model: "model-a",
          error: "upstream failure",
          reason: reason as never,
        },
      ],
      state: {},
    });
    return buildSilentFallbackFailurePayload({
      fallbackTransition,
      fallbackFailureKnown: true,
      isHeartbeat: false,
      hasSuccessfulTerminalDelivery: false,
    });
  }

  it.each([
    { reason: "rate_limit", expectContains: "is rate-limited (429)" },
    { reason: "auth", expectContains: "authentication for the configured model backend" },
    { reason: "auth_permanent", expectContains: "permanently rejected (403)" },
    { reason: "billing", expectContains: "billing (402)" },
    { reason: "model_not_found", expectContains: "was not found (404)" },
    { reason: "context_overflow", expectContains: "context overflow" },
    { reason: "format", expectContains: "rejected the request format (400)" },
    { reason: "session_expired", expectContains: "has expired (410)" },
    { reason: "empty_response", expectContains: "empty response" },
    { reason: "no_error_details", expectContains: "without error details" },
    { reason: "overloaded", expectContains: "couldn't reach" },
    { reason: "timeout", expectContains: "couldn't reach" },
    { reason: "server_error", expectContains: "couldn't reach" },
    { reason: "tls_certificate", expectContains: "couldn't reach" },
    { reason: "unclassified", expectContains: "(unclassified)" },
  ])("maps reason $reason to a matching user-facing sentence", ({ reason, expectContains }) => {
    const payload = buildPayload(reason);
    expect(payload).toBeDefined();
    const text = (payload as { text: string }).text;
    expect(text).toContain(expectContains);
    expect(text).toContain("Fallback used fallback/model-b");
  });

  it("does not claim the backend was unreachable for non-transport reasons", () => {
    const payload = buildPayload("format");
    const text = (payload as { text: string }).text;
    expect(text).not.toContain("couldn't reach");
  });

  it("returns undefined when no fallback is active", () => {
    const transition = resolveFallbackTransition({
      selectedProvider: "primary",
      selectedModel: "model-a",
      activeProvider: "primary",
      activeModel: "model-a",
      attempts: [],
      state: {},
    });
    expect(
      buildSilentFallbackFailurePayload({
        fallbackTransition: transition,
        fallbackFailureKnown: true,
        isHeartbeat: false,
        hasSuccessfulTerminalDelivery: false,
      }),
    ).toBeUndefined();
  });

  it("returns undefined for heartbeat runs", () => {
    const transition = resolveFallbackTransition({
      selectedProvider: "primary",
      selectedModel: "model-a",
      activeProvider: "fallback",
      activeModel: "model-b",
      attempts: [
        {
          provider: "primary",
          model: "model-a",
          error: "err",
          reason: "rate_limit" as const,
        },
      ],
      state: {},
    });
    expect(
      buildSilentFallbackFailurePayload({
        fallbackTransition: transition,
        fallbackFailureKnown: true,
        isHeartbeat: true,
        hasSuccessfulTerminalDelivery: false,
      }),
    ).toBeUndefined();
  });
});
