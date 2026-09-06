import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { RequestClient } from "../internal/discord.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";

function createPreviewController(
  rest: RequestClient,
  mode: "partial" | "block" | "progress" = "progress",
) {
  return createDiscordDraftPreviewController({
    cfg: {},
    discordConfig: { streaming: { mode, progress: { label: false, toolProgress: true } } },
    accountId: "default",
    sourceRepliesAreToolOnly: false,
    textLimit: 2_000,
    deliveryRest: rest,
    deliverChannelId: "c1",
    replyReference: { peek: () => undefined },
    tableMode: "off",
    maxLinesPerMessage: undefined,
    chunkMode: "length",
    log: () => {},
  });
}

describe("Discord draft preview REST lifecycle", () => {
  it.each(["partial", "block", "progress"] as const)(
    "publishes and retracts a short complete plan, then resumes in %s mode",
    async (mode) => {
      const visible = new Map<string, string>();
      let nextId = 0;
      const rest = new RequestClient("test-token", {
        queueRequests: false,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          const id = url.pathname.split("/").at(-1)!;
          if (init?.method === "DELETE") {
            visible.delete(id);
            return new Response(null, { status: 204 });
          }
          if (typeof init?.body !== "string") {
            throw new Error("Expected a serialized Discord message");
          }
          const body = JSON.parse(init.body) as { content: string };
          const messageId = init.method === "POST" ? `preview-${++nextId}` : id;
          visible.set(messageId, body.content);
          return Response.json({ id: messageId });
        },
      });
      const controller = createPreviewController(rest, mode);

      await controller.pushPlanProgress([]);
      expect(visible.size).toBe(0);
      await controller.pushPlanProgress([{ step: "Check", status: "in_progress" }]);
      await controller.flush();
      expect([...visible.values()]).toEqual(["▸ Check"]);
      await controller.pushPlanProgress([], { explanation: "Progress updated" });
      await controller.flush();
      expect([...visible.values()]).toEqual(["Progress updated"]);
      await controller.pushPlanProgress([]);
      expect(visible.size).toBe(0);
      await controller.pushPlanProgress([{ step: "Retry", status: "pending" }]);
      await controller.flush();
      expect([...visible.values()]).toEqual(["▢ Retry"]);
      controller.handleAssistantMessageBoundary();
      await controller.pushItemEvent({
        itemId: "card-rejected",
        kind: "tool",
        name: "progress_card",
        phase: "end",
        status: "blocked",
        meta: '<progress aria-label="private detail"></progress>',
      });
      controller.handleAssistantMessageBoundary();
      await controller.pushToolEvent({ toolCallId: "exec-1", name: "exec", phase: "start" });
      await controller.flush();
      expect(visible.size).toBe(1);
      const withActivity = [...visible.values()][0];
      expect(withActivity).toContain("▢ Retry");
      expect(withActivity).toContain("blocked");
      expect(withActivity).toContain("Exec");
      expect(withActivity).not.toContain("private detail");
      controller.handleAssistantMessageBoundary();
      await controller.pushPlanProgress([]);
      await controller.flush();
      expect(visible.size).toBe(1);
      const afterClear = [...visible.values()][0];
      expect(afterClear).not.toContain("Retry");
      expect(afterClear).toContain("blocked");
      expect(afterClear).toContain("Exec");
      await controller.cleanup();
    },
  );

  it("retains the progress draft after an error final is delivered", async () => {
    const requests: string[] = [];
    const rest = new RequestClient("test-token", {
      queueRequests: false,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        requests.push(`${init?.method ?? "GET"} ${url.pathname.replace("/api/v10", "")}`);
        if (init?.method === "POST") {
          return Response.json({ id: "preview-error" });
        }
        return new Response(null, { status: 204 });
      },
    });
    const controller = createPreviewController(rest);

    controller.draftStream?.update("🛠️ Exec: failed");
    await controller.flush();
    controller.markFinalReplyStarted();
    controller.markFinalReplyDelivered(true);
    controller.draftStream?.update("stale pending update");
    await controller.cleanup();
    await controller.flush();

    expect(requests).toEqual(["POST /channels/c1/messages"]);
  });

  it.each([
    ["queued admission", 0],
    ["queued admission", 1],
    ["teardown", 0],
    ["teardown", 1],
    ["teardown", 2],
  ] as const)(
    "removes a late preview after %s (%i delete failures)",
    async (boundary, deleteFailures) => {
      const firstCreateStarted = createDeferred<void>();
      const finishFirstCreate = createDeferred<void>();
      const visibleMessages = new Map<string, string>();
      const deletedIds: string[] = [];
      let createdCount = 0;
      const rest = new RequestClient("test-token", {
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (init?.method === "POST") {
            const id = `preview-${++createdCount}`;
            if (typeof init.body !== "string") {
              throw new Error("Expected a serialized Discord JSON request body");
            }
            const body = JSON.parse(init.body) as { content: string };
            visibleMessages.set(id, body.content);
            if (createdCount === 1) {
              firstCreateStarted.resolve();
              await finishFirstCreate.promise;
            }
            return Response.json({ id });
          }
          if (init?.method === "DELETE") {
            const id = url.pathname.split("/").at(-1)!;
            deletedIds.push(id);
            if (deletedIds.length <= deleteFailures) {
              return Response.json({ message: "temporarily unavailable" }, { status: 503 });
            }
            visibleMessages.delete(id);
            return new Response(null, { status: 204 });
          }
          throw new Error(`Unexpected Discord request: ${init?.method} ${url.pathname}`);
        },
      });
      const controller = createPreviewController(rest);

      controller.draftStream?.update("prior turn progress");
      await firstCreateStarted.promise;
      if (boundary === "queued admission") {
        controller.handleQueuedFollowupAdmitted();
        controller.draftStream?.update("queued turn progress");
        finishFirstCreate.resolve();
        await controller.flush();

        expect(controller.draftStream?.messageId()).toBe("preview-2");
        expect(visibleMessages.get("preview-2")).toBe("queued turn progress");
        controller.markFinalReplyStarted();
        controller.markFinalReplyDelivered(false);
        await controller.cleanup();
      } else {
        const cleanup = controller.cleanup();
        finishFirstCreate.resolve();
        await cleanup;
      }

      if (deleteFailures === 2) {
        expect(deletedIds).toEqual(["preview-1", "preview-1"]);
        expect([...visibleMessages]).toEqual([["preview-1", "prior turn progress"]]);
        await controller.cleanup();
      }
      expect([...visibleMessages]).toEqual([]);
      expect(deletedIds.filter((id) => id === "preview-1")).toHaveLength(deleteFailures + 1);
    },
  );
});
