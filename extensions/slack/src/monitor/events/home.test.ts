// Slack tests cover home plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { App, LogLevel, type Receiver, type ReceiverEvent } from "@slack/bolt";
import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
} from "@slack/web-api";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getOptionalSlackRuntime, setSlackRuntime } from "../../runtime.js";
import { createSlackAgentViewState } from "../agent-view-state.js";
import { createSlackDurableIngress, type SlackIngressTurnLifecycle } from "../ingress.js";
import { updateSlackSuggestedPrompts } from "../suggested-prompts.js";

let registerSlackHomeEvents: typeof import("./home.js").registerSlackHomeEvents;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;

type HomeHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
  context?: Record<string, unknown>;
}) => Promise<void>;

type SlackIngressQueue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];

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

function createDurableHomeLifecycle(): SlackIngressTurnLifecycle {
  return {
    admission: "exclusive",
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAbandoned: vi.fn(async () => {}),
  };
}

function createHomeEvent(eventId: string, tab: "home" | "messages" = "home"): ReceiverEvent {
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
        type: "app_home_opened",
        user: "U_TEST",
        channel: "D_TEST",
        tab,
        event_ts: "1700000000.000100",
      },
    },
  };
}

async function withDurableHomeIngress(
  fetch: NonNullable<ConstructorParameters<typeof WebClient>[1]>["fetch"],
  run: (params: {
    receive: (event: ReceiverEvent) => Promise<void>;
    ingress: ReturnType<typeof createSlackDurableIngress>;
    queue: SlackIngressQueue;
    runtimeError: ReturnType<typeof vi.fn>;
    agentViewState: ReturnType<typeof createSlackAgentViewState>;
    recordSlackAgentView: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-home-ingress-"));
  const stateDir = await fs.realpath(temporaryRoot);
  const queue = createChannelIngressQueueForTests<SlackIngressPayload>({
    channelId: "slack",
    accountId: "default",
    stateDir,
  });
  const previousSlackRuntime = getOptionalSlackRuntime();
  setSlackRuntime({
    state: {
      openKeyedStore: (options: { namespace: string; maxEntries: number }) =>
        createPluginStateKeyedStoreForTests("slack", {
          ...options,
          env: { OPENCLAW_STATE_DIR: stateDir },
        }),
    },
  } as never);
  const agentViewState = createSlackAgentViewState({
    accountId: "default",
    teamId: "T_TEST",
    apiAppId: "A_TEST",
    warn: vi.fn(),
  });
  const recordSlackAgentView = vi.fn(agentViewState.record);
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
    token: "xoxb-test",
    botId: "B_BOT",
    botUserId: "U_BOT",
    receiver: ingress.wrapReceiver(receiver),
    tokenVerificationEnabled: false,
    convoStore: false,
    ignoreSelf: false,
    logger,
    clientOptions: {
      fetch,
      retryConfig: { retries: 2, minTimeout: 0, maxTimeout: 0, randomize: false },
    },
  });
  const harness = createSlackSystemEventTestHarness();
  const runtimeError = vi.fn();
  harness.ctx.app = app;
  harness.ctx.runtime.error = runtimeError;
  harness.ctx.botToken = "xoxb-test";
  harness.ctx.setSlackSuggestedPrompts = (input) =>
    updateSlackSuggestedPrompts({ ...input, botToken: "xoxb-test", client: app.client });
  harness.ctx.recordSlackAgentView = recordSlackAgentView;
  harness.ctx.isSlackAgentView = agentViewState.isEnabled;
  registerSlackHomeEvents({ ctx: harness.ctx });
  ingress.start();

  try {
    if (!receive) {
      throw new Error("expected Slack receiver initialization");
    }
    await run({ receive, ingress, queue, runtimeError, agentViewState, recordSlackAgentView });
  } finally {
    await ingress.stop();
    setSlackRuntime(previousSlackRuntime as never);
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createHomeContext(params?: {
  slashCommandName?: string;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness();
  const publish = vi.fn().mockResolvedValue({ ok: true });
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  harness.ctx.botToken = "xoxb-test";
  (harness.ctx.app as unknown as { client: { views: { publish: typeof publish } } }).client = {
    views: { publish },
  };
  registerSlackHomeEvents({
    ctx: harness.ctx,
    slashCommandName: params?.slashCommandName,
    trackEvent: params?.trackEvent,
  });
  return {
    ctx: harness.ctx,
    publish,
    getHomeHandler: () => harness.getHandler("app_home_opened") as HomeHandler | null,
  };
}

function createAgentHomeContext(params?: { suggestedPromptsResult?: boolean }) {
  const harness = createSlackSystemEventTestHarness();
  const setSlackSuggestedPrompts = vi.fn(async () => params?.suggestedPromptsResult ?? true);
  const recordSlackAgentView = vi.fn(async () => undefined);
  harness.ctx.accountId = "default";
  harness.ctx.setSlackSuggestedPrompts = setSlackSuggestedPrompts;
  harness.ctx.recordSlackAgentView = recordSlackAgentView;
  registerSlackHomeEvents({ ctx: harness.ctx });
  return {
    ctx: harness.ctx,
    setSlackSuggestedPrompts,
    recordSlackAgentView,
    getHomeHandler: () => harness.getHandler("app_home_opened") as HomeHandler | null,
  };
}

describe("registerSlackHomeEvents", () => {
  beforeAll(async () => {
    ({ registerSlackHomeEvents } = await import("./home.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("publishes the Home tab without an inactive slash command hint", async () => {
    const trackEvent = vi.fn();
    const { publish, getHomeHandler } = createHomeContext({ trackEvent });
    const handler = getHomeHandler();
    if (!handler) {
      throw new Error("expected Slack Home handler");
    }

    await handler({
      event: {
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "home",
        event_ts: "123.456",
      },
      body: { api_app_id: "A1" },
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      token: "xoxb-test",
      user_id: "U123",
      view: expect.any(Object),
    });
    expect(publish.mock.calls[0]?.[0]?.view.blocks[1]).toMatchObject({
      type: "section",
      text: {
        text: "Send a DM or mention OpenClaw in a channel to start a session.",
      },
    });
  });

  it("publishes the configured slash command name", async () => {
    const { publish, getHomeHandler } = createHomeContext({ slashCommandName: "acme" });

    await getHomeHandler()!({
      event: {
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "home",
      },
      body: {},
    });

    expect(publish).toHaveBeenCalledWith({
      token: "xoxb-test",
      user_id: "U123",
      view: expect.any(Object),
    });
    expect(publish.mock.calls[0]?.[0]?.view.blocks[1]).toMatchObject({
      type: "section",
      text: {
        text: "Send a DM, mention OpenClaw in a channel, or use `/acme` to start a session.",
      },
    });
  });

  it.each(transientPlatformErrors)(
    "retries actual Slack Home platform %s through durable ingress",
    async (errorCode) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, error: errorCode }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              ...(errorCode === "ratelimited" ? { "retry-after": "1" } : {}),
            },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, view: { id: "V_TEST" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );

      await withDurableHomeIngress(fetch, async ({ receive, ingress, queue, runtimeError }) => {
        const eventId = `Ev-home-transient-${errorCode}`;
        const event = createHomeEvent(eventId);
        await receive(event);
        await ingress.waitForIdle();

        await expect(queue.listPending()).resolves.toMatchObject([
          { id: eventId, attempts: 1, lastError: expect.stringContaining(errorCode) },
        ]);

        await vi.waitFor(
          async () => {
            await ingress.waitForIdle();
            expect(fetch).toHaveBeenCalledTimes(2);
          },
          { timeout: 5_000, interval: 50 },
        );

        expect(event.ack).toHaveBeenCalledOnce();
        expect(runtimeError).toHaveBeenCalledOnce();
        expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining(errorCode));
        await expect(queue.enqueue(eventId, {} as SlackIngressPayload)).resolves.toMatchObject({
          kind: "completed",
        });
      });
    },
  );

  it.each(transientPlatformErrors)(
    "retries Agent View prompt platform %s and durably records its marker",
    async (errorCode) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, error: errorCode }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              ...(errorCode === "ratelimited" ? { "retry-after": "1" } : {}),
            },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );

      await withDurableHomeIngress(
        fetch,
        async ({ receive, ingress, queue, runtimeError, agentViewState, recordSlackAgentView }) => {
          const eventId = `Ev-agent-view-transient-${errorCode}`;
          const event = createHomeEvent(eventId, "messages");
          await receive(event);
          await ingress.waitForIdle();

          await expect(queue.listPending()).resolves.toMatchObject([
            { id: eventId, attempts: 1, lastError: expect.stringContaining(errorCode) },
          ]);

          await vi.waitFor(
            async () => {
              await ingress.waitForIdle();
              expect(fetch).toHaveBeenCalledTimes(2);
            },
            { timeout: 5_000, interval: 50 },
          );

          expect(event.ack).toHaveBeenCalledOnce();
          expect(runtimeError).toHaveBeenCalledOnce();
          expect(recordSlackAgentView).toHaveBeenCalledOnce();
          await expect(agentViewState.isEnabled()).resolves.toBe(true);
          const restartedAgentViewState = createSlackAgentViewState({
            accountId: "default",
            teamId: "T_TEST",
            apiAppId: "A_TEST",
            warn: vi.fn(),
          });
          await expect(restartedAgentViewState.isEnabled()).resolves.toBe(true);
          await expect(queue.enqueue(eventId, {} as SlackIngressPayload)).resolves.toMatchObject({
            kind: "completed",
          });
        },
      );
    },
  );

  it.each(["home", "messages"] as const)(
    "replays exhausted real Slack client rate limits for the %s tab",
    async (tab) => {
      const rateLimited = () => new Response("", { status: 429, headers: { "retry-after": "0" } });
      const fetch = vi
        .fn()
        .mockImplementationOnce(async () => rateLimited())
        .mockImplementationOnce(async () => rateLimited())
        .mockImplementationOnce(async () => rateLimited())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, view: { id: "V_TEST" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );

      await withDurableHomeIngress(
        fetch,
        async ({ receive, ingress, queue, agentViewState, recordSlackAgentView }) => {
          const eventId = `Ev-${tab}-rate-limited`;
          const event = createHomeEvent(eventId, tab);
          await receive(event);

          await vi.waitFor(
            async () => {
              await ingress.waitForIdle();
              expect(fetch).toHaveBeenCalledTimes(4);
            },
            { timeout: 5_000, interval: 50 },
          );

          expect(event.ack).toHaveBeenCalledOnce();
          expect(recordSlackAgentView).toHaveBeenCalledTimes(tab === "messages" ? 1 : 0);
          await expect(agentViewState.isEnabled()).resolves.toBe(tab === "messages");
          await expect(queue.enqueue(eventId, {} as SlackIngressPayload)).resolves.toMatchObject({
            kind: "completed",
          });
        },
      );
    },
  );

  it.each(
    malformedRetryAfterHeaders.flatMap(({ headerLabel, retryAfter }) =>
      (["home", "messages"] as const).map((tab) => ({ headerLabel, retryAfter, tab })),
    ),
  )("replays malformed Retry-After $headerLabel for the $tab tab", async (scenario) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", {
          status: 429,
          headers: scenario.retryAfter === undefined ? {} : { "retry-after": scenario.retryAfter },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, view: { id: "V_TEST" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await withDurableHomeIngress(
      fetch,
      async ({ receive, ingress, queue, agentViewState, recordSlackAgentView }) => {
        const eventId = `Ev-${scenario.tab}-${scenario.headerLabel}-retry-header`;
        const event = createHomeEvent(eventId, scenario.tab);
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
            expect(fetch).toHaveBeenCalledTimes(2);
          },
          { timeout: 5_000, interval: 50 },
        );

        expect(event.ack).toHaveBeenCalledOnce();
        expect(recordSlackAgentView).toHaveBeenCalledTimes(scenario.tab === "messages" ? 1 : 0);
        await expect(agentViewState.isEnabled()).resolves.toBe(scenario.tab === "messages");
        await expect(queue.enqueue(eventId, {} as SlackIngressPayload)).resolves.toMatchObject({
          kind: "completed",
        });
      },
    );
  });

  it.each([
    "invalid_arguments",
    "missing_scope",
    "org_login_required",
    "invalid_auth",
    "invalid_form_data",
  ])(
    "keeps permanent Agent View capability rejection %s from blocking the next event",
    async (errorCode) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, error: errorCode }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );

      await withDurableHomeIngress(
        fetch,
        async ({ receive, ingress, queue, agentViewState, recordSlackAgentView }) => {
          const permanentId = `Ev-agent-view-rejected-${errorCode}`;
          const nextId = `Ev-agent-view-next-${errorCode}`;
          await receive(createHomeEvent(permanentId, "messages"));
          await ingress.waitForIdle();

          expect(fetch).toHaveBeenCalledOnce();
          expect(recordSlackAgentView).not.toHaveBeenCalled();
          await expect(agentViewState.isEnabled()).resolves.toBe(false);
          await expect(
            queue.enqueue(permanentId, {} as SlackIngressPayload),
          ).resolves.toMatchObject({ kind: "completed" });

          await receive(createHomeEvent(nextId, "messages"));
          await ingress.waitForIdle();

          expect(fetch).toHaveBeenCalledTimes(2);
          expect(recordSlackAgentView).toHaveBeenCalledOnce();
          await expect(agentViewState.isEnabled()).resolves.toBe(true);
          await expect(queue.enqueue(nextId, {} as SlackIngressPayload)).resolves.toMatchObject({
            kind: "completed",
          });
        },
      );
    },
  );

  it.each([
    {
      label: "an actually malformed URL",
      fail: async () => await globalThis.fetch("http://[invalid"),
    },
    {
      label: "a permanent TLS certificate error",
      fail: async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("certificate fixture"), { code: "CERT_HAS_EXPIRED" }),
        });
      },
    },
    {
      label: "a malformed fetch response",
      fail: async () => null,
    },
  ])("keeps real SDK-wrapped $label from poisoning either Home lane", async ({ fail }) => {
    for (const tab of ["home", "messages"] as const) {
      const fetch = vi
        .fn()
        .mockImplementationOnce(fail)
        .mockImplementationOnce(fail)
        .mockImplementationOnce(fail)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, view: { id: "V_TEST" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );

      await withDurableHomeIngress(
        fetch,
        async ({ receive, ingress, queue, agentViewState, recordSlackAgentView }) => {
          const permanentId = `Ev-${tab}-permanent-fetch`;
          const nextId = `Ev-${tab}-next-after-fetch`;
          const nextTab = tab === "home" ? "messages" : "home";
          await receive(createHomeEvent(permanentId, tab));
          await ingress.waitForIdle();

          expect(fetch).toHaveBeenCalledTimes(3);
          expect(recordSlackAgentView).not.toHaveBeenCalled();
          await expect(
            queue.enqueue(permanentId, {} as SlackIngressPayload),
          ).resolves.toMatchObject({ kind: "completed" });

          await receive(createHomeEvent(nextId, nextTab));
          await ingress.waitForIdle();

          expect(fetch).toHaveBeenCalledTimes(4);
          expect(recordSlackAgentView).toHaveBeenCalledTimes(nextTab === "messages" ? 1 : 0);
          await expect(agentViewState.isEnabled()).resolves.toBe(nextTab === "messages");
          await expect(queue.enqueue(nextId, {} as SlackIngressPayload)).resolves.toMatchObject({
            kind: "completed",
          });
        },
      );
    }
  });

  it.each(["invalid_blocks", "user_not_found"])(
    "completes permanent %s errors without blocking the user's next event",
    async (errorCode) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, error: errorCode }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, view: { id: "V_TEST" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );

      await withDurableHomeIngress(fetch, async ({ receive, ingress, queue, runtimeError }) => {
        const permanentId = `Ev-home-permanent-${errorCode}`;
        const nextId = `Ev-home-next-${errorCode}`;
        await receive(createHomeEvent(permanentId));
        await ingress.waitForIdle();

        expect(fetch).toHaveBeenCalledOnce();
        expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining(errorCode));
        await expect(queue.enqueue(permanentId, {} as SlackIngressPayload)).resolves.toMatchObject({
          kind: "completed",
        });

        await receive(createHomeEvent(nextId));
        await ingress.waitForIdle();

        expect(fetch).toHaveBeenCalledTimes(2);
        await expect(queue.enqueue(nextId, {} as SlackIngressPayload)).resolves.toMatchObject({
          kind: "completed",
        });
      });
    },
  );

  it.each([
    { label: "rate-limit", error: new WebAPIRateLimitedError(1) },
    {
      label: "temporary HTTP outage",
      error: new WebAPIHTTPError(503, "Service Unavailable", {}, "temporary outage"),
    },
    {
      label: "connection reset",
      error: new WebAPIRequestError(
        Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      ),
    },
  ])("returns genuine $label failures to durable ingress", async ({ error }) => {
    const { ctx, publish, getHomeHandler } = createHomeContext();
    ctx.runtime.error = vi.fn();
    publish.mockRejectedValueOnce(error);

    await expect(
      getHomeHandler()!({
        event: { type: "app_home_opened", user: "U_TEST", tab: "home" },
        body: {},
        context: { openclawIngressLifecycle: createDurableHomeLifecycle() },
      }),
    ).rejects.toBe(error);

    expect(ctx.runtime.error).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "unclassified plain local failure",
      error: new Error("local provider unavailable"),
    },
    {
      label: "incomplete rate-limit-like failure",
      error: new Error("Retry header did not contain a valid timeout"),
    },
    {
      label: "unknown platform failure",
      error: new WebAPIPlatformError({ ok: false, error: "unknown_error" }),
    },
    {
      label: "missing permission",
      error: new WebAPIPlatformError({ ok: false, error: "missing_scope" }),
    },
    {
      label: "invalid HTTP request",
      error: new WebAPIHTTPError(400, "Bad Request", {}, "invalid"),
    },
    {
      label: "operator cancellation",
      error: new WebAPIRequestError(new DOMException("request canceled", "AbortError")),
    },
  ])("keeps $label terminal even when durable ingress owns the event", async ({ error }) => {
    const { ctx, publish, getHomeHandler } = createHomeContext();
    ctx.runtime.error = vi.fn();
    publish.mockRejectedValueOnce(error);

    await expect(
      getHomeHandler()!({
        event: { type: "app_home_opened", user: "U_TEST", tab: "home" },
        body: {},
        context: { openclawIngressLifecycle: createDurableHomeLifecycle() },
      }),
    ).resolves.toBeUndefined();

    expect(ctx.runtime.error).toHaveBeenCalledOnce();
  });

  it("preserves direct handler logging without durable ingress replay", async () => {
    const { ctx, publish, getHomeHandler } = createHomeContext();
    ctx.runtime.error = vi.fn();
    publish.mockRejectedValueOnce(new WebAPIPlatformError({ ok: false, error: "internal_error" }));

    await expect(
      getHomeHandler()!({
        event: { type: "app_home_opened", user: "U_TEST", tab: "home" },
        body: {},
      }),
    ).resolves.toBeUndefined();

    expect(ctx.runtime.error).toHaveBeenCalledWith(expect.stringContaining("internal_error"));
  });

  it("preserves direct Agent View handler logging without durable ingress replay", async () => {
    const { ctx, setSlackSuggestedPrompts, recordSlackAgentView, getHomeHandler } =
      createAgentHomeContext();
    ctx.runtime.error = vi.fn();
    setSlackSuggestedPrompts.mockRejectedValueOnce(
      new WebAPIPlatformError({ ok: false, error: "internal_error" }),
    );

    await expect(
      getHomeHandler()!({
        event: { type: "app_home_opened", user: "U_TEST", channel: "D_TEST", tab: "messages" },
        body: {},
      }),
    ).resolves.toBeUndefined();

    expect(recordSlackAgentView).not.toHaveBeenCalled();
    expect(ctx.runtime.error).toHaveBeenCalledWith(expect.stringContaining("internal_error"));
  });

  it("records Agent View only after Slack accepts threadless prompts", async () => {
    const { setSlackSuggestedPrompts, recordSlackAgentView, getHomeHandler } =
      createAgentHomeContext();

    await getHomeHandler()!({
      event: {
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "messages",
      },
      body: {},
    });

    expect(setSlackSuggestedPrompts).toHaveBeenCalledWith({
      channelId: "D123",
      title: "Try asking",
      prompts: [
        { title: "What can you do?", message: "What can you help me with?" },
        {
          title: "Summarize this channel",
          message: "Summarize the recent activity in this channel.",
        },
        { title: "Draft a reply", message: "Help me draft a reply." },
      ],
    });
    expect(recordSlackAgentView).toHaveBeenCalledTimes(1);
    expect(setSlackSuggestedPrompts.mock.invocationCallOrder[0]).toBeLessThan(
      recordSlackAgentView.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps Assistant View out of Agent mode when threadless prompts are rejected", async () => {
    const { recordSlackAgentView, getHomeHandler } = createAgentHomeContext({
      suggestedPromptsResult: false,
    });

    await getHomeHandler()!({
      event: {
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "messages",
      },
      body: {},
    });

    expect(recordSlackAgentView).not.toHaveBeenCalled();
  });

  it("does not track or publish mismatched events", async () => {
    const trackEvent = vi.fn();
    const { publish, getHomeHandler } = createHomeContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });

    await getHomeHandler()!({
      event: {
        type: "app_home_opened",
        user: "U123",
        tab: "home",
      },
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
