/* @vitest-environment jsdom */

import { buildSystemAgentSessionInvalidatedErrorDetails } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { installSafeLocalStorageForTesting } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import { custodianErrorMessage } from "./transcript.ts";

describe("CustodianSessionStore", () => {
  beforeEach(() => {
    installSafeLocalStorageForTesting(window).clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("redacts secrets in displayed request failures", () => {
    expect(custodianErrorMessage(new Error("OPENAI_API_KEY=sk-1234567890abcdef"))).toBe(
      "OPENAI_API_KEY=sk-123...cdef",
    );
  });

  it("shares one live session across repeated surface connections", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Ready.",
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Still here.",
        action: "none",
      });
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    const firstSurfaceUpdates = vi.fn();
    const panelSurfaceUpdates = vi.fn();
    store.subscribe(firstSurfaceUpdates);
    store.subscribe(panelSurfaceUpdates);

    store.connect(context, "caretaker");
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    await store.send("Check this system");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "shared-session",
      message: "Check this system",
    });
    expect(store.messages.map((message) => message.text)).toEqual([
      "Ready.",
      "Check this system",
      "Still here.",
    ]);
    expect(store.hasRealUserTurn()).toBe(true);
    expect(firstSurfaceUpdates).toHaveBeenCalled();
    expect(panelSurfaceUpdates).toHaveBeenCalled();
  });

  it("restores a live wizard interaction from the rejoin projection", async () => {
    const step = { id: "step-1", type: "text", message: "Enter a value" };
    const request = vi.fn().mockResolvedValue({
      sessionId: "rejoined-session",
      reply: "Welcome back.",
      action: "none",
      wizardInputPending: true,
      step,
    });
    const { context } = createContext(request);
    const store = new CustodianSessionStore();

    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));

    // The reconnecting surface must re-render the answer control the Gateway
    // session still awaits, not just the transcript text.
    expect(store.wizardInputPending).toBe(true);
    expect(store.messages.at(-1)?.step).toMatchObject({ id: "step-1" });
  });

  it("reuses the persisted session id across store instances", async () => {
    const request = vi.fn((_method: string, params: { sessionId: string }) =>
      Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" }),
    );
    const { context } = createContext(request);

    new CustodianSessionStore().connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    const firstSessionId = request.mock.calls[0]?.[1].sessionId;
    expect(localStorage.getItem("openclaw.custodian.session.v1")).toBe(firstSessionId);

    new CustodianSessionStore().connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    expect(request.mock.calls[1]?.[1].sessionId).toBe(firstSessionId);
  });

  it("remints a persisted session rejected as belonging to another caller", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "OpenClaw session belongs to another caller.",
        details: buildSystemAgentSessionInvalidatedErrorDetails(),
      }),
    );
    const { context } = createContext(request);
    const store = new CustodianSessionStore();

    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));
    const rejectedSessionId = request.mock.calls[0]?.[1].sessionId;

    expect(localStorage.getItem("openclaw.custodian.session.v1")).not.toBe(rejectedSessionId);
    expect(store.canRetry()).toBe(true);
  });

  it("remints and restarts after a live session is invalidated", async () => {
    const request = vi
      .fn()
      .mockImplementationOnce((_method: string, params: { sessionId: string }) =>
        Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" }),
      )
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "OpenClaw session expired.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockImplementationOnce((_method: string, params: { sessionId: string }) =>
        Promise.resolve({ sessionId: params.sessionId, reply: "Fresh.", action: "none" }),
      );
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.messages.at(-1)?.text).toBe("Ready."));
    const staleSessionId = request.mock.calls[0]?.[1].sessionId;

    await store.send("Continue");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    const replacementSessionId = request.mock.calls[2]?.[1].sessionId;

    expect(replacementSessionId).not.toBe(staleSessionId);
    expect(localStorage.getItem("openclaw.custodian.session.v1")).toBe(replacementSessionId);
  });

  it("refreshes durable history on surface open only while idle", async () => {
    let historyTurns: Array<{ role: "assistant" | "user"; text: string; at: number }> = [];
    const request = vi.fn((method: string, params: { sessionId?: string }) => {
      if (method === "openclaw.chat.history") {
        return Promise.resolve({ turns: historyTurns });
      }
      return Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" });
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));

    historyTurns = [
      { role: "user", text: "Durable question", at: 10 },
      { role: "assistant", text: "Durable answer", at: 11 },
    ];
    await store.refreshTranscriptIfIdle();
    expect(store.messages.map((message) => message.text)).toEqual([
      "Durable question",
      "Durable answer",
    ]);
    const historyCallCount = request.mock.calls.filter(
      ([method]) => method === "openclaw.chat.history",
    ).length;

    store.sending = true;
    await store.refreshTranscriptIfIdle();
    store.sending = false;
    store.wizardInputPending = true;
    await store.refreshTranscriptIfIdle();
    store.wizardInputPending = false;
    store.messages = [
      {
        id: 1,
        role: "assistant",
        text: "Choose a repair",
        at: 12,
        question: {
          id: "repair",
          header: "Repair",
          question: "What should OpenClaw repair?",
          options: [{ label: "Gateway" }, { label: "Channel" }],
          isOther: false,
        },
        step: null,
      },
    ];
    await store.refreshTranscriptIfIdle();

    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.chat.history"),
    ).toHaveLength(historyCallCount);
    expect(store.messages[0]?.question?.id).toBe("repair");
  });

  it("refreshes durable history after reconnect and clears the abandoned outcome", async () => {
    const initialRequest = vi.fn(
      (
        method: string,
        params: { message?: string; sessionId?: string },
        options?: { signal?: AbortSignal },
      ) => {
        if (method === "openclaw.chat.history") {
          return Promise.resolve({ turns: [] });
        }
        if (params.message) {
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted")));
          });
        }
        return Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" });
      },
    );
    const { context, setGatewaySnapshot } = createContext(initialRequest, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));

    const interruptedSend = store.send("Finish the repair");
    await waitForFast(() => expect(store.sending).toBe(true));
    setGatewaySnapshot({ phase: "reconnecting", client: null });
    expect(store.abandonedTurnOutcomeUnknown).toBe(true);

    const liveStep = { id: "repair-step", type: "text", message: "Which channel?" };
    const reconnectRequest = vi.fn((method: string, params: { sessionId?: string }) => {
      if (method === "openclaw.chat.history") {
        return Promise.resolve({
          turns: [
            { role: "user", text: "Finish the repair", at: 20 },
            { role: "assistant", text: "Repair complete", at: 21 },
          ],
        });
      }
      if (method === "openclaw.chat") {
        // The full rejoin projects the authoritative live interaction.
        return Promise.resolve({
          sessionId: params.sessionId,
          reply: "Welcome back.",
          action: "none",
          wizardInputPending: true,
          step: liveStep,
        });
      }
      throw new Error(`Unexpected reconnect method: ${method}`);
    });
    setGatewaySnapshot({
      phase: "connected",
      client: { request: reconnectRequest } as unknown as GatewayBrowserClient,
    });
    await interruptedSend;
    // An unknown-outcome turn triggers a full rejoin, not just a history
    // refresh: the Gateway decides whether the answer was consumed and which
    // control is live now.
    await waitForFast(() =>
      expect(store.messages.at(-1)?.step).toMatchObject({ id: "repair-step" }),
    );
    expect(store.abandonedTurnOutcomeUnknown).toBe(false);
    expect(store.wizardInputPending).toBe(true);
    expect(store.messages.some((message) => message.text === "Repair complete")).toBe(true);
    expect(reconnectRequest.mock.calls.some(([method]) => method === "openclaw.chat")).toBe(true);
  });

  it("reconciles racing history even when the rejoin projects a live wizard", async () => {
    const step = { id: "live-step", type: "text", message: "Continue setup" };
    let historyCall = 0;
    const request = vi.fn((method: string, params: { sessionId?: string }) => {
      if (method === "openclaw.chat.history") {
        historyCall += 1;
        return Promise.resolve(
          historyCall === 1
            ? { turns: [] }
            : { turns: [{ role: "assistant", text: "Racing turn landed", at: 40 }] },
        );
      }
      return Promise.resolve({
        sessionId: params.sessionId,
        reply: "Welcome back.",
        action: "none",
        wizardInputPending: true,
        step,
      });
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    localStorage.setItem("openclaw.custodian.session.v1", "persisted-session-2");
    const store = new CustodianSessionStore();

    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));

    // A projected live control must not skip the racing-history barrier: the
    // reconciled rows render beneath the answerable wizard step.
    expect(historyCall).toBe(2);
    expect(store.messages.some((message) => message.text === "Racing turn landed")).toBe(true);
    expect(store.messages.at(-1)?.step).toMatchObject({ id: "live-step" });
    expect(store.wizardInputPending).toBe(true);
  });

  it("reconciles history persisted behind a racing turn on rejoin", async () => {
    const historyBatches = [
      { turns: [] },
      {
        turns: [
          { role: "user", text: "Earlier ask", at: 30 },
          { role: "assistant", text: "Racing turn landed", at: 31 },
        ],
      },
    ];
    let historyCall = 0;
    const request = vi.fn((method: string, params: { sessionId?: string }) => {
      if (method === "openclaw.chat.history") {
        const batch = historyBatches[Math.min(historyCall, historyBatches.length - 1)];
        historyCall += 1;
        return Promise.resolve(batch);
      }
      return Promise.resolve({ sessionId: params.sessionId, reply: "Ready.", action: "none" });
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    // A restored persisted id is what makes this a rejoin candidate.
    localStorage.setItem("openclaw.custodian.session.v1", "persisted-session-1");
    const store = new CustodianSessionStore();

    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.sending).toBe(false));

    // The welcome-only rejoin queues behind any in-flight turn server-side, so
    // the post-response refresh must surface rows that turn persisted after
    // the initial (empty) history fetch.
    expect(historyCall).toBe(2);
    expect(store.messages.some((message) => message.text === "Racing turn landed")).toBe(true);
    expect(store.messages.at(-1)?.text).toBe("Ready.");
  });

  it("blocks messages until inference setup succeeds", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "OpenClaw requires working inference: no configured model",
          details: { code: "system_agent_inference_unavailable" },
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Ready.",
        action: "none",
      });
    const { context } = createContext(request);
    const store = new CustodianSessionStore();

    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.setupRequired).toBe(true));
    expect(store.setupIssue).toBe("unavailable");

    await expect(store.send("should not send")).resolves.toBe("rejected");
    expect(request).toHaveBeenCalledOnce();

    store.retry();
    await waitForFast(() => expect(store.setupRequired).toBe(false));
    await waitForFast(() => expect(store.messages.at(-1)?.text).toBe("Ready."));
  });

  it("shows setup before starting chat when the default agent has no model", async () => {
    const request = vi.fn();
    const { context } = createContext(request, ["openclaw.chat"], {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      },
    });
    const store = new CustodianSessionStore();

    store.connect(context, "caretaker");

    expect(store.setupRequired).toBe(true);
    expect(store.setupIssue).toBe("missing");
    expect(store.sending).toBe(false);
    expect(request).not.toHaveBeenCalled();
    await expect(store.send("should not send")).resolves.toBe("rejected");
  });

  it("does not let a late onboarding reply navigate after the destination rotates context", async () => {
    let resolveReply!: (value: unknown) => void;
    let requestSignal: AbortSignal | undefined;
    const request = vi
      .fn()
      .mockImplementationOnce(
        (_method: string, _params: unknown, options?: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            requestSignal = options?.signal;
            resolveReply = resolve;
          }),
      )
      .mockReturnValue(new Promise(() => {}));
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "onboarding");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    store.exitSetup();
    expect(requestSignal?.aborted).toBe(true);
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    resolveReply({
      sessionId: "late-session",
      reply: "Your agent is ready.",
      action: "open-agent",
      agentId: "main",
      agentDraft: "hatch",
    });
    await Promise.resolve();

    expect(context.navigate).toHaveBeenCalledTimes(1);
    expect(context.navigate).toHaveBeenCalledWith("chat");
    expect(context.agents.refreshList).not.toHaveBeenCalled();
    expect(store.messages).toEqual([]);
  });

  it("does not let a late reply navigate away from channel setup", async () => {
    let resolveReply!: (value: unknown) => void;
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn().mockImplementation(
      (_method: string, _params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          requestSignal = options?.signal;
          resolveReply = resolve;
        }),
    );
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "onboarding");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    store.openChannelsFromOnboarding();
    expect(requestSignal?.aborted).toBe(true);
    expect(store.sending).toBe(false);
    resolveReply({
      sessionId: "late-channel-session",
      reply: "Your agent is ready.",
      action: "open-agent",
      agentId: "main",
      agentDraft: "hatch",
    });
    await Promise.resolve();

    expect(context.navigate).toHaveBeenCalledTimes(1);
    expect(context.navigate).toHaveBeenCalledWith("channels");
    expect(context.agents.refreshList).not.toHaveBeenCalled();
    expect(store.canRetry()).toBe(false);
  });

  it("does not let a late reply navigate away from model setup", async () => {
    let resolveReply!: (value: unknown) => void;
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn().mockImplementation(
      (_method: string, _params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          requestSignal = options?.signal;
          resolveReply = resolve;
        }),
    );
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    store.openModelSetup();
    expect(requestSignal?.aborted).toBe(true);
    expect(store.sending).toBe(false);
    resolveReply({
      sessionId: "late-model-setup-session",
      reply: "Your agent is ready.",
      action: "open-agent",
      agentId: "main",
      agentDraft: "hatch",
    });
    await Promise.resolve();

    expect(context.navigate).toHaveBeenCalledTimes(1);
    expect(context.navigate).toHaveBeenCalledWith("model-setup");
    expect(context.agents.refreshList).not.toHaveBeenCalled();
  });

  it("accepts new event nudges after a conversation variant rotates", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "shared-session",
      reply: "Ready.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });
    expect(store.eventNudge).not.toBeNull();
    store.dismissEventNudge();
    expect(store.eventNudge).toBeNull();

    store.connect(context, "onboarding");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });

    expect(store.eventNudge).not.toBeNull();
  });
});
