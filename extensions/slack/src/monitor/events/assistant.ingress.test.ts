// Slack Assistant ingress proof uses real Bolt, Web API requests, and SQLite state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { App, LogLevel, type Receiver, type ReceiverEvent } from "@slack/bolt";
import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackAssistantThreadContext } from "../context.js";
import { createSlackDurableIngress } from "../ingress.js";
import { updateSlackSuggestedPrompts } from "../suggested-prompts.js";
import { registerSlackAssistantEvents } from "./assistant.js";
import { createSlackSystemEventTestHarness } from "./system-event-test-harness.js";

type SlackIngressQueue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];
type SlackFetch = NonNullable<ConstructorParameters<typeof WebClient>[1]>["fetch"];
type AssistantEventType = "assistant_thread_started" | "assistant_thread_context_changed";
type SlackFetchStep = {
  method: string;
  body: Record<string, unknown>;
  retryAfter?: string;
  status?: number;
};

const slackApiRoot = "https://slack-proof.invalid/api/";
const botMessage = { user: "U_BOT", ts: "1700000000.000200", text: "assistant reply" };
const transientPlatformErrors = [
  "internal_error",
  "service_unavailable",
  "ratelimited",
  "fatal_error",
  "request_timeout",
] as const;
const malformedRetryAfterHeaders = [
  { headerLabel: "missing", retryAfter: undefined },
  { headerLabel: "invalid", retryAfter: "not-a-timeout" },
] as const;

function slackResponse(body: Record<string, unknown>, retryAfter?: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
  });
}

function transientSlackFailure(
  method: string,
  error: (typeof transientPlatformErrors)[number],
): SlackFetchStep {
  return {
    method,
    body: { ok: false, error },
    ...(error === "ratelimited" ? { retryAfter: "1" } : {}),
  };
}

function createGuardedSlackFetch(steps: SlackFetchStep[]) {
  const requests: Array<{ method: string; body: URLSearchParams; requestedAt: number }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const step = steps[requests.length];
    if (
      !step ||
      url.origin !== "https://slack-proof.invalid" ||
      url.pathname !== `/api/${step.method}` ||
      init?.method !== "POST" ||
      typeof init.body !== "string"
    ) {
      throw new Error(`unexpected Slack proof request: ${url.origin}${url.pathname}`);
    }
    requests.push({
      method: step.method,
      body: new URLSearchParams(init.body),
      requestedAt: Date.now(),
    });
    return slackResponse(step.body, step.retryAfter, step.status);
  });
  return { fetch, requests };
}

function createAssistantEvent(eventId: string, type: AssistantEventType): ReceiverEvent {
  return {
    ack: vi.fn(async () => {}),
    body: {
      token: "verification-fixture",
      team_id: "T_TEST",
      api_app_id: "A_TEST",
      type: "event_callback",
      event_id: eventId,
      event_time: 1_700_000_000,
      event: {
        type,
        assistant_thread: {
          user_id: "U_TEST",
          channel_id: "D_TEST",
          thread_ts: "1700000000.000100",
          context: { channel_id: "C_PRIVATE", team_id: "T_TEST", enterprise_id: null },
        },
        event_ts: "1700000000.000300",
      },
    },
  };
}

