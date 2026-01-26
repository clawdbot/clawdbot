import { describe, expect, it } from "vitest";
import { parseLineDirectives, hasLineDirectives } from "./line-directives.js";

const getLineData = (result: ReturnType<typeof parseLineDirectives>) =>
  (result.channelData?.line as Record<string, unknown> | undefined) ?? {};

describe("hasLineDirectives", () => {
  it("detects quick_replies directive", () => {
    expect(hasLineDirectives("Here are options [[quick_replies: A, B, C]]")).toBe(true);
  });

  it("detects location directive", () => {
    expect(hasLineDirectives("[[location: Place | Address | 35.6 | 139.7]]")).toBe(true);
  });

  it("detects confirm directive", () => {
    expect(hasLineDirectives("[[confirm: Continue? | Yes | No]]")).toBe(true);
  });

  it("detects buttons directive", () => {
    expect(hasLineDirectives("[[buttons: Menu | Choose | Opt1:data1, Opt2:data2]]")).toBe(true);
  });

  it("returns false for regular text", () => {
    expect(hasLineDirectives("Just regular text")).toBe(false);
  });

  it("returns false for similar but invalid patterns", () => {
    expect(hasLineDirectives("[[not_a_directive: something]]")).toBe(false);
  });

  it("detects media_player directive", () => {
    expect(hasLineDirectives("[[media_player: Song | Artist | Speaker]]")).toBe(true);
  });

  it("detects event directive", () => {
    expect(hasLineDirectives("[[event: Meeting | Jan 24 | 2pm]]")).toBe(true);
  });

  it("detects agenda directive", () => {
    expect(hasLineDirectives("[[agenda: Today | Meeting:9am, Lunch:12pm]]")).toBe(true);
  });

  it("detects device directive", () => {
    expect(hasLineDirectives("[[device: TV | Room]]")).toBe(true);
  });

  it("detects appletv_remote directive", () => {
    expect(hasLineDirectives("[[appletv_remote: Apple TV | Playing]]")).toBe(true);
  });
});

