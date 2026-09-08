import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  dispatchOpenAiTalkEvent,
  installOpenAiTalkFixture,
  videoTalkCatalog,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser Talk transcript ordering",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

suite.define(() => {
  it("renders and saves overlapping replies beside their delayed user transcripts", async () => {
    const artifactDir = createControlUiE2eArtifactDir("transcript-ordering");
    await suite.withPage(
      {
        permissions: ["microphone"],
        viewport: { width: 1366, height: 900 },
        recordVideo: { dir: artifactDir, size: { width: 1366, height: 900 } },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "talk.catalog": videoTalkCatalog("openai"),
            "talk.client.create": {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-ordering-e2e",
              clientSecret: "test-client-secret",
            },
          },
        });
        await installOpenAiTalkFixture(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByRole("button", { name: "Start voice input" }).click();
        await gateway.waitForRequest("talk.client.create");
        await expect
          .poll(() =>
            page.evaluate(() =>
              Boolean(
                (
                  window as Window & {
                    openclawVideoTalkE2e?: { peer: { remoteDescription: unknown } };
                  }
                ).openclawVideoTalkE2e?.peer.remoteDescription,
              ),
            ),
          )
          .toBe(true);
        await page.evaluate(() => {
          (
            window as Window & {
              openclawVideoTalkE2e?: { peer: { channel: EventTarget } };
            }
          ).openclawVideoTalkE2e?.peer.channel.dispatchEvent(new Event("open"));
        });
        const rows = page.locator(".agent-chat__voice-turn-text");
        const emit = async (event: unknown) => await dispatchOpenAiTalkEvent(page, event);
        const item = async (id: string, role: "user" | "assistant", previous: string | null) =>
          await emit({
            type: "conversation.item.added",
            previous_item_id: previous,
            item: {
              id,
              type: "message",
              role,
              content: role === "user" ? [{ type: "input_audio" }] : [],
            },
          });
        const final = async (id: string, role: "user" | "assistant", transcript: string) =>
          await emit({
            type:
              role === "user"
                ? "conversation.item.input_audio_transcription.completed"
                : "response.output_audio_transcript.done",
            item_id: id,
            transcript,
          });
        await item("answer-2", "assistant", "question-2");
        await emit({
          type: "response.output_audio_transcript.delta",
          item_id: "answer-2",
          delta: "Lantern.",
        });
        await expect.poll(() => rows.allTextContents()).toEqual(["Lantern."]);
        await writeFile(
          path.join(artifactDir, "unresolved-order.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [rows.first()]),
        );
        await final("answer-2", "assistant", "Lantern.");
        await emit({
          type: "input_audio_buffer.committed",
          item_id: "question-1",
          previous_item_id: null,
        });
        await item("question-1", "user", null);
        await item("answer-1", "assistant", "question-1");
        await emit({
          type: "response.output_audio_transcript.delta",
          item_id: "answer-1",
          delta: "Glacier.",
        });
        await expect.poll(() => rows.allTextContents()).toEqual(["Glacier.", "Lantern."]);
        await writeFile(
          path.join(artifactDir, "streaming.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [rows.first()]),
        );
        await item("question-2", "user", "answer-1");
        await final("question-2", "user", "Please say lantern.");
        await final("answer-1", "assistant", "Glacier.");
        expect(await gateway.getRequests("talk.client.transcript")).toEqual([]);
        await final("question-1", "user", "Please say glacier.");
        await expect
          .poll(() =>
            gateway
              .getRequests("talk.client.transcript")
              .then((requests) => requests.map(({ params }) => params)),
          )
          .toEqual([
            expect.objectContaining({ role: "user", text: "Please say glacier." }),
            expect.objectContaining({ role: "assistant", text: "Glacier." }),
            expect.objectContaining({ role: "user", text: "Please say lantern." }),
            expect.objectContaining({ role: "assistant", text: "Lantern." }),
          ]);
        try {
          await expect
            .poll(() => rows.allTextContents())
            .toEqual(["Please say glacier.", "Glacier.", "Please say lantern.", "Lantern."]);
        } finally {
          await writeFile(
            path.join(artifactDir, "final-order.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [rows.first()]),
          );
        }
        await page.getByRole("button", { name: "Stop voice input" }).click();
        await gateway.waitForRequest("talk.client.close");
        expect(await gateway.getRequests("talk.client.close")).toHaveLength(1);
      },
    );
  });
});
