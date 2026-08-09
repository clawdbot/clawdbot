/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";

afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
});

describe("chat composer steering queue", () => {
  it.each([
    { sendState: "steering" as const, sendRunId: "send-1" },
    { pendingRunId: "run-1", sendRunId: "send-1" },
  ])("renders one Steering badge for an in-flight or acknowledged steer", (steerState) => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatQueue({
        queue: [
          {
            id: "steer-1",
            text: "change course",
            createdAt: 1,
            kind: "steered",
            ...steerState,
          },
        ],
        onQueueRemove: vi.fn(),
      }),
      container,
    );

    const badges = container.querySelectorAll(".chat-queue__badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent?.trim()).toBe(t("chat.queue.states.steering"));
  });
});
