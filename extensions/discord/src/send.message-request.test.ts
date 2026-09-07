import { MessageFlags, type APIMessageTopLevelComponent } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { Container, serializePayload, TextDisplay } from "./internal/discord.js";
import { buildDiscordMessageRequest } from "./send.message-request.js";

describe("buildDiscordMessageRequest", () => {
  it("enforces a supplied nonce across retries", () => {
    const body = buildDiscordMessageRequest({
      endpoint: "create-message",
      text: "hello",
      nonce: "stable-create-nonce",
    });

    expect(body).toMatchObject({
      content: "hello",
      nonce: "stable-create-nonce",
      enforce_nonce: true,
    });
  });

  it("adds a nonce for each logical create", () => {
    const body = buildDiscordMessageRequest({ endpoint: "create-message", text: "hello" });

    expect(body).toMatchObject({
      content: "hello",
      enforce_nonce: true,
    });
    expect(body.nonce).toMatch(/^[0-9a-f]{24}$/);
  });

  it("omits create-message nonce fields from forum thread starters", () => {
    const body = buildDiscordMessageRequest({ endpoint: "forum-thread", text: "hello" });

    expect(body).toEqual({ content: "hello" });
  });

  it("preserves already-serialized legacy Discord components", () => {
    const components: APIMessageTopLevelComponent[] = [
      {
        type: 1,
        components: [{ type: 2, style: 1, custom_id: "open", label: "Open" }],
      },
    ];

    expect(
      buildDiscordMessageRequest({
        endpoint: "create-message",
        text: "Choose an action",
        components,
      }),
    ).toMatchObject({ content: "Choose an action", components, enforce_nonce: true });
  });

  it("marks already-serialized Components V2 messages and omits legacy content", () => {
    const components: APIMessageTopLevelComponent[] = [
      { type: 17, components: [{ type: 10, content: "Choose an action" }] },
    ];

    const body = buildDiscordMessageRequest({
      endpoint: "create-message",
      text: "legacy fallback",
      components,
    });

    expect(body).toMatchObject({
      components,
      flags: MessageFlags.IsComponentsV2,
      enforce_nonce: true,
    });
    expect(body).not.toHaveProperty("content");
  });

  it("preserves Components V2 behavior for component builder instances", () => {
    const body = buildDiscordMessageRequest({
      endpoint: "create-message",
      text: "legacy fallback",
      components: [new Container([new TextDisplay("Choose an action")])],
    });

    expect(body).toMatchObject({
      components: [{ type: 17, components: [{ type: 10, content: "Choose an action" }] }],
      flags: MessageFlags.IsComponentsV2,
    });
    expect(body).not.toHaveProperty("content");
  });

  it.each([
    { name: "content", content: "forbidden" },
    { name: "embeds", embeds: [{ title: "forbidden" }] },
  ])("rejects legacy $name alongside raw Components V2", ({ content, embeds }) => {
    const components: APIMessageTopLevelComponent[] = [
      { type: 17, components: [{ type: 10, content: "Choose an action" }] },
    ];

    expect(() => serializePayload({ content, embeds, components })).toThrow(
      "Discord Components V2 payloads cannot include content or embeds",
    );
  });
});