async function withDurableAssistantIngress(
  fetch: SlackFetch,
  run: (params: {
    receive: (event: ReceiverEvent) => Promise<void>;
    ingress: ReturnType<typeof createSlackDurableIngress>;
    queue: SlackIngressQueue;
    runtimeError: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-assistant-"));
  const stateDir = await fs.realpath(temporaryRoot);
  const queue = createChannelIngressQueueForTests<SlackIngressPayload>({
    channelId: "slack",
    accountId: "default",
    stateDir,
  });
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue,
    pollIntervalMs: 25,
    adoptionStallTimeoutMs: 5_000,
  });
  let receive: ((event: ReceiverEvent) => Promise<void>) | undefined;
  const receiver: Receiver = {
    init: (app) => {
      receive = async (event) => await app.processEvent(event);
    },
    start: async () => undefined,
    stop: async () => undefined,
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    getLevel: () => LogLevel.INFO,
    setName: vi.fn(),
  };
  const app = new App({
    token: "xoxb-fixture",
    botId: "B_BOT",
    botUserId: "U_BOT",
    receiver: ingress.wrapReceiver(receiver),
    tokenVerificationEnabled: false,
    convoStore: false,
    ignoreSelf: false,
    logger,
    clientOptions: {
      slackApiUrl: slackApiRoot,
      fetch,
      retryConfig: { retries: 0 },
    },
  });
  const harness = createSlackSystemEventTestHarness();
  const assistantThreads = new Map<string, SlackAssistantThreadContext>();
  const runtimeError = vi.fn();
  harness.ctx.app = app;
  harness.ctx.botToken = "xoxb-fixture";
  harness.ctx.runtime.error = runtimeError;
  harness.ctx.getSlackAssistantThreadContext = (channelId, threadTs) =>
    assistantThreads.get(`${channelId}:${threadTs}`);
  harness.ctx.saveSlackAssistantThreadContext = (thread) =>
    assistantThreads.set(`${thread.assistantChannelId}:${thread.threadTs}`, {
      ...thread,
      updatedAt: Date.now(),
    });
  harness.ctx.setSlackSuggestedPrompts = (input) =>
    updateSlackSuggestedPrompts({ ...input, botToken: "xoxb-fixture", client: app.client });
  registerSlackAssistantEvents({ ctx: harness.ctx });
  ingress.start();

  try {
    if (!receive) {
      throw new Error("expected Slack receiver initialization");
    }
    await run({ receive, ingress, queue, runtimeError });
  } finally {
    await ingress.stop();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Slack Assistant durable ingress", () => {
  it.each(transientPlatformErrors)(
    "replays suggested-prompt %s without acknowledging the event twice",
    async (error) => {
      const { fetch, requests } = createGuardedSlackFetch([
        transientSlackFailure("assistant.threads.setSuggestedPrompts", error),
        { method: "assistant.threads.setSuggestedPrompts", body: { ok: true } },
      ]);

      await withDurableAssistantIngress(
        fetch,
        async ({ receive, ingress, queue, runtimeError }) => {
          const eventId = `Ev-assistant-started-${error}`;
          const event = createAssistantEvent(eventId, "assistant_thread_started");
          await receive(event);
          await ingress.waitForIdle();

          await expect(queue.listPending()).resolves.toMatchObject([
            { id: eventId, attempts: 1, lastError: expect.stringContaining(error) },
          ]);
          await vi.waitFor(
            async () => {
              await ingress.waitForIdle();
              expect(requests).toHaveLength(2);
            },
            { timeout: 5_000, interval: 50 },
          );

          expect(event.ack).toHaveBeenCalledOnce();
          expect(runtimeError).toHaveBeenCalledOnce();
          expect(requests[1]?.body.get("channel_id")).toBe("D_TEST");
          expect(requests[1]?.body.get("thread_ts")).toBe("1700000000.000100");
          if (error === "ratelimited") {
            expect(requests[1]!.requestedAt - requests[0]!.requestedAt).toBeGreaterThanOrEqual(950);
          }
          await expect(queue.enqueue(eventId, {} as SlackIngressPayload)).resolves.toMatchObject({
            kind: "completed",
          });
        },
      );
    },
  );

  it.each(
    malformedRetryAfterHeaders.flatMap(({ headerLabel, retryAfter }) => [
      {
        headerLabel,
        name: "suggested prompts",
        type: "assistant_thread_started" as const,
        steps: [
          {
            method: "assistant.threads.setSuggestedPrompts",
            body: { ok: false },
            status: 429,
            retryAfter,
          },
          { method: "assistant.threads.setSuggestedPrompts", body: { ok: true } },
        ],
      },
      {
        headerLabel,
        name: "history lookup",
        type: "assistant_thread_context_changed" as const,
        steps: [
          { method: "conversations.replies", body: { ok: false }, status: 429, retryAfter },
          { method: "conversations.replies", body: { ok: true, messages: [botMessage] } },
          { method: "chat.update", body: { ok: true } },
        ],
      },
      {
        headerLabel,
        name: "metadata update",
        type: "assistant_thread_context_changed" as const,
        steps: [
          { method: "conversations.replies", body: { ok: true, messages: [botMessage] } },
          { method: "chat.update", body: { ok: false }, status: 429, retryAfter },
          { method: "conversations.replies", body: { ok: true, messages: [botMessage] } },
          { method: "chat.update", body: { ok: true } },
        ],
      },
    ]),
  )("replays malformed Retry-After $headerLabel for Assistant $name", async (scenario) => {
    const { fetch, requests } = createGuardedSlackFetch(scenario.steps);

    await withDurableAssistantIngress(fetch, async ({ receive, ingress, queue, runtimeError }) => {
      const eventId = `Ev-assistant-${scenario.name.replace(" ", "-")}-${scenario.headerLabel}-429`;
      const event = createAssistantEvent(eventId, scenario.type);
      await receive(event);
      await ingress.waitForIdle();

      await expect(queue.listPending()).resolves.toMatchObject([
        {
          id: eventId,
          attempts: 1,
          lastError: expect.stringContaining("Retry header did not contain a valid timeout"),
        },
      ]);
      await vi.waitFor(
        async () => {
          await ingress.waitForIdle();
          expect(requests).toHaveLength(scenario.steps.length);
        },
        { timeout: 5_000, interval: 50 },
      );

      expect(event.ack).toHaveBeenCalledOnce();
      expect(runtimeError).toHaveBeenCalledOnce();
      await expect(queue.enqueue(eventId, {} as SlackIngressPayload)).resolves.toMatchObject({
        kind: "completed",
      });
    });
  });

  it.each(
    transientPlatformErrors.flatMap((error) => [
      {
        name: "history lookup",
        error,
        steps: [
          transientSlackFailure("conversations.replies", error),
          { method: "conversations.replies", body: { ok: true, messages: [botMessage] } },
          { method: "chat.update", body: { ok: true } },
        ],
      },
      {
        name: "metadata update",
        error,
        steps: [
          { method: "conversations.replies", body: { ok: true, messages: [botMessage] } },
          transientSlackFailure("chat.update", error),
          { method: "conversations.replies", body: { ok: true, messages: [botMessage] } },
          { method: "chat.update", body: { ok: true } },
        ],
      },
    ]),
  )("replays Assistant context $name $error", async ({ name, error, steps }) => {
    const { fetch, requests } = createGuardedSlackFetch(steps);

    await withDurableAssistantIngress(fetch, async ({ receive, ingress, queue, runtimeError }) => {
      const eventId = `Ev-assistant-context-${name.replace(" ", "-")}-${error}`;
      const event = createAssistantEvent(eventId, "assistant_thread_context_changed");
      await receive(event);
      await ingress.waitForIdle();

      await expect(queue.listPending()).resolves.toMatchObject([
        { id: eventId, attempts: 1, lastError: expect.stringContaining(error) },
      ]);
      await vi.waitFor(
        async () => {
          await ingress.waitForIdle();
          expect(requests).toHaveLength(steps.length);
        },
        { timeout: 5_000, interval: 50 },
      );

      expect(event.ack).toHaveBeenCalledOnce();
      expect(runtimeError).toHaveBeenCalledOnce();
      const metadata = JSON.parse(requests.at(-1)?.body.get("metadata") ?? "null") as {
        event_payload?: { channel_id?: string; team_id?: string };
      };
      expect(metadata.event_payload).toMatchObject({ channel_id: "C_PRIVATE", team_id: "T_TEST" });
      await expect(queue.enqueue(eventId, {} as SlackIngressPayload)).resolves.toMatchObject({
        kind: "completed",
      });
    });
  });

  it.each([
    {
      type: "assistant_thread_started" as const,
      method: "assistant.threads.setSuggestedPrompts",
      error: "missing_scope",
    },
    {
      type: "assistant_thread_started" as const,
      method: "assistant.threads.setSuggestedPrompts",
      error: "invalid_arguments",
    },
    {
      type: "assistant_thread_context_changed" as const,
      method: "conversations.replies",
      error: "missing_scope",
    },
    {
      type: "assistant_thread_context_changed" as const,
      method: "conversations.replies",
      error: "invalid_arguments",
    },
    {
      type: "assistant_thread_started" as const,
      method: "assistant.threads.setSuggestedPrompts",
      error: "org_login_required",
    },
    {
      type: "assistant_thread_started" as const,
      method: "assistant.threads.setSuggestedPrompts",
      error: "invalid_auth",
    },
    {
      type: "assistant_thread_started" as const,
      method: "assistant.threads.setSuggestedPrompts",
      error: "invalid_form_data",
    },
  ])("surfaces permanent $error from $type without poisoning the next event", async (scenario) => {
    const { fetch, requests } = createGuardedSlackFetch([
      {
        method: scenario.method,
        body: {
          ok: false,
          error: scenario.error,
          ...(scenario.type === "assistant_thread_started" && scenario.error === "missing_scope"
            ? { needed: "assistant:write" }
            : {}),
        },
      },
      { method: "assistant.threads.setSuggestedPrompts", body: { ok: true } },
    ]);

    await withDurableAssistantIngress(fetch, async ({ receive, ingress, queue, runtimeError }) => {
      const rejectedId = `Ev-assistant-rejected-${scenario.error}`;
      const nextId = `Ev-assistant-next-${scenario.error}`;
      const rejected = createAssistantEvent(rejectedId, scenario.type);
      const next = createAssistantEvent(nextId, "assistant_thread_started");
      await receive(rejected);
      await ingress.waitForIdle();

      expect(requests).toHaveLength(1);
      expect(runtimeError).toHaveBeenCalledOnce();
      expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining(scenario.error));
      if (scenario.type === "assistant_thread_started" && scenario.error === "missing_scope") {
        expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("assistant:write"));
      }
      expect(runtimeError.mock.calls[0]?.[0]).not.toContain("xoxb-fixture");
      await expect(queue.enqueue(rejectedId, {} as SlackIngressPayload)).resolves.toMatchObject({
        kind: "completed",
      });

      await receive(next);
      await ingress.waitForIdle();

      expect(requests).toHaveLength(2);
      expect(runtimeError).toHaveBeenCalledOnce();
      expect(rejected.ack).toHaveBeenCalledOnce();
      expect(next.ack).toHaveBeenCalledOnce();
      await expect(queue.enqueue(nextId, {} as SlackIngressPayload)).resolves.toMatchObject({
        kind: "completed",
      });
    });
  });

  it("keeps temporary failures diagnostic-only when no durable lifecycle owns the direct event", async () => {
    const harness = createSlackSystemEventTestHarness();
    const runtimeError = vi.fn();
    harness.ctx.runtime.error = runtimeError;
    harness.ctx.getSlackAssistantThreadContext = () => undefined;
    harness.ctx.saveSlackAssistantThreadContext = () => {};
    harness.ctx.setSlackSuggestedPrompts = vi.fn(async () => {
      throw new WebAPIPlatformError({ ok: false, error: "internal_error" });
    });
    registerSlackAssistantEvents({ ctx: harness.ctx });

    const event = createAssistantEvent("Ev-assistant-direct", "assistant_thread_started");
    await expect(
      harness.getHandler("assistant_thread_started")!({
        event: event.body.event as Record<string, unknown>,
        body: event.body,
      }),
    ).resolves.toBeUndefined();
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("internal_error"));
  });
});
