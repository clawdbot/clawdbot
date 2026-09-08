/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderStreamGroupParts } from "./chat-message-stream.ts";

describe("assistant message embed policy", () => {
  it.each(["persisted", "streaming"] as const)(
    "applies external embed policy changes to an existing %s message",
    (surface) => {
      const host = document.createElement("div");
      const url = "https://example.test/widget";
      const text = `[embed url="${url}" title="Widget" /]\nRead the widget.`;
      const message = { role: "assistant", content: [{ type: "text", text }] };

      for (const allowed of [false, true, false]) {
        const options = { allowExternalEmbedUrls: allowed, embedSandboxMode: "scripts" as const };
        render(
          surface === "streaming"
            ? renderStreamGroupParts(
                [{ kind: "stream", key: "message", text, startedAt: 1, isStreaming: true }],
                options,
                "standalone",
              )
            : renderGroupedMessage(message, "message", {
                ...options,
                isStreaming: false,
                showReasoning: false,
              }),
          host,
        );

        const frame = host.querySelector("iframe");
        expect(frame).not.toBeNull();
        expect(frame?.getAttribute("src")).toBe(allowed ? url : null);
        expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
        expect(host.textContent).toContain("Read the widget.");
      }
    },
  );
});
