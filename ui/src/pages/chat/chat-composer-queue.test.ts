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
  it("keeps an acknowledged steer pending until transcript history confirms it", () => {
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
            pendingRunId: "run-1",
            sendRunId: "send-1",
          },
        ],
        onQueueRemove: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector(".chat-queue__badge--steered")?.textContent?.trim()).toBe(
      t("chat.queue.states.steering"),
    );
  });
});
