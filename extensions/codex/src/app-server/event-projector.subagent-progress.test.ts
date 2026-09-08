import { createChannelProgressDraftCompositor } from "openclaw/plugin-sdk/channel-outbound";
import {
  createParams,
  createProjector,
  expect,
  forCurrentTurn,
  it,
  registerCodexEventProjectorTestLifecycle,
  vi,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

it.each([false, true])(
  "projects native subagent activity under toolProgress=%s",
  async (toolProgress) => {
    const update = vi.fn((_text: string) => true);
    const progress = createChannelProgressDraftCompositor({
      active: true,
      mode: "progress",
      entry: { streaming: { mode: "progress", progress: { toolProgress } } },
      seed: "subagent-progress",
      update,
    });
    const events: Array<Record<string, unknown>> = [];
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent: async (event) => {
        if (event.stream === "item") {
          events.push(event.data);
          await progress.pushItemEvent(event.data);
        }
      },
    });
    try {
      for (const kind of ["started", "interrupted", "completed", "interacted"]) {
        const item = {
          id: `activity-${kind}`,
          type: "subAgentActivity",
          kind,
          agentThreadId: "child-thread",
          agentPath: "/root/research",
        };
        await projector.handleNotification(forCurrentTurn("item/started", { item }));
        await projector.handleNotification(forCurrentTurn("item/completed", { item }));
        await progress.start();
        const latest = events.at(-1);
        expect(latest).toMatchObject({
          status: kind === "interrupted" ? "failed" : kind === "started" ? "running" : "completed",
        });
        expect(progress.getSnapshot().lines).toHaveLength(
          toolProgress ? (kind === "interacted" ? 2 : 1) : kind === "interrupted" ? 1 : 0,
        );
        expect(update.mock.lastCall?.[0]).toContain("Working");
        if (toolProgress) {
          expect(update.mock.lastCall?.[0]).toContain("research");
          expect(update.mock.lastCall?.[0]).toContain(
            kind === "interacted" ? "message sent" : kind,
          );
        }
      }
      expect(new Set(events.slice(0, -1).map((event) => event.itemId)).size).toBe(1);
      expect(events.at(-1)?.itemId).not.toBe(events[0]?.itemId);
    } finally {
      progress.cancel();
    }
  },
);

it("projects native collaboration calls without exposing their prompts", async () => {
  const onAgentEvent = vi.fn();
  const projector = await createProjector({ ...(await createParams()), onAgentEvent });
  const item = {
    id: "spawn-1",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "inProgress",
    senderThreadId: "thread-1",
    receiverThreadIds: ["child-thread"],
    prompt: "Private delegation instructions",
    agentsStates: {},
  };
  await projector.handleNotification(forCurrentTurn("item/started", { item }));
  expect(onAgentEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      stream: "item",
      data: expect.objectContaining({ status: "running", name: "subagents" }),
    }),
  );
  await projector.handleNotification(
    forCurrentTurn("item/completed", { item: { ...item, status: "failed" } }),
  );
  expect(onAgentEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      stream: "item",
      data: expect.objectContaining({ status: "failed", name: "subagents" }),
    }),
  );
  expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain(item.prompt);
});
