/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";

afterEach(() => document.body.replaceChildren());

it("expands accepted base64 video through the shared media overlay", () => {
  const source = "data:video/mp4;base64,AAAA";
  const container = document.body.appendChild(document.createElement("div"));
  const onOpenImage = vi.fn();
  const onOpenSidebar = vi.fn();
  render(
    renderAssistantAttachments(
      [
        {
          type: "attachment",
          attachment: {
            kind: "video",
            label: "inline.mp4",
            mimeType: "video/mp4",
            url: source,
          },
        },
      ],
      { onOpenImage },
      onOpenSidebar,
    ),
    container,
  );

  const player = container.querySelector("openclaw-chat-video-player") as HTMLElement & {
    onExpand: (src: string) => void;
  };
  expect(player).toMatchObject({
    label: "inline.mp4",
    mimeType: "video/mp4",
    sourceIdentity: source,
    src: source,
  });
  expect(container.querySelector(".chat-assistant-attachment-card--compact")).toBeNull();
  player.onExpand(source);
  expect(onOpenImage).toHaveBeenCalledWith({
    kind: "video",
    originalSrc: source,
    src: source,
    title: "inline.mp4",
  });
  expect(onOpenSidebar).not.toHaveBeenCalled();
});
