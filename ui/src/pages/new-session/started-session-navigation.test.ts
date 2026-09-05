import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_ROUTE_READY_EVENT } from "../../app/route-transition.ts";
import { consumeSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("confirmed session navigation", () => {
  it("hands off the confirmed session without waiting for speculative preloading", async () => {
    const { context, flow } = createDraftFixture();
    const sessionKey = "agent:main:dashboard:0f403cb8-3920-4cf1-8eb7-79f2f00ce488";
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: sessionKey,
      initialRun: { status: "idle" },
    });
    let releasePreload!: () => void;
    vi.mocked(context.preload).mockReturnValue(
      new Promise<void>((resolve) => {
        releasePreload = resolve;
      }),
    );
    vi.mocked(context.navigateAndWait).mockImplementation(async (_routeId, options) => {
      expect(options?.pathname).toBe("/chat/main/0f403cb8");
      expect(consumeSessionNavigationHandoff(context.gateway, "/chat/main/0f403cb8")).toBe(
        sessionKey,
      );
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
    flow.setMessage("start this task");
    const submission = flow.submit();
    try {
      await vi.waitFor(() => expect(context.navigateAndWait).toHaveBeenCalledOnce());
      await submission;
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      expect(flow.error).toBeNull();
    } finally {
      releasePreload();
      await submission;
    }
  });

  it("surfaces navigation failure after a session has already been created", async () => {
    const { context, flow } = createDraftFixture();
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:created",
      initialRun: { status: "idle" },
    });
    vi.mocked(context.navigateAndWait)
      .mockRejectedValueOnce(new Error("Chat route failed to load"))
      .mockImplementationOnce(async () => {
        queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
      });
    flow.setMessage("start this task");

    await flow.submit();

    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
    expect(flow.error).toBe("Chat route failed to load");
    expect(flow.submitting).toBe(false);

    const readSignal = flow.attachmentDraft.readSignal;
    flow.attachmentDraft.updatePending(readSignal, 1);
    expect(flow.submitBlock()?.gate).toBe("attachment-reads");
    expect(flow.canSubmit()).toBe(false);
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
    flow.attachmentDraft.updatePending(readSignal, -1);

    expect(flow.canSubmit()).toBe(true);
    await flow.submit();

    expect(context.navigateAndWait).toHaveBeenCalledTimes(2);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(flow.error).toBeNull();
  });

  it.each([
    {
      scenario: "the Gateway handshake is replaced",
      retire: ({ context }: ReturnType<typeof createDraftFixture>) => {
        const hello = context.gateway.snapshot.hello;
        if (hello) {
          context.gateway.snapshot.hello = { ...hello };
        }
      },
    },
    {
      scenario: "the Gateway client is replaced",
      retire: ({ context }: ReturnType<typeof createDraftFixture>) => {
        const client = context.gateway.snapshot.client;
        if (client) {
          context.gateway.snapshot.client = new Proxy(client, {});
        }
      },
    },
    {
      scenario: "the pending navigation is retired",
      retire: ({ flow }: ReturnType<typeof createDraftFixture>) => flow.invalidate(),
    },
  ])(
    "retires a confirmed session handoff when $scenario during session selection",
    async ({ retire }) => {
      const fixture = createDraftFixture();
      const { context, flow } = fixture;
      const sessionKey = "agent:main:dashboard:0f403cb8-3920-4cf1-8eb7-79f2f00ce488";
      vi.mocked(context.sessions.createResult).mockResolvedValue({
        key: sessionKey,
        initialRun: { status: "idle" },
      });
      // Selection publishes synchronously; a subscriber may retire the flow
      // before navigation has claimed the confirmed key.
      vi.mocked(context.gateway.setSessionKey).mockImplementation((key) => {
        context.gateway.snapshot.sessionKey = key;
        retire(fixture);
      });
      flow.setMessage("keep this task on its original connection");

      await flow.submit();

      expect(
        consumeSessionNavigationHandoff(context.gateway, "/chat/main/0f403cb8"),
      ).toBeUndefined();
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      scenario: "the user edits the draft",
      retire: ({ flow }: ReturnType<typeof createDraftFixture>) => flow.setMessage("a new task"),
    },
    {
      scenario: "the Gateway lifecycle is invalidated",
      retire: ({ flow }: ReturnType<typeof createDraftFixture>) => flow.invalidate(),
    },
    {
      scenario: "the draft attachments change",
      retire: ({ flow }: ReturnType<typeof createDraftFixture>) => flow.attachmentDraft.replace([]),
    },
    {
      scenario: "the requested session visibility changes",
      retire: ({ flow }: ReturnType<typeof createDraftFixture>) => flow.setVisibility("draft"),
    },
    {
      scenario: "the requested session capabilities change",
      retire: ({ capabilities }: ReturnType<typeof createDraftFixture>) =>
        capabilities.setToolOverrides({ skills: { release: false } }),
    },
    {
      scenario: "another session becomes selected",
      retire: ({ context }: ReturnType<typeof createDraftFixture>) => {
        context.gateway.snapshot.sessionKey = "agent:main:dashboard:elsewhere";
      },
    },
    {
      scenario: "the selected agent changes",
      retire: ({ place }: ReturnType<typeof createDraftFixture>) => place.selectAgentId("other"),
    },
    {
      scenario: "the Gateway client changes",
      retire: ({ context }: ReturnType<typeof createDraftFixture>) => {
        const client = context.gateway.snapshot.client;
        if (client) {
          context.gateway.snapshot.client = new Proxy(client, {});
        }
      },
    },
  ])("never retries a committed session after $scenario", async ({ retire }) => {
    const fixture = createDraftFixture({
      scopes: ["operator.admin", "operator.read", "operator.write"],
      agents: [
        { id: "main", workspace: "/workspace", model: { primary: "openai/test" } },
        { id: "other", workspace: "/workspace", model: { primary: "openai/test" } },
      ],
    });
    const { context, flow } = fixture;
    vi.mocked(context.sessions.createResult)
      .mockResolvedValueOnce({ key: "agent:main:dashboard:old", initialRun: { status: "idle" } })
      .mockImplementationOnce(async (params) => ({
        key: `agent:${params?.agentId ?? fixture.place.agentId}:dashboard:new`,
        initialRun: { status: "idle" },
      }));
    vi.mocked(context.navigateAndWait)
      .mockRejectedValueOnce(new Error("old navigation failed"))
      .mockImplementationOnce(async () => {
        queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
      });
    flow.setMessage("the committed task");
    await flow.submit();

    retire(fixture);
    await flow.submit();

    expect(context.sessions.createResult).toHaveBeenCalledTimes(2);
    expect(context.gateway.snapshot.sessionKey).toBe(
      `agent:${fixture.place.agentId}:dashboard:new`,
    );
    expect(context.navigateAndWait).toHaveBeenCalledTimes(2);
  });
});
