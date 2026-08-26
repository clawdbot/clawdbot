import { describe, expect, it } from "vitest";
import { RequestClient } from "../internal/discord.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";

function createPreviewController(rest: RequestClient) {
  return createDiscordDraftPreviewController({
    cfg: {},
    discordConfig: { streaming: { mode: "progress" } },
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

  it.each([false, true])(
    "removes a late prior-turn preview at teardown (first delete fails: %s)",
    async (failFirstDelete) => {
      const firstCreateStarted = Promise.withResolvers<void>();
      const finishFirstCreate = Promise.withResolvers<void>();
      const visibleMessages = new Map<string, string>();
      const deletedIds: string[] = [];
      let createdCount = 0;
      const rest = new RequestClient("test-token", {
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (init?.method === "POST") {
            const id = `preview-${++createdCount}`;
            if (createdCount === 1) {
              firstCreateStarted.resolve();
              await finishFirstCreate.promise;
            }
            if (typeof init.body !== "string") {
              throw new Error("Expected a serialized Discord JSON request body");
            }
            const body = JSON.parse(init.body) as { content: string };
            visibleMessages.set(id, body.content);
            return Response.json({ id });
          }
          if (init?.method === "DELETE") {
            const id = url.pathname.split("/").at(-1)!;
            deletedIds.push(id);
            if (failFirstDelete && deletedIds.length === 1) {
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
      controller.handleQueuedFollowupAdmitted();
      controller.draftStream?.update("queued turn progress");
      finishFirstCreate.resolve();
      await controller.flush();

      expect(controller.draftStream?.messageId()).toBe("preview-2");
      expect(visibleMessages.get("preview-2")).toBe("queued turn progress");
      controller.markFinalReplyStarted();
      controller.markFinalReplyDelivered(false);
      await controller.cleanup();

      expect([...visibleMessages]).toEqual([]);
      expect(deletedIds.filter((id) => id === "preview-1")).toHaveLength(failFirstDelete ? 2 : 1);
    },
  );
});
