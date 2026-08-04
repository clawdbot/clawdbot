import { describe, expect, it, vi } from "vitest";
import { createClickClackClient } from "./http-client.js";

describe("ClickClack HTTP client timeouts", () => {
  it("aborts a REST request that stalls before response headers", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("expected ClickClack request signal"));
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
          }),
      );
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const rejection = expect(client.me()).rejects.toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      operation: "command-menu replacement",
      method: "PUT",
      path: "/api/bots/self/commands",
      invoke: (client: ReturnType<typeof createClickClackClient>) => client.setBotCommands([]),
    },
    {
      operation: "managed-channel creation",
      method: "POST",
      path: "/api/workspaces/workspace-1/channels",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.createChannel("workspace-1", {
          name: "discussion",
          kind: "public",
          external_managed: true,
          external_ref: "external-ref-1",
          sidebar_section: "Sessions",
        }),
    },
    {
      operation: "managed-channel update",
      method: "PATCH",
      path: "/api/channels/channel-1",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.updateChannel("channel-1", { archived: true }),
    },
    {
      operation: "nonce-keyed channel message",
      method: "POST",
      path: "/api/channels/channel-1/messages",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.createChannelMessage("channel-1", "message", { nonce: "message-nonce" }),
    },
    {
      operation: "nonce-keyed thread reply",
      method: "POST",
      path: "/api/messages/message-1/thread/replies",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.createThreadReply("message-1", "reply", { nonce: "message-nonce" }),
    },
    {
      operation: "create-or-reuse direct conversation",
      method: "POST",
      path: "/api/dms",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.createDirectConversation("workspace-1", ["user-1"]),
    },
    {
      operation: "nonce-keyed direct message",
      method: "POST",
      path: "/api/dms/conversation-1/messages",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.createDirectMessage("conversation-1", "message", { nonce: "message-nonce" }),
    },
    {
      operation: "activity row creation",
      method: "POST",
      path: "/api/channels/activity-channel/messages",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.createActivityMessage({
          channelId: "activity-channel",
          body: "working",
          kind: "agent_commentary",
        }),
    },
    {
      operation: "activity row update",
      method: "PATCH",
      path: "/api/messages/activity-message",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.updateMessageBody("activity-message", "done"),
    },
    {
      operation: "attachment association",
      method: "POST",
      path: "/api/messages/message-1/attachments",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.attachUpload("message-1", "upload-1"),
    },
  ])("aborts audited $operation when response headers stall", async ({ invoke, method, path }) => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("expected audited ClickClack write signal"));
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason as Error), {
              once: true,
            });
          }),
      );
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const rejection = expect(invoke(client)).rejects.toMatchObject({
        name: "TimeoutError",
        message: "request timed out",
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://clickclack.example${path}`);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe(method);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      operation: "managed-channel update",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.updateChannel("channel-1", { archived: true }),
    },
    {
      operation: "activity row creation",
      invoke: (client: ReturnType<typeof createClickClackClient>) =>
        client.createActivityMessage({
          channelId: "activity-channel",
          body: "working",
          kind: "agent_commentary",
        }),
    },
  ])("classifies an audited $operation body stall as an ambiguous timeout", async ({ invoke }) => {
    vi.useFakeTimers();
    try {
      let bodyCanceled = false;
      const fetchMock = vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"message":'));
          },
          cancel() {
            bodyCanceled = true;
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const failure = invoke(client).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(30_000);

      const error = await failure;
      expect(error).toMatchObject({
        name: "TimeoutError",
        message: "ClickClack response body stalled for 30000ms",
      });
      expect(bodyCanceled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a recoverable write whose successful body is malformed as ambiguous", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"message":', {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.createActivityMessage({
        channelId: "activity-channel",
        body: "working",
        kind: "agent_commentary",
      }),
    ).rejects.toMatchObject({
      name: "ClickClackAmbiguousWriteError",
      cause: expect.objectContaining({
        message: "ClickClack response: malformed JSON response",
      }),
    });
  });

  it.each([
    { label: "an ambiguous server failure", status: 500 },
    { label: "an ambiguous request timeout response", status: 408 },
  ])("classifies $label before owner recovery", async ({ status }) => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"error":"unavailable"}', {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.createActivityMessage({
        channelId: "activity-channel",
        body: "working",
        kind: "agent_commentary",
      }),
    ).rejects.toMatchObject({ name: "ClickClackAmbiguousWriteError" });
  });

  it("distinguishes ambiguous socket loss from a proven pre-connect failure", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    });
    const refused = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const unknown = new TypeError("fetch failed");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(reset)
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(unknown);
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const createActivity = () =>
      client.createActivityMessage({
        channelId: "activity-channel",
        body: "working",
        kind: "agent_commentary",
      });

    await expect(createActivity()).rejects.toMatchObject({
      name: "ClickClackAmbiguousWriteError",
      cause: reset,
    });
    await expect(createActivity()).rejects.toBe(refused);
    await expect(createActivity()).rejects.toMatchObject({
      name: "ClickClackAmbiguousWriteError",
      cause: unknown,
    });
  });

  it("does not follow redirects after dispatching a recoverable write", async () => {
    let observedRedirect: RequestRedirect | undefined;
    const followedHopFailure = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("redirect target refused"), { code: "ECONNREFUSED" }),
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedRedirect = init?.redirect;
      if (init?.redirect !== "error") {
        throw followedHopFailure;
      }
      throw new TypeError("fetch failed");
    });
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.createActivityMessage({
        channelId: "activity-channel",
        body: "working",
        kind: "agent_commentary",
      }),
    ).rejects.toMatchObject({ name: "ClickClackAmbiguousWriteError" });

    expect(observedRedirect).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not impose the response-header deadline on JSON writes", async () => {
    vi.useFakeTimers();
    try {
      let resolveResponse: (response: Response) => void = () => {
        throw new Error("JSON response resolver was not initialized");
      };
      let settled = false;
      const fetchMock = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          await new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      );
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const message = client.createChannelMessage("channel-1", "message").finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();

      resolveResponse(Response.json({ message: { id: "message-1" } }));
      await expect(message).resolves.toMatchObject({ id: "message-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not impose the response-header deadline on channel media uploads", async () => {
    vi.useFakeTimers();
    try {
      let resolveResponse: (response: Response) => void = () => {
        throw new Error("upload response resolver was not initialized");
      };
      let settled = false;
      const fetchMock = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          await new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      );
      const client = createClickClackClient({
        baseUrl: "https://clickclack.example",
        token: "fake",
        fetch: fetchMock as unknown as typeof fetch,
      });

      const upload = client
        .createUpload({
          workspaceId: "workspace-1",
          buffer: Buffer.from("media"),
          filename: "media.txt",
          contentType: "text/plain",
        })
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();

      resolveResponse(Response.json({ upload: { id: "upload-1" } }));
      await expect(upload).resolves.toMatchObject({ id: "upload-1" });
    } finally {
      vi.useRealTimers();
    }
  });
});
