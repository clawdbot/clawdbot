import { describe, expect, it } from "vitest";
import {
  extractObservedOverflowTokenCount,
  isCompactionFailureError,
} from "../embedded-agent-helpers/context-overflow-observation.js";
import {
  classifyFailoverReason,
  isBillingErrorMessage,
  isContextOverflowError,
  isLikelyContextOverflowError,
} from "./classify.js";

function expectMessageMatches(
  matcher: (message: string) => boolean,
  samples: readonly string[],
  expected: boolean,
) {
  for (const sample of samples) {
    expect(matcher(sample), sample).toBe(expected);
  }
}

describe("isCompactionFailureError", () => {
  it.each([
    {
      name: "matches compaction overflow failures",
      samples: [
        'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        "auto-compaction failed due to context overflow",
        "Compaction failed: prompt is too long",
        "Summarization failed: context window exceeded for this request",
      ],
      expected: true,
    },
    {
      name: "ignores non-compaction overflow errors",
      samples: ["Context overflow: prompt too large", "rate limit exceeded"],
      expected: false,
    },
  ])("$name", ({ samples, expected }) => {
    expectMessageMatches(isCompactionFailureError, samples, expected);
  });
});

describe("isContextOverflowError", () => {
  it("matches known overflow hints", () => {
    const samples = [
      "request_too_large",
      "Request exceeds the maximum size",
      "context length exceeded",
      "Maximum context length",
      "prompt is too long: 208423 tokens > 200000 maximum",
      "Context overflow: Summarization failed",
      "413 Request Entity Too Large",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches 'exceeds model context window' in various formats", () => {
    const samples = [
      // Anthropic returns this JSON payload when prompt exceeds model context window.
      '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      "Request size exceeds model context window",
      "request size exceeds model context window",
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      "The request size exceeds model context window limit",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches Kimi 'model token limit' context overflow errors", () => {
    const samples = [
      "Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
      "error, status code: 400, message: Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
      "Your request exceeded model token limit",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches exceed/context/max_tokens overflow variants", () => {
    const samples = [
      "input length and max_tokens exceed context limit (i.e 156321 + 48384 > 200000)",
      "This request exceeds the model's maximum context length",
      "LLM request rejected: max_tokens would exceed context window",
      "input length would exceed context budget for this model",
      "The input (263000 tokens) is longer than the model's context length (262144 tokens).",
      "The input (263,000 tokens) is longer than the model's context length (262,144 tokens).",
      "The input (1 token) is longer than the model's context length (1 token).",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches model_context_window_exceeded stop reason surfaced by shared model runtime", () => {
    // Anthropic API (and some OpenAI-compatible providers like ZhipuAI/GLM) return
    // stop_reason: "model_context_window_exceeded" when the context window is hit.
    // The shared model runtime library surfaces this as "Unhandled stop reason: model_context_window_exceeded".
    const samples = [
      "Unhandled stop reason: model_context_window_exceeded",
      "model_context_window_exceeded",
      "context_window_exceeded",
      "Unhandled stop reason: context_window_exceeded",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches Chinese context overflow error messages from proxy providers", () => {
    const samples = [
      "上下文过长",
      "错误：上下文过长，请减少输入",
      "上下文超出限制",
      "上下文长度超出模型最大限制",
      "超出最大上下文长度",
      "请压缩上下文后重试",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("ignores normal conversation text mentioning context overflow", () => {
    // These are legitimate conversation snippets, not error messages.
    expect(isContextOverflowError("Let's investigate the context overflow bug")).toBe(false);
    expect(isContextOverflowError("The mystery context overflow errors are strange")).toBe(false);
    expect(isContextOverflowError("We're debugging context overflow issues")).toBe(false);
    expect(isContextOverflowError("Something is causing context overflow messages")).toBe(false);
  });
});

describe("isLikelyContextOverflowError", () => {
  it("matches context overflow hints", () => {
    const samples = [
      "Model context window is 128k tokens, you requested 256k tokens",
      "Context window exceeded: requested 12000 tokens",
      "Prompt too large for this model",
      "The input (263000 tokens) is longer than the model's context length (262144 tokens).",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(true);
    }
    expect(
      classifyFailoverReason(
        "The input (263000 tokens) is longer than the model's context length (262144 tokens).",
      ),
    ).toBe("context_overflow");
  });

  it("excludes context window too small errors", () => {
    const samples = [
      "Model context window too small (minimum is 128k tokens)",
      "Context window too small: minimum is 1000 tokens",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("excludes rate limit errors that match the broad hint regex", () => {
    const samples = [
      "request reached organization TPD rate limit, current: 1506556, limit: 1500000",
      "rate limit exceeded",
      "too many requests",
      "429 Too Many Requests",
      "exceeded your current quota",
      "This request would exceed your account's rate limit",
      "429 Too Many Requests: request exceeds rate limit",
      "AWS Bedrock: Too many tokens per day. Please try again tomorrow.",
      "Rate limit exceeded: The input (263000 tokens) is longer than the model's context length (262144 tokens).",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("keeps too-many-tokens-per-request context overflow errors out of the rate-limit lane", () => {
    const sample = "Context window exceeded: too many tokens per request.";
    expect(isLikelyContextOverflowError(sample)).toBe(true);
    expect(classifyFailoverReason(sample)).toBeNull();
  });

  it("excludes billing errors even when text matches context overflow patterns", () => {
    const samples = [
      "402 Payment Required: request token limit exceeded for this billing plan",
      "insufficient credits: request size exceeds your current plan limits",
      "Your credit balance is too low. Maximum request token limit exceeded.",
      "402 Payment Required: The input (263000 tokens) is longer than the model's context length (262144 tokens).",
    ];
    for (const sample of samples) {
      expect(isBillingErrorMessage(sample)).toBe(true);
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });
});

describe("reasoning-required invalid-request errors", () => {
  it.each([
    {
      name: "strict context overflow classifier",
      classifier: isContextOverflowError,
      samples: [
        "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
        '{"type":"error","error":{"type":"invalid_request_error","message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}',
        "This model requires reasoning to be enabled",
      ],
    },
    {
      name: "likely context overflow classifier",
      classifier: isLikelyContextOverflowError,
      samples: [
        "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
        '{"type":"error","error":{"type":"invalid_request_error","message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}',
        "This endpoint requires reasoning",
      ],
    },
  ])("excludes reasoning-required invalid-request errors from $name", ({ classifier, samples }) => {
    for (const sample of samples) {
      expect(classifier(sample)).toBe(false);
    }
  });
});

describe("extractObservedOverflowTokenCount", () => {
  it("extracts provider-reported prompt token counts", () => {
    expect(
      extractObservedOverflowTokenCount(
        '400 {"type":"error","error":{"message":"prompt is too long: 277403 tokens > 200000 maximum"}}',
      ),
    ).toBe(277403);
    expect(
      extractObservedOverflowTokenCount("Context window exceeded: requested 12000 tokens"),
    ).toBe(12000);
    expect(
      extractObservedOverflowTokenCount(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 145000 tokens.",
      ),
    ).toBe(145000);
    expect(
      extractObservedOverflowTokenCount(
        "400 The prompt is too long: 203557, model maximum context length: 196607",
      ),
    ).toBe(203557);
    expect(
      extractObservedOverflowTokenCount(
        "Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
      ),
    ).toBe(291351);
    expect(
      extractObservedOverflowTokenCount(
        "input length and max_tokens exceed context limit (i.e 156321 + 48384 > 200000)",
      ),
    ).toBe(204705);
    expect(
      extractObservedOverflowTokenCount(
        "input length and `max_tokens` exceed context limit: 176312 + 32000 > 200000",
      ),
    ).toBe(208312);
  });

  it("returns undefined when overflow counts are not present", () => {
    expect(extractObservedOverflowTokenCount("Prompt too large for this model")).toBeUndefined();
    expect(
      extractObservedOverflowTokenCount(
        "The prompt is too long: 203557 characters, model maximum context length: 196607",
      ),
    ).toBeUndefined();
    expect(extractObservedOverflowTokenCount("rate limit exceeded")).toBeUndefined();
  });
});