describe("parseLineDirectives", () => {
  describe("quick_replies", () => {
    it("parses quick_replies and removes from text", () => {
      const result = parseLineDirectives({
        text: "Choose one:\n[[quick_replies: Option A, Option B, Option C]]",
      });

      expect(getLineData(result).quickReplies).toEqual(["Option A", "Option B", "Option C"]);
      expect(result.text).toBe("Choose one:");
    });

    it("handles quick_replies in middle of text", () => {
      const result = parseLineDirectives({
        text: "Before [[quick_replies: A, B]] After",
      });

      expect(getLineData(result).quickReplies).toEqual(["A", "B"]);
      expect(result.text).toBe("Before  After");
    });

    it("merges with existing quickReplies", () => {
      const result = parseLineDirectives({
        text: "Text [[quick_replies: C, D]]",
        channelData: { line: { quickReplies: ["A", "B"] } },
      });

      expect(getLineData(result).quickReplies).toEqual(["A", "B", "C", "D"]);
    });
  });

  describe("location", () => {
    it("parses location with all fields", () => {
      const result = parseLineDirectives({
        text: "Here's the location:\n[[location: Tokyo Station | Tokyo, Japan | 35.6812 | 139.7671]]",
      });

      expect(getLineData(result).location).toEqual({
        title: "Tokyo Station",
        address: "Tokyo, Japan",
        latitude: 35.6812,
        longitude: 139.7671,
      });
      expect(result.text).toBe("Here's the location:");
    });

    it("ignores invalid coordinates", () => {
      const result = parseLineDirectives({
        text: "[[location: Place | Address | invalid | 139.7]]",
      });

      expect(getLineData(result).location).toBeUndefined();
    });

    it("does not override existing location", () => {
      const existing = { title: "Existing", address: "Addr", latitude: 1, longitude: 2 };
      const result = parseLineDirectives({
        text: "[[location: New | New Addr | 35.6 | 139.7]]",
        channelData: { line: { location: existing } },
      });

      expect(getLineData(result).location).toEqual(existing);
    });
  });

  describe("confirm", () => {
    it("parses simple confirm", () => {
      const result = parseLineDirectives({
        text: "[[confirm: Delete this item? | Yes | No]]",
      });

      expect(getLineData(result).templateMessage).toEqual({
        type: "confirm",
        text: "Delete this item?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
        altText: "Delete this item?",
      });
      // Text is undefined when directive consumes entire text
      expect(result.text).toBeUndefined();
    });

    it("parses confirm with custom data", () => {
      const result = parseLineDirectives({
        text: "[[confirm: Proceed? | OK:action=confirm | Cancel:action=cancel]]",
      });

      expect(getLineData(result).templateMessage).toEqual({
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "OK",
        confirmData: "action=confirm",
        cancelLabel: "Cancel",
        cancelData: "action=cancel",
        altText: "Proceed?",
      });
    });
  });

  describe("buttons", () => {
    it("parses buttons with message actions", () => {
      const result = parseLineDirectives({
        text: "[[buttons: Menu | Select an option | Help:/help, Status:/status]]",
      });

      expect(getLineData(result).templateMessage).toEqual({
        type: "buttons",
        title: "Menu",
        text: "Select an option",
        actions: [
          { type: "message", label: "Help", data: "/help" },
          { type: "message", label: "Status", data: "/status" },
        ],
        altText: "Menu: Select an option",
      });
    });

    it("parses buttons with uri actions", () => {
      const result = parseLineDirectives({
        text: "[[buttons: Links | Visit us | Site:https://example.com]]",
      });

      const templateMessage = getLineData(result).templateMessage as {
        type?: string;
        actions?: Array<Record<string, unknown>>;
      };
      expect(templateMessage?.type).toBe("buttons");
      if (templateMessage?.type === "buttons") {
        expect(templateMessage.actions?.[0]).toEqual({
          type: "uri",
          label: "Site",
          uri: "https://example.com",
        });
      }
    });

    it("parses buttons with postback actions", () => {
      const result = parseLineDirectives({
        text: "[[buttons: Actions | Choose | Select:action=select&id=1]]",
      });

      const templateMessage = getLineData(result).templateMessage as {
        type?: string;
        actions?: Array<Record<string, unknown>>;
      };
      expect(templateMessage?.type).toBe("buttons");
      if (templateMessage?.type === "buttons") {
        expect(templateMessage.actions?.[0]).toEqual({
          type: "postback",
          label: "Select",
          data: "action=select&id=1",
        });
      }
    });

    it("limits to 4 actions", () => {
      const result = parseLineDirectives({
        text: "[[buttons: Menu | Text | A:a, B:b, C:c, D:d, E:e, F:f]]",
      });

      const templateMessage = getLineData(result).templateMessage as {
        type?: string;
        actions?: Array<Record<string, unknown>>;
      };
      expect(templateMessage?.type).toBe("buttons");
      if (templateMessage?.type === "buttons") {
        expect(templateMessage.actions?.length).toBe(4);
      }
    });
  });

  describe("media_player", () => {
    it("parses media_player with all fields", () => {
      const result = parseLineDirectives({
        text: "Now playing:\n[[media_player: Bohemian Rhapsody | Queen | Speaker | https://example.com/album.jpg | playing]]",
      });

      const flexMessage = getLineData(result).flexMessage as {
        altText?: string;
        contents?: { footer?: { contents?: unknown[] } };
      };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("🎵 Bohemian Rhapsody - Queen");
      const contents = flexMessage?.contents as { footer?: { contents?: unknown[] } };
      expect(contents.footer?.contents?.length).toBeGreaterThan(0);
      expect(result.text).toBe("Now playing:");
    });

    it("parses media_player with minimal fields", () => {
      const result = parseLineDirectives({
        text: "[[media_player: Unknown Track]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("🎵 Unknown Track");
    });

    it("handles paused status", () => {
      const result = parseLineDirectives({
        text: "[[media_player: Song | Artist | Player | | paused]]",
      });

      const flexMessage = getLineData(result).flexMessage as {
        contents?: { body: { contents: unknown[] } };
      };
      expect(flexMessage).toBeDefined();
      const contents = flexMessage?.contents as { body: { contents: unknown[] } };
      expect(contents).toBeDefined();
    });
  });

  describe("event", () => {
    it("parses event with all fields", () => {
      const result = parseLineDirectives({
        text: "[[event: Team Meeting | January 24, 2026 | 2:00 PM - 3:00 PM | Conference Room A | Discuss Q1 roadmap]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📅 Team Meeting - January 24, 2026 2:00 PM - 3:00 PM");
    });

    it("parses event with minimal fields", () => {
      const result = parseLineDirectives({
        text: "[[event: Birthday Party | March 15]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📅 Birthday Party - March 15");
    });
  });

  describe("agenda", () => {
    it("parses agenda with multiple events", () => {
      const result = parseLineDirectives({
        text: "[[agenda: Today's Schedule | Team Meeting:9:00 AM, Lunch:12:00 PM, Review:3:00 PM]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📋 Today's Schedule (3 events)");
    });

    it("parses agenda with events without times", () => {
      const result = parseLineDirectives({
        text: "[[agenda: Tasks | Buy groceries, Call mom, Workout]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📋 Tasks (3 events)");
    });
  });

  describe("device", () => {
    it("parses device with controls", () => {
      const result = parseLineDirectives({
        text: "[[device: TV | Streaming Box | Playing | Play/Pause:toggle, Menu:menu]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📱 TV: Playing");
    });

    it("parses device with minimal fields", () => {
      const result = parseLineDirectives({
        text: "[[device: Speaker]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toBe("📱 Speaker");
    });
  });

  describe("appletv_remote", () => {
    it("parses appletv_remote with status", () => {
      const result = parseLineDirectives({
        text: "[[appletv_remote: Apple TV | Playing]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
      expect(flexMessage?.altText).toContain("Apple TV");
    });

    it("parses appletv_remote with minimal fields", () => {
      const result = parseLineDirectives({
        text: "[[appletv_remote: Apple TV]]",
      });

      const flexMessage = getLineData(result).flexMessage as { altText?: string };
      expect(flexMessage).toBeDefined();
    });
  });

  describe("combined directives", () => {
    it("handles text with no directives", () => {
      const result = parseLineDirectives({
        text: "Just plain text here",
      });

      expect(result.text).toBe("Just plain text here");
      expect(getLineData(result).quickReplies).toBeUndefined();
      expect(getLineData(result).location).toBeUndefined();
      expect(getLineData(result).templateMessage).toBeUndefined();
    });

    it("preserves other payload fields", () => {
      const result = parseLineDirectives({
        text: "Hello [[quick_replies: A, B]]",
        mediaUrl: "https://example.com/image.jpg",
        replyToId: "msg123",
      });

      expect(result.mediaUrl).toBe("https://example.com/image.jpg");
      expect(result.replyToId).toBe("msg123");
      expect(getLineData(result).quickReplies).toEqual(["A", "B"]);
    });
  });
});
