import { describe, expect, it } from "vitest";
import { RequestClient } from "../internal/discord.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";

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
    const controller = createDiscordDraftPreviewController({
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

    controller.draftStream?.update("🛠️ Exec: failed");
    await controller.flush();
    controller.markFinalReplyStarted();
    controller.markFinalReplyDelivered(true);
    controller.draftStream?.update("stale pending update");
    await controller.cleanup();
    await controller.flush();

    expect(requests).toEqual(["POST /channels/c1/messages"]);
  });
});
