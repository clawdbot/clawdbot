// Slack tests cover suggested-prompt capability detection across view generations.
import type { App } from "@slack/bolt";
import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";
import { registerSlackAssistantEvents } from "./events/assistant.js";
import {
  updateSlackSuggestedPrompts,
  type SlackSuggestedPromptsInput,
} from "./suggested-prompts.js";

function createSlackClient(setSuggestedPrompts: ReturnType<typeof vi.fn>): App["client"] {
  return {
    assistant: {
      threads: {
        setSuggestedPrompts,
      },
    },
  } as unknown as App["client"];
}

describe("updateSlackSuggestedPrompts", () => {
  it("omits thread_ts for the Agent View capability probe", async () => {
    const setSuggestedPrompts = vi.fn().mockResolvedValue({ ok: true });

    const updated = await updateSlackSuggestedPrompts({
      botToken: "",
      client: createSlackClient(setSuggestedPrompts),
      channelId: "D123",
      title: "Try asking",
      prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
    });

    expect(updated).toBe(true);
    expect(setSuggestedPrompts).toHaveBeenCalledWith({
      token: "",
      channel_id: "D123",
      title: "Try asking",
      prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
    });
  });

  it("rejects the capability probe when Slack requires an Assistant View thread", async () => {
    const setSuggestedPrompts = vi.fn().mockRejectedValue({
      data: { ok: false, error: "invalid_arguments" },
    });

    const updated = await updateSlackSuggestedPrompts({
      botToken: "",
      client: createSlackClient(setSuggestedPrompts),
      channelId: "D123",
      prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
    });

    expect(updated).toBe(false);
  });

  it.each([
    {
      label: "Slack platform internal failure",
      error: new WebAPIPlatformError({ ok: false, error: "internal_error" }),
    },
    {
      label: "Slack platform fatal failure",
      error: new WebAPIPlatformError({ ok: false, error: "fatal_error" }),
    },
    {
      label: "Slack platform request_timeout",
      error: new WebAPIPlatformError({ ok: false, error: "request_timeout" }),
    },
    {
      label: "Slack platform service outage",
      error: new WebAPIPlatformError({ ok: false, error: "service_unavailable" }),
    },
    {
      label: "Slack platform rate limit",
      error: new WebAPIPlatformError({ ok: false, error: "ratelimited" }),
    },
    {
      label: "temporary HTTP outage",
      error: new WebAPIHTTPError(503, "Service Unavailable", {}, "temporary outage"),
    },
    {
      label: "explicit Slack rate limit",
      error: new WebAPIRateLimitedError(1),
    },
    {
      label: "uncoded Slack request failure",
      error: new WebAPIRequestError(new Error("temporary request failure")),
    },
    {
      label: "actual SDK request timeout",
      error: new WebAPIRequestError(new DOMException("request timed out", "TimeoutError")),
    },
    {
      label: "actual SDK fetch connection reset",
      error: new WebAPIRequestError(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
        }),
      ),
    },
  ])("returns $label to its durable event owner", async ({ error }) => {
    const setSuggestedPrompts = vi.fn().mockRejectedValue(error);

    await expect(
      updateSlackSuggestedPrompts({
        botToken: "",
        client: createSlackClient(setSuggestedPrompts),
        channelId: "D123",
        prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
      }),
    ).rejects.toBe(error);
  });

  it.each([
    {
      label: "unclassified plain local failure",
      error: new Error("local prompt provider unavailable"),
    },
    {
      label: "incomplete rate-limit-like failure",
      error: new Error("Retry header did not contain a valid timeout"),
    },
    {
      label: "Assistant View capability rejection",
      error: new WebAPIPlatformError({ ok: false, error: "invalid_arguments" }),
    },
    {
      label: "missing permission",
      error: new WebAPIPlatformError({ ok: false, error: "missing_scope" }),
    },
    {
      label: "enterprise migration",
      error: new WebAPIPlatformError({ ok: false, error: "org_login_required" }),
    },
    {
      label: "invalid authentication",
      error: new WebAPIPlatformError({ ok: false, error: "invalid_auth" }),
    },
    {
      label: "malformed request configuration",
      error: new WebAPIPlatformError({ ok: false, error: "invalid_form_data" }),
    },
    {
      label: "invalid prompt blocks",
      error: new WebAPIPlatformError({ ok: false, error: "invalid_blocks" }),
    },
    {
      label: "missing recipient",
      error: new WebAPIPlatformError({ ok: false, error: "user_not_found" }),
    },
    {
      label: "invalid HTTP request",
      error: new WebAPIHTTPError(400, "Bad Request", {}, "invalid request"),
    },
    {
      label: "operator cancellation",
      error: new WebAPIRequestError(new DOMException("request canceled", "AbortError")),
    },
    {
      label: "nested operator cancellation",
      error: new WebAPIRequestError(
        new Error("request wrapper", { cause: new DOMException("request canceled", "AbortError") }),
      ),
    },
    {
      label: "unwrapped local type failure",
      error: new TypeError("invalid local request"),
    },
    {
      label: "SDK-wrapped invalid URL",
      error: new WebAPIRequestError(
        new TypeError("invalid request", {
          cause: Object.assign(new TypeError("invalid URL"), { code: "ERR_INVALID_URL" }),
        }),
      ),
    },
    {
      label: "SDK-wrapped expired TLS certificate",
      error: new WebAPIRequestError(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("certificate fixture"), { code: "CERT_HAS_EXPIRED" }),
        }),
      ),
    },
    {
      label: "SDK-wrapped malformed response",
      error: new WebAPIRequestError(new TypeError("invalid fetch response")),
    },
  ])("keeps $label as a definitive unsupported capability", async ({ error }) => {
    const setSuggestedPrompts = vi.fn().mockRejectedValue(error);

    await expect(
      updateSlackSuggestedPrompts({
        botToken: "",
        client: createSlackClient(setSuggestedPrompts),
        channelId: "D123",
        prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
      }),
    ).resolves.toBe(false);
  });

  it.each(["missing_scope", "invalid_arguments"])(
    "returns the original threaded Assistant %s rejection to its event owner",
    async (errorCode) => {
      const error = new WebAPIPlatformError({ ok: false, error: errorCode });
      const setSuggestedPrompts = vi.fn().mockRejectedValue(error);

      await expect(
        updateSlackSuggestedPrompts({
          botToken: "",
          client: createSlackClient(setSuggestedPrompts),
          channelId: "D123",
          threadTs: "1729999327.187299",
          prompts: [{ title: "Draft a reply", message: "Help me draft a reply." }],
        }),
      ).rejects.toBe(error);
    },
  );

  it("preserves the Assistant View owner's existing transient-failure catch", async () => {
    const error = new WebAPIPlatformError({ ok: false, error: "internal_error" });
    const setSuggestedPrompts = vi.fn().mockRejectedValue(error);
    const client = createSlackClient(setSuggestedPrompts);
    const handlers = new Map<
      string,
      (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>
    >();
    const runtimeError = vi.fn();
    const ctx = {
      app: {
        client,
        event: (
          name: string,
          handler: (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>,
        ) => handlers.set(name, handler),
      },
      runtime: { error: runtimeError },
      botToken: "",
      shouldDropMismatchedSlackEvent: () => false,
      getSlackAssistantThreadContext: () => undefined,
      saveSlackAssistantThreadContext: vi.fn(),
      setSlackSuggestedPrompts: (input: SlackSuggestedPromptsInput) =>
        updateSlackSuggestedPrompts({ ...input, botToken: "", client }),
    } as unknown as SlackMonitorContext;
    registerSlackAssistantEvents({ ctx });

    await expect(
      handlers.get("assistant_thread_started")?.({
        event: {
          type: "assistant_thread_started",
          assistant_thread: {
            user_id: "U123",
            channel_id: "D123",
            thread_ts: "1729999327.187299",
          },
        },
        body: {},
      }),
    ).resolves.toBeUndefined();

    expect(setSuggestedPrompts).toHaveBeenCalledOnce();
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("internal_error"));
  });
});
