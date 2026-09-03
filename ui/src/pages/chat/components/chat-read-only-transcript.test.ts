/* @vitest-environment jsdom */

import { nothing } from "lit";
import { expect, it, vi } from "vitest";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

const renderChatThread = vi.fn(
  (_props: ChatThreadProps, _transcript: ChatTranscriptController) => nothing,
);

vi.mock("./chat-thread.ts", () => ({ renderChatThread }));

const { renderReadOnlyTranscript } = await import("./chat-read-only-transcript.ts");

it("forwards identity routing so task transcripts link peer authors like the live thread", () => {
  const personActivity = { basePath: "", navigate: vi.fn() };
  renderReadOnlyTranscript({
    chat: { personActivity, userId: "me" } as unknown as ChatThreadProps,
    messages: [],
    paneId: "pane-1",
    sessionKey: "agent:main:task",
    transcript: {} as ChatTranscriptController,
  });

  expect(renderChatThread).toHaveBeenCalledTimes(1);
  expect(renderChatThread.mock.calls[0]?.[0].personActivity).toBe(personActivity);
});
