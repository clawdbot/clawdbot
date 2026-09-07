import { render } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each([
  { metadata: { classification: "subagent" as const }, hideAvatars: true },
  { metadata: { spawnedBy: "agent:main:parent" }, hideAvatars: false },
])(
  "uses session identity for author avatars when metadata arrives: %j",
  async ({ metadata, hideAvatars }) => {
    const props = threadProps(
      "spawn-metadata",
      "agent:main:dashboard:01234567-89ab-cdef-0123-456789abcdef",
      [
        { role: "user", content: "Inspect the workspace", timestamp: 1_000 },
        { role: "assistant", content: "Workspace inspected", timestamp: 2_000 },
      ],
    );
    props.userId = "viewer";
    props.userName = "Example User";
    const row: GatewaySessionRow = {
      key: props.sessionKey,
      kind: "direct",
      updatedAt: 1_000,
      parentSessionKey: "agent:main:parent",
    };
    props.selectedSession = row;
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = async () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
      await flushDeferredRowPrune();
    };
    await rerender();
    transcript.hostConnected();
    // Navigation ancestry alone also describes human-created forks.
    expect(container.querySelector(".chat-avatar.user")).not.toBeNull();
    props.selectedSession = { ...row, ...metadata };
    await rerender();
    if (hideAvatars) {
      expect(container.querySelector(".chat-avatar, .chat-author-avatar")).toBeNull();
    } else {
      expect(container.querySelector(".chat-avatar.user")).not.toBeNull();
    }
    expect(container.querySelector(".chat-sender-name")?.textContent).toContain("Example User");
    expect(container.textContent).toContain("Workspace inspected");
    transcript.hostDisconnected();
  },
);

it("hides avatars for a subagent key before its session row loads", async () => {
  const props = threadProps("spawn-key", "agent:main:subagent:child");
  props.userId = "viewer";
  props.userName = "Example User";
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  render(renderChatThread(props, transcript), container);
  transcript.hostUpdated();
  transcript.hostConnected();
  await flushDeferredRowPrune();
  expect(container.querySelectorAll(".chat-group").length).toBeGreaterThan(0);
  expect(container.querySelector(".chat-avatar, .chat-author-avatar")).toBeNull();
  expect(container.querySelector(".chat-sender-name")?.textContent).toContain("Example User");
  transcript.hostDisconnected();
});
