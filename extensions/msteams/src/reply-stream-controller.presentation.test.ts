// Msteams tests cover what a native stream leaves for block delivery when a reply also
// carries portable controls.
import { describe, expect, it } from "vitest";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";
import {
  makeAcknowledgedStream,
  makeContext,
  makeController,
  makeStream,
} from "./reply-stream-controller.test-helpers.js";

describe("createTeamsReplyStreamController presentation remainders", () => {
  it("keeps a replaced reply's controls after the stream acknowledged its text", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open run", value: "open" }] }],
    };

    ctrl.onPartialReply({ text: "abcde" });
    stream.acknowledge("abcde");
    ctrl.onPartialReply({ text: "abXYZ" });
    expect(ctrl.preparePayload({ text: "abcdef", presentation })).toBeUndefined();

    // The replacement carries the text, so the deferred entry is subtracted the same way
    // a suppressed final is: dropping it whole took the controls with the text.
    await expect(ctrl.finalize()).resolves.toMatchObject({
      postNativePayloads: [{ text: undefined, presentation }],
    });
  });

  it("does not repeat the replaced prose when a replacement leaves text undelivered", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });
    const buttons = {
      type: "buttons" as const,
      buttons: [{ label: "Open run", value: "open" }],
    };

    ctrl.onPartialReply({ text: "Deploy summary" });
    stream.acknowledge("Deploy summary");
    ctrl.onPartialReply({ text: "Deploy XYZ" });
    expect(
      ctrl.preparePayload({
        text: "Deploy summary and more",
        presentationTextMode: "fallback",
        presentation: { blocks: [{ type: "text" as const, text: "Deploy summary" }, buttons] },
      }),
    ).toBeUndefined();
    stream.close.mockResolvedValueOnce(undefined);

    // Re-attaching the undelivered text to the whole payload would build a card out of
    // the prose the stream just showed - and the card would swallow that text, because a
    // card message carries its text as a delivery record, not as activity text.
    await expect(ctrl.finalize()).resolves.toMatchObject({
      postNativePayloads: [{ text: " and more", presentation: { blocks: [buttons] } }],
    });
  });

  it("strips text but keeps the controls a reply offers when text was streamed", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "streamed" });
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open run", value: "open" }] }],
    };

    // The stream carries text only. Dropping the whole payload here dropped the
    // buttons with it, so a streamed reply reached Teams without its controls.
    expect(ctrl.preparePayload({ text: "streamed", presentation })).toEqual({
      text: undefined,
      presentation,
    });
  });

  it("drops a streamed reply's presentation when its text already rendered it", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "Runs by region: EU 12, US 9" });

    // "fallback" text is the prose rendering of the whole presentation, so a table-only
    // presentation carries nothing the stream did not already deliver. Sending it anyway
    // restates the table under the answer the user just read.
    expect(
      ctrl.preparePayload({
        text: "Runs by region: EU 12, US 9",
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            {
              type: "table" as const,
              caption: "Runs by region",
              headers: ["Region", "Runs"],
              rows: [
                ["EU", "12"],
                ["US", "9"],
              ],
            },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it("leaves only the controls when a streamed reply's text was the fallback prose", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    const buttons = {
      type: "buttons" as const,
      buttons: [{ label: "Open run", value: "open" }],
    };
    // The shape ask_user produces: the question and its option list as text blocks, then
    // the buttons, with the payload text holding the prose rendering of all three.
    const presentation = {
      title: "Deploy",
      blocks: [{ type: "text" as const, text: "Which region?" }, buttons],
    };
    ctrl.onPartialReply({ text: "Deploy\n\nWhich region?\n\n- Open run" });

    // Prose cannot carry a control the channel renders natively, so the buttons remain -
    // but the text blocks and the title were in the prose the stream just delivered.
    expect(
      ctrl.preparePayload({
        text: "Deploy\n\nWhich region?\n\n- Open run",
        presentationTextMode: "fallback",
        presentation,
      }),
    ).toEqual({ text: undefined, presentation: { blocks: [buttons] } });
  });

  it("drops a streamed reply's select, which Teams renders as the prose it just sent", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "Which region?\n\nOptions\n- EU\n- US" });

    // Teams declares selects: false, so a select degrades to a text list - and in fallback
    // mode that list is part of the prose the stream already delivered.
    expect(
      ctrl.preparePayload({
        text: "Which region?\n\nOptions\n- EU\n- US",
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            {
              type: "select" as const,
              placeholder: "Options",
              options: [
                { label: "EU", value: "eu" },
                { label: "US", value: "us" },
              ],
            },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it("keeps a progress-mode reply's controls after the stream takes its text", () => {
    const stream = makeStream();
    const ctrl = createTeamsReplyStreamController({
      allowProviderPreview: true,
      conversationType: "personal",
      context: makeContext(stream),
      feedbackLoopEnabled: false,
      msteamsConfig: { streaming: { mode: "progress" } } as never,
    });
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open run", value: "open" }] }],
    };

    // Progress mode emits the final text into the stream instead of streaming tokens,
    // so it suppresses the payload for the same reason - and must keep the same remainder.
    expect(ctrl.preparePayload({ text: "Deploy finished", presentation })).toEqual({
      text: undefined,
      presentation,
    });
    expect(stream.emit).toHaveBeenCalledWith("Deploy finished");
  });

  it("does not redraw the acknowledged prose as a card after a stream failure", () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });
    const buttons = {
      type: "buttons" as const,
      buttons: [{ label: "Open run", value: "open" }],
    };

    ctrl.onPartialReply({ text: "Deploy summary" });
    stream.acknowledge("Deploy summary");
    stream.emit.mockImplementation(() => {
      throw new Error("network failure");
    });
    ctrl.onPartialReply({ text: "Deploy summary extended" });

    // This is the third path that subtracts already-delivered text, and it subtracts
    // the same way: the prose Teams acknowledged does not come back inside a card.
    expect(
      ctrl.preparePayload({
        text: "Deploy summary and its options",
        presentationTextMode: "fallback",
        presentation: { blocks: [{ type: "text" as const, text: "Deploy summary" }, buttons] },
      }),
    ).toEqual({ text: " and its options", presentation: { blocks: [buttons] } });
  });

  it("does not repeat controls the remainder already delivered when close produces nothing", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open run", value: "open" }] }],
    };

    ctrl.onPartialReply({ text: "hello there" });
    stream.acknowledge("hello");
    expect(ctrl.preparePayload({ text: "hello there", presentation })).toEqual({
      text: undefined,
      presentation,
    });
    stream.close.mockResolvedValueOnce(undefined);

    // The remainder already carried the controls to block delivery, so the fallback
    // that covers the unacknowledged text must not send them a second time.
    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: "hello",
      messageId: "stream-acknowledged",
      fallbackPayload: { text: " there" },
    });
  });
});
