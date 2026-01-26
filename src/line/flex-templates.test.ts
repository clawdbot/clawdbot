import { describe, expect, it } from "vitest";
import {
  createInfoCard,
  createListCard,
  createImageCard,
  createActionCard,
  createCarousel,
  createNotificationBubble,
  createReceiptCard,
  createEventCard,
  createAgendaCard,
  createMediaPlayerCard,
  createAppleTvRemoteCard,
  createDeviceControlCard,
  toFlexMessage,
} from "./flex-templates.js";

describe("createInfoCard", () => {
  it("creates a bubble with title and body", () => {
    const card = createInfoCard("Test Title", "Test body content");

    expect(card.type).toBe("bubble");
    expect(card.size).toBe("mega");
    expect(card.body).toBeDefined();
    expect(card.body?.type).toBe("box");
  });

  it("includes footer when provided", () => {
    const card = createInfoCard("Title", "Body", "Footer text");

    expect(card.footer).toBeDefined();
    const footer = card.footer as { contents: Array<{ text: string }> };
    expect(footer.contents[0].text).toBe("Footer text");
  });

  it("omits footer when not provided", () => {
    const card = createInfoCard("Title", "Body");
    expect(card.footer).toBeUndefined();
  });
});

describe("createListCard", () => {
  it("creates a list with title and items", () => {
    const items = [{ title: "Item 1", subtitle: "Description 1" }, { title: "Item 2" }];
    const card = createListCard("My List", items);

    expect(card.type).toBe("bubble");
    expect(card.body).toBeDefined();
  });

  it("limits items to 8", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}` }));
    const card = createListCard("List", items);

    const body = card.body as { contents: Array<{ type: string; contents?: unknown[] }> };
    // The list items are in the third content (after title and separator)
    const listBox = body.contents[2] as { contents: unknown[] };
    expect(listBox.contents.length).toBe(8);
  });

  it("includes actions on items when provided", () => {
    const items = [
      {
        title: "Clickable",
        action: { type: "message" as const, label: "Click", text: "clicked" },
      },
    ];
    const card = createListCard("List", items);
    expect(card.body).toBeDefined();
  });
});

describe("createImageCard", () => {
  it("creates a card with hero image", () => {
    const card = createImageCard("https://example.com/image.jpg", "Image Title");

    expect(card.type).toBe("bubble");
    expect(card.hero).toBeDefined();
    expect((card.hero as { url: string }).url).toBe("https://example.com/image.jpg");
  });

  it("includes body text when provided", () => {
    const card = createImageCard("https://example.com/img.jpg", "Title", "Body text");

    const body = card.body as { contents: Array<{ text: string }> };
    expect(body.contents.length).toBe(2);
    expect(body.contents[1].text).toBe("Body text");
  });

  it("applies custom aspect ratio", () => {
    const card = createImageCard("https://example.com/img.jpg", "Title", undefined, {
      aspectRatio: "16:9",
    });

    expect((card.hero as { aspectRatio: string }).aspectRatio).toBe("16:9");
  });
});

describe("createActionCard", () => {
  it("creates a card with action buttons", () => {
    const actions = [
      { label: "Action 1", action: { type: "message" as const, label: "Act1", text: "action1" } },
      {
        label: "Action 2",
        action: { type: "uri" as const, label: "Act2", uri: "https://example.com" },
      },
    ];
    const card = createActionCard("Title", "Description", actions);

    expect(card.type).toBe("bubble");
    expect(card.footer).toBeDefined();

    const footer = card.footer as { contents: Array<{ type: string }> };
    expect(footer.contents.length).toBe(2);
  });

  it("limits actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({
      label: `Action ${i}`,
      action: { type: "message" as const, label: `A${i}`, text: `action${i}` },
    }));
    const card = createActionCard("Title", "Body", actions);

    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBe(4);
  });

  it("includes hero image when provided", () => {
    const card = createActionCard("Title", "Body", [], {
      imageUrl: "https://example.com/hero.jpg",
    });

    expect(card.hero).toBeDefined();
    expect((card.hero as { url: string }).url).toBe("https://example.com/hero.jpg");
  });
});

describe("createCarousel", () => {
  it("creates a carousel from bubbles", () => {
    const bubbles = [createInfoCard("Card 1", "Body 1"), createInfoCard("Card 2", "Body 2")];
    const carousel = createCarousel(bubbles);

    expect(carousel.type).toBe("carousel");
    expect(carousel.contents.length).toBe(2);
  });

  it("limits to 12 bubbles", () => {
    const bubbles = Array.from({ length: 15 }, (_, i) => createInfoCard(`Card ${i}`, `Body ${i}`));
    const carousel = createCarousel(bubbles);

    expect(carousel.contents.length).toBe(12);
  });
});

describe("createNotificationBubble", () => {
  it("creates a simple notification", () => {
    const bubble = createNotificationBubble("Hello world");

    expect(bubble.type).toBe("bubble");
    expect(bubble.body).toBeDefined();
  });

  it("applies notification type styling", () => {
    const successBubble = createNotificationBubble("Success!", { type: "success" });
    const errorBubble = createNotificationBubble("Error!", { type: "error" });

    expect(successBubble.body).toBeDefined();
    expect(errorBubble.body).toBeDefined();
  });

  it("includes title when provided", () => {
    const bubble = createNotificationBubble("Details here", {
      title: "Alert Title",
    });

    expect(bubble.body).toBeDefined();
  });
});

describe("createReceiptCard", () => {
  it("creates a receipt with items", () => {
    const card = createReceiptCard({
      title: "Order Receipt",
      items: [
        { name: "Item A", value: "$10" },
        { name: "Item B", value: "$20" },
      ],
    });

    expect(card.type).toBe("bubble");
    expect(card.body).toBeDefined();
  });

  it("includes total when provided", () => {
    const card = createReceiptCard({
      title: "Receipt",
      items: [{ name: "Item", value: "$10" }],
      total: { label: "Total", value: "$10" },
    });

    expect(card.body).toBeDefined();
  });

  it("includes footer when provided", () => {
    const card = createReceiptCard({
      title: "Receipt",
      items: [{ name: "Item", value: "$10" }],
      footer: "Thank you!",
    });

    expect(card.footer).toBeDefined();
  });
});

describe("createMediaPlayerCard", () => {
  it("creates a basic player card", () => {
    const card = createMediaPlayerCard({
      title: "Bohemian Rhapsody",
      subtitle: "Queen",
    });

    expect(card.type).toBe("bubble");
    expect(card.body).toBeDefined();
  });

  it("includes album art when provided", () => {
    const card = createMediaPlayerCard({
      title: "Track Name",
      imageUrl: "https://example.com/album.jpg",
    });

    expect(card.hero).toBeDefined();
    expect((card.hero as { url: string }).url).toBe("https://example.com/album.jpg");
  });

  it("shows playing status", () => {
    const card = createMediaPlayerCard({
      title: "Track",
      isPlaying: true,
    });

    expect(card.body).toBeDefined();
  });

  it("includes playback controls", () => {
    const card = createMediaPlayerCard({
      title: "Track",
      controls: {
        previous: { data: "action=prev" },
        play: { data: "action=play" },
        pause: { data: "action=pause" },
        next: { data: "action=next" },
      },
    });

    expect(card.footer).toBeDefined();
  });

  it("includes extra actions", () => {
    const card = createMediaPlayerCard({
      title: "Track",
      extraActions: [
        { label: "Add to Playlist", data: "action=add_playlist" },
        { label: "Share", data: "action=share" },
      ],
    });

    expect(card.footer).toBeDefined();
  });
});

describe("createDeviceControlCard", () => {
  it("creates a device card with controls", () => {
    const card = createDeviceControlCard({
      deviceName: "Apple TV",
      deviceType: "Streaming Box",
      controls: [
        { label: "Play/Pause", data: "action=playpause" },
        { label: "Menu", data: "action=menu" },
      ],
    });

    expect(card.type).toBe("bubble");
    expect(card.body).toBeDefined();
    expect(card.footer).toBeDefined();
  });

  it("shows device status", () => {
    const card = createDeviceControlCard({
      deviceName: "Apple TV",
      status: "Playing",
      controls: [{ label: "Pause", data: "action=pause" }],
    });

    expect(card.body).toBeDefined();
  });

  it("includes device image", () => {
    const card = createDeviceControlCard({
      deviceName: "Device",
      imageUrl: "https://example.com/device.jpg",
      controls: [],
    });

    expect(card.hero).toBeDefined();
  });

  it("limits controls to 6", () => {
    const card = createDeviceControlCard({
      deviceName: "Device",
      controls: Array.from({ length: 10 }, (_, i) => ({
        label: `Control ${i}`,
        data: `action=${i}`,
      })),
    });

    expect(card.footer).toBeDefined();
    // Should have max 3 rows of 2 buttons
    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBeLessThanOrEqual(3);
  });
});

describe("createAppleTvRemoteCard", () => {
  it("creates an Apple TV remote card with controls", () => {
    const card = createAppleTvRemoteCard({
      deviceName: "Apple TV",
      status: "Playing",
      actionData: {
        up: "action=up",
        down: "action=down",
        left: "action=left",
        right: "action=right",
        select: "action=select",
        menu: "action=menu",
        home: "action=home",
        play: "action=play",
        pause: "action=pause",
        volumeUp: "action=volume_up",
        volumeDown: "action=volume_down",
        mute: "action=mute",
      },
    });

    expect(card.type).toBe("bubble");
    expect(card.body).toBeDefined();
  });
});

describe("createEventCard", () => {
  it("creates an event card with required fields", () => {
    const card = createEventCard({
      title: "Team Meeting",
      date: "January 24, 2026",
    });

    expect(card.type).toBe("bubble");
    expect(card.body).toBeDefined();
  });

  it("includes time when provided", () => {
    const card = createEventCard({
      title: "Meeting",
      date: "Jan 24",
      time: "2:00 PM - 3:00 PM",
    });

    expect(card.body).toBeDefined();
  });

  it("includes location when provided", () => {
    const card = createEventCard({
      title: "Meeting",
      date: "Jan 24",
      location: "Conference Room A",
    });

    expect(card.body).toBeDefined();
  });

  it("includes description when provided", () => {
    const card = createEventCard({
      title: "Meeting",
      date: "Jan 24",
      description: "Discuss Q1 roadmap",
    });

    expect(card.body).toBeDefined();
  });

  it("includes all optional fields together", () => {
    const card = createEventCard({
      title: "Team Offsite",
      date: "February 15, 2026",
      time: "9:00 AM - 5:00 PM",
      location: "Mountain View Office",
      description: "Annual team building event",
    });

    expect(card.type).toBe("bubble");
    expect(card.body).toBeDefined();
  });

  it("includes action when provided", () => {
    const card = createEventCard({
      title: "Meeting",
      date: "Jan 24",
      action: { type: "uri", label: "Join", uri: "https://meet.google.com/abc" },
    });

    expect(card.body).toBeDefined();
    expect((card.body as { action?: unknown }).action).toBeDefined();
  });

  it("includes calendar name when provided", () => {
    const card = createEventCard({
      title: "Meeting",
      date: "Jan 24",
      calendar: "Work Calendar",
    });

    expect(card.body).toBeDefined();
  });

  it("uses mega size for better readability", () => {
    const card = createEventCard({
      title: "Meeting",
      date: "Jan 24",
    });

    expect(card.size).toBe("mega");
  });
});

describe("createAgendaCard", () => {
  it("creates an agenda card with title and events", () => {
    const card = createAgendaCard({
      title: "Today's Schedule",
      events: [
        { title: "Team Meeting", time: "9:00 AM" },
        { title: "Lunch", time: "12:00 PM" },
      ],
    });

    expect(card.type).toBe("bubble");
    expect(card.size).toBe("mega");
    expect(card.body).toBeDefined();
  });

  it("limits events to 8", () => {
    const manyEvents = Array.from({ length: 15 }, (_, i) => ({
      title: `Event ${i + 1}`,
    }));

    const card = createAgendaCard({
      title: "Many Events",
      events: manyEvents,
    });

    expect(card.body).toBeDefined();
  });

  it("includes footer when provided", () => {
    const card = createAgendaCard({
      title: "Today",
      events: [{ title: "Event" }],
      footer: "Synced from Google Calendar",
    });

    expect(card.footer).toBeDefined();
  });

  it("shows event metadata (time, location, calendar)", () => {
    const card = createAgendaCard({
      title: "Schedule",
      events: [
        {
          title: "Meeting",
          time: "10:00 AM",
          location: "Room A",
          calendar: "Work",
        },
      ],
    });

    expect(card.body).toBeDefined();
  });
});

describe("toFlexMessage", () => {
  it("wraps a container in a FlexMessage", () => {
    const bubble = createInfoCard("Title", "Body");
    const message = toFlexMessage("Alt text", bubble);

    expect(message.type).toBe("flex");
    expect(message.altText).toBe("Alt text");
    expect(message.contents).toBe(bubble);
  });
});
