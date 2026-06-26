// Covers assistant error formatting for streaming, sandbox, and context errors.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../../shared/assistant-error-format.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  classifyFailoverReason,
  extractFailoverSignalDetails,
  formatAssistantErrorText,
  isConnectionError,
  isLikelyContextOverflowError,
} from "./errors.js";

const { toolPolicyAuditInfo } = vi.hoisted(() => ({
  toolPolicyAuditInfo: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: toolPolicyAuditInfo,
    warn: vi.fn(),
  }),
}));

describe("Claude CLI logged-out failures", () => {
  const loggedOutMessage = "Not logged in · Please run /login";

  it("classifies the logged-out response as auth only for claude-cli", () => {
    expect(classifyFailoverReason(loggedOutMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(loggedOutMessage, { provider: "openai" })).toBeNull();
    expect(classifyFailoverReason(loggedOutMessage)).toBeNull();
  });
});

describe("formatAssistantErrorText streaming JSON parse classification", () => {
  beforeEach(() => {
    toolPolicyAuditInfo.mockClear();
  });

  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    makeAssistantMessageFixture({
      errorMessage,
      content: [{ type: "text", text: errorMessage }],
    });

  it("suppresses transport-classified malformed streaming fragments", () => {
    // Transport JSON fragmentation is not user-authored content and should get
    // stable retry copy instead of raw parser text.
    const msg = makeAssistantError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM streaming response contained a malformed fragment. Please try again.",
    );
  });

  it("does not suppress unclassified JSON.parse text", () => {
    const msg = makeAssistantError(
      "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)",
    );
  });

  it("keeps non-streaming provider request-validation syntax diagnostics", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Expected value in JSON at position 12 for messages.0.content"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request rejected: Expected value in JSON at position 12 for messages.0.content",
    );
  });

  it("audits a sandbox tool-policy block once per assistant error", () => {
    // Formatting may be called multiple times for the same error; audit logs
    // should stay deduplicated per blocked assistant error.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            deny: ["browser"],
          },
        },
      },
    };
    const msg = makeAssistantError("unknown tool: browser");

    expect(
      formatAssistantErrorText(msg, { cfg, sessionKey: "agent:main:mobilechat:g1" }),
    ).toContain('Tool "browser" blocked by sandbox tool policy');
    expect(
      formatAssistantErrorText(msg, { cfg, sessionKey: "agent:main:mobilechat:g1" }),
    ).toContain('Tool "browser" blocked by sandbox tool policy');

    expect(toolPolicyAuditInfo).toHaveBeenCalledTimes(1);
    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "sandbox tool policy blocked browser via tools.sandbox.tools.deny; matched browser",
      {
        tool: "browser",
        ruleKind: "deny",
        ruleSource: "global",
        configKey: "tools.sandbox.tools.deny",
        matchedRule: "browser",
        sandboxMode: "non-main",
      },
    );
  });
});

describe("extractFailoverSignalDetails", () => {
  it.each([
    {
      name: "backs off before a split surrogate pair",
      input: `${"a".repeat(999)}🎉!`,
      expected: "a".repeat(999),
    },
    {
      name: "keeps the full ASCII budget",
      input: "a".repeat(1001),
      expected: "a".repeat(1000),
    },
  ])("$name in nested provider details", ({ input, expected }) => {
    const details = extractFailoverSignalDetails({ error: { body: { detail: input } } });

    expect(details).toEqual([expected]);
  });
});

describe("isLikelyContextOverflowError", () => {
  it("detects Codex promptError wording for a full context window", () => {
    expect(
      isLikelyContextOverflowError(
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      ),
    ).toBe(true);
  });
});

describe("isConnectionError", () => {
  // Bare transport failures carry no leading HTTP status, so the orchestrator
  // gates its one-shot transient retry on this predicate (#87180). Verify it
  // catches the SDK/Node connection strings without over-matching terminal
  // errors that must surface to the user instead of silently retrying.
  it.each([
    "Connection error.", // Anthropic SDK APIConnectionError literal
    "socket hang up",
    "ECONNRESET",
    "ECONNREFUSED",
    "fetch failed",
    "connection reset by peer",
    "network is unreachable",
    "  ECONNRESET  ", // leading/trailing whitespace is trimmed
  ])("treats %j as a connection error", (message) => {
    expect(isConnectionError(message)).toBe(true);
  });

  it.each([
    "", // empty message must not retry
    "402 Payment Required: billing hard limit reached",
    "Context window exceeded: prompt too large for this model",
    "429 Too Many Requests",
    "500 Internal Server Error", // status-based transient, owned by isTransientHttpError
    "invalid_api_key: the provided credential is incorrect",
  ])("does not treat %j as a connection error", (message) => {
    expect(isConnectionError(message)).toBe(false);
  });
});
