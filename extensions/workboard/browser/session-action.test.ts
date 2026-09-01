import { afterEach, expect, it, vi } from "vitest";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { createGatewaySession, createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { createWorkboardSessionAction } from "./session-action.ts";
import { workboardTestHost } from "./test/host.setup.ts";

const capabilities: ReturnType<typeof createWorkboardCapability>[] = [];
afterEach(() => {
  for (const capability of capabilities.splice(0)) {
    capability.dispose();
  }
});

function fixture() {
  const { host, connection } = workboardTestHost();
  connection.connected = true;
  const workboard = createWorkboardCapability();
  capabilities.push(workboard);
  workboard.state.loaded = true;
  const session = createGatewaySession();
  const action = createWorkboardSessionAction(host, workboard, "session");
  const context = { sessionKey: session.key, session, host, signal: host.signal };
  return { host, connection, workboard, action, context };
}

it("projects capture, existing-card, busy and permission states from the plugin owner", () => {
  const { action, context, workboard, connection } = fixture();
  expect(action.resolve?.(context)).toEqual({
    label: "Add to Workboard",
    disabled: false,
    hidden: false,
  });
  workboard.state.cards = [createWorkboardCard({ sessionKey: context.sessionKey })];
  expect(action.resolve?.(context)?.label).toBe("Open Workboard card");
  workboard.state.capturingSessionKeys.add(context.sessionKey);
  expect(action.resolve?.(context)?.disabled).toBe(true);
  connection.canWrite = false;
  expect(action.resolve?.(context)?.hidden).toBe(true);
  connection.canWrite = true;
  expect(
    action.resolve?.({ ...context, session: { ...context.session, kind: "global" } })?.hidden,
  ).toBe(true);
});

it("captures the supplied row even outside the host's loaded session subset", async () => {
  const { action, context, host, workboard } = fixture();
  const card = createWorkboardCard({
    sessionKey: context.sessionKey,
    metadata: { automation: { boardId: "ops" } },
  });
  const request = vi.fn(async (method: string) =>
    method === "chat.history" ? { messages: [] } : { card },
  );
  host.request = request as typeof host.request;
  expect(host.sessions.rows).toEqual([]);
  await action.run(context);
  expect(request).toHaveBeenCalledWith(
    "workboard.cards.captureSession",
    expect.objectContaining({ sessionKey: context.sessionKey, title: context.session.displayName }),
  );
  expect(workboard.state.detailCardId).toBe(card.id);
  expect(host.navigation.openPage).toHaveBeenCalledWith({
    id: "workboard",
    path: ["ops"],
  });
  expect(workboard.state.capturingSessionKeys.size).toBe(0);
});

it("opens an existing card without creating a duplicate", async () => {
  const { action, context, host, workboard } = fixture();
  workboard.state.cards = [createWorkboardCard({ sessionKey: context.sessionKey })];
  await action.run(context);
  expect(host.request).not.toHaveBeenCalled();
  expect(host.navigation.openPage).toHaveBeenCalledOnce();
});

it("restores an archived session card before opening it", async () => {
  const { action, context, host, workboard } = fixture();
  const card = createWorkboardCard({ sessionKey: context.sessionKey });
  workboard.state.cards = [{ ...card, metadata: { archivedAt: 1 } }];
  const request = vi.fn(async () => ({ card }));
  host.request = request as typeof host.request;
  expect(action.resolve?.(context)?.label).toBe("Add to Workboard");
  await action.run(context);
  expect(request).toHaveBeenCalledWith("workboard.cards.archive", { id: card.id, archived: false });
  expect(action.resolve?.(context)?.label).toBe("Open Workboard card");
  expect(host.navigation.openPage).toHaveBeenCalledOnce();
});

it("does not navigate when the source action is disposed while capture is pending", async () => {
  const { action, context, host } = fixture();
  const pending = Promise.withResolvers<unknown>();
  const request = vi.fn(async (method: string) =>
    method === "chat.history" ? { messages: [] } : pending.promise,
  );
  host.request = request as typeof host.request;
  const abort = new AbortController();
  const result = Promise.resolve(action.run({ ...context, signal: abort.signal }));
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("workboard.cards.captureSession", expect.anything()),
  );
  expect(action.resolve?.(context)?.disabled).toBe(true);
  abort.abort();
  pending.resolve({ card: createWorkboardCard({ sessionKey: context.sessionKey }) });
  await expect(result).rejects.toThrow();
  expect(host.navigation.openPage).not.toHaveBeenCalled();
});
