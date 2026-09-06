import { describe, expect, it } from "vitest";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.js";

describe("chat display tool-result detail projection", () => {
  it.each([
    [
      {
        targetId: "tab-1",
        target: "host",
        profile: "work",
        url: "https://example.com",
        title: "Example",
        extra: "drop",
      },
      {
        targetId: "tab-1",
        target: "host",
        profile: "work",
        url: "https://example.com",
        title: "Example",
      },
    ],
    [
      {
        targetId: "x".repeat(128),
        target: "node",
        profile: "p".repeat(128),
        node: "n".repeat(256),
        url: "u".repeat(2047) + "😀",
        title: "t".repeat(511) + "😀",
      },
      {
        targetId: "x".repeat(128),
        target: "node",
        profile: "p".repeat(128),
        node: "n".repeat(256),
        url: "u".repeat(2047),
        title: "t".repeat(511),
      },
    ],
    [
      { targetId: "tab-1", target: "host", profile: "work", url: 42, title: [] },
      { targetId: "tab-1", target: "host", profile: "work" },
    ],
    ...[
      null,
      [],
      "tab-1",
      {},
      { targetId: "tab-1" },
      { targetId: "tab-1", target: "sandbox", profile: "work" },
      { targetId: "tab-1", target: "node", profile: "work" },
      { targetId: "tab-1", target: "host", profile: "work", node: "node-1" },
      ...["targetId", "profile", "node"].flatMap((key) =>
        [undefined, 1, "", "  ", " padded ", "x".repeat(key === "node" ? 257 : 129)].map(
          (value) => ({
            targetId: "tab-1",
            target: "node",
            profile: "work",
            node: "node-1",
            [key]: value,
          }),
        ),
      ),
    ].map((invalid) => [invalid, undefined] as const),
  ] as const)(
    "projects only bounded browser tab descriptor fields (%j)",
    (browserTab, expected) => {
      const result = { type: "toolResult", toolName: "browser", details: { browserTab } };
      const [standalone, nested] = sanitizeChatHistoryMessages([
        { role: "toolResult", ...result },
        { role: "assistant", content: [result] },
      ]) as Array<Record<string, unknown>>;
      const block = (nested?.content as Array<Record<string, unknown>> | undefined)?.[0];
      for (const projected of [standalone, block]) {
        expect(projected?.details).toEqual(expected ? { browserTab: expected } : undefined);
      }
    },
  );

  it("omits opaque provider replay state from display history", () => {
    const [message] = sanitizeChatHistoryMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "visible" }],
        providerReplay: {
          type: "openai-responses-compaction",
          data: "opaque-display-compaction",
        },
      },
    ]) as Array<Record<string, unknown>>;

    expect(message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
    });
    expect(message).not.toHaveProperty("providerReplay");
    expect(JSON.stringify(message)).not.toContain("opaque-display-compaction");
  });

  it("keeps authoritative write booleans and strips unrelated details", () => {
    const [overwrite, created, invalid] = sanitizeChatHistoryMessages([
      {
        role: "toolResult",
        toolCallId: "write-1",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: true, created: false, diff: "-1 old\n+1 new", private: "drop" },
      },
      {
        role: "toolResult",
        toolCallId: "write-2",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: true, created: true },
      },
      {
        role: "toolResult",
        toolCallId: "write-3",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: "true", created: 1 },
      },
    ]) as Array<Record<string, unknown>>;

    expect(overwrite?.details).toEqual({
      changed: true,
      created: false,
      diff: "-1 old\n+1 new",
    });
    expect(created?.details).toEqual({ changed: true, created: true });
    expect(invalid).not.toHaveProperty("details");
  });
});
