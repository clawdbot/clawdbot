// Covers Discord question delivery capture and component final edit.
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  edit: vi.fn(),
  registration: undefined as
    | { finalize: (statusLine: string) => void | Promise<void>; deliveryId: string }
    | undefined,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      registerChannelDelivery: (registration: typeof hoisted.registration) => {
        hoisted.registration = registration;
      },
    },
  };
});
vi.mock("./send.components.js", () => ({ editDiscordComponentMessage: hoisted.edit }));

import { discordOutbound } from "./outbound-adapter.js";

describe("Discord question finalization", () => {
  it("removes action rows and appends terminal status", async () => {
    await discordOutbound.afterDeliverPayload?.({
      cfg: {},
      target: { channel: "discord", to: "channel:123", accountId: "default" },
      payload: {
        channelData: {
          askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" },
          discord: {
            presentationComponents: {
              blocks: [
                { type: "text", text: "Pick one" },
                { type: "actions", buttons: [{ label: "One", internalCustomId: "q" }] },
              ],
            },
          },
        },
      },
      results: [{ channel: "discord", messageId: "55", channelId: "123" }],
    });

    await hoisted.registration?.finalize("Expired");
    expect(hoisted.edit).toHaveBeenCalledWith(
      "channel:123",
      "55",
      {
        blocks: [
          { type: "text", text: "Pick one" },
          { type: "text", text: "-# Expired" },
        ],
        modal: undefined,
      },
      { cfg: {}, accountId: "default" },
    );
  });
});
