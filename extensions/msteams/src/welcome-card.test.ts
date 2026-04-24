import { describe, expect, it } from "vitest";
import { buildMSTeamsPresentationCard } from "./presentation.js";
import { buildGroupWelcomeText, buildWelcomeCard } from "./welcome-card.js";

describe("buildMSTeamsPresentationCard", () => {
  it("preserves message text when rendering presentation controls", () => {
    expect(
      buildMSTeamsPresentationCard({
        text: "Deploy finished",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open", value: "open" }],
            },
          ],
        },
      }),
    ).toEqual({
      type: "AdaptiveCard",
      version: "1.4",
      body: [{ type: "TextBlock", text: "Deploy finished", wrap: true }],
      actions: [{ type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } }],
    });
  });
});

describe("buildWelcomeCard", () => {
  it("builds card with default prompt starters", () => {
    const card = buildWelcomeCard();
    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.5");

    const body = card.body as Array<{ text: string }>;
    expect(body[0]?.text).toContain("OpenClaw");

    const actions = card.actions as Array<{ title: string; data: unknown }>;
    expect(actions.length).toBe(3);
    expect(actions[0]?.title).toBe("What can you do?");
  });

  it("uses custom bot name", () => {
    const card = buildWelcomeCard({ botName: "TestBot" });
    const body = card.body as Array<{ text: string }>;
    expect(body[0]?.text).toContain("TestBot");
  });

  it("uses custom prompt starters", () => {
    const card = buildWelcomeCard({
      promptStarters: ["Do X", "Do Y"],
    });
    const actions = card.actions as Array<{ title: string; data: unknown }>;
    expect(actions.length).toBe(2);
    expect(actions[0]?.title).toBe("Do X");
    expect(actions[1]?.title).toBe("Do Y");

    // Verify imBack data
    const data = actions[0]?.data as { msteams: { type: string; value: string } };
    expect(data.msteams.type).toBe("imBack");
    expect(data.msteams.value).toBe("Do X");
  });

  it("falls back to defaults when promptStarters is empty", () => {
    const card = buildWelcomeCard({ promptStarters: [] });
    const actions = card.actions as Array<{ title: string }>;
    expect(actions.length).toBe(3);
  });
});

describe("buildGroupWelcomeText", () => {
  it("includes bot name", () => {
    const text = buildGroupWelcomeText("MyBot");
    expect(text).toContain("MyBot");
    expect(text).toContain("@MyBot");
  });

  it("defaults to OpenClaw", () => {
    const text = buildGroupWelcomeText();
    expect(text).toContain("OpenClaw");
  });
});
