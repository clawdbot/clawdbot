import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it } from "vitest";
import { drainDiscordDraftDeleteCustody } from "../draft-delete-custody.js";
import { resetDiscordDraftDeleteCustodyForTest } from "../draft-delete-custody.test-support.js";
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
  beforeEach(() => {
    resetDiscordDraftDeleteCustodyForTest();
  });

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

  it("hands repeated delete failures to account custody and removes them on the next turn", async () => {
    let deleteFailures = 2;
    const visibleMessages = new Map<string, string>();
    let createdCount = 0;
    const rest = new RequestClient("test-token", {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (init?.method === "POST") {
          const id = `preview-${++createdCount}`;
          visibleMessages.set(id, "orphaned progress");
          return Response.json({ id });
        }
        if (init?.method === "DELETE") {
          const id = url.pathname.split("/").at(-1)!;
          if (deleteFailures > 0) {
            deleteFailures -= 1;
            return Response.json({ message: "temporarily unavailable" }, { status: 503 });
          }
          visibleMessages.delete(id);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected Discord request: ${init?.method} ${url.pathname}`);
      },
    });
    const firstTurn = createPreviewController(rest);

    firstTurn.draftStream?.update("orphaned progress");
    await firstTurn.flush();
    firstTurn.markFinalReplyStarted();
    firstTurn.markFinalReplyDelivered(false);
    // Two transient DELETE failures exhaust the per-turn retry; the preview
    // stays visible while the controller terminates.
    await firstTurn.cleanup();

    expect([...visibleMessages]).toEqual([["preview-1", "orphaned progress"]]);

    const nextTurn = createPreviewController(rest);
    await nextTurn.cleanup();
    // Turn completion schedules account recovery without awaiting it; settle
    // the serialized drain to observe the deletion.
    await drainDiscordDraftDeleteCustody("default");

    expect([...visibleMessages]).toEqual([]);
  });

  it("keeps intentional error-final retention out of custody", async () => {
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
    const firstTurn = createPreviewController(rest);

    firstTurn.draftStream?.update("retained progress");
    await firstTurn.flush();
    firstTurn.markFinalReplyStarted();
    firstTurn.markFinalReplyDelivered(true);
    await firstTurn.cleanup();

    const nextTurn = createPreviewController(rest);
    await nextTurn.cleanup();

    expect(requests).not.toContain("DELETE /channels/c1/messages/preview-error");
  });
});
