import { describe, expect, it } from "vitest";
import {
  createGridLayout,
  messageAction,
  uriAction,
  postbackAction,
  datetimePickerAction,
  createDefaultMenuConfig,
} from "./rich-menu.js";

describe("messageAction", () => {
  it("creates a message action", () => {
    const action = messageAction("Help", "/help");

    expect(action.type).toBe("message");
    expect(action.label).toBe("Help");
    expect((action as { text: string }).text).toBe("/help");
  });

  it("uses label as text when text not provided", () => {
    const action = messageAction("Click");

    expect((action as { text: string }).text).toBe("Click");
  });

  it("truncates label to 20 characters", () => {
    const action = messageAction("This is a very long label text");

    expect(action.label.length).toBe(20);
    expect(action.label).toBe("This is a very long ");
  });
});

describe("uriAction", () => {
  it("creates a URI action", () => {
    const action = uriAction("Open", "https://example.com");

    expect(action.type).toBe("uri");
    expect(action.label).toBe("Open");
    expect((action as { uri: string }).uri).toBe("https://example.com");
  });

  it("truncates label to 20 characters", () => {
    const action = uriAction("Click here to visit our website", "https://example.com");

    expect(action.label.length).toBe(20);
  });
});

describe("postbackAction", () => {
  it("creates a postback action", () => {
    const action = postbackAction("Select", "action=select&item=1", "Selected item 1");

    expect(action.type).toBe("postback");
    expect(action.label).toBe("Select");
    expect((action as { data: string }).data).toBe("action=select&item=1");
    expect((action as { displayText: string }).displayText).toBe("Selected item 1");
  });

  it("truncates data to 300 characters", () => {
    const longData = "x".repeat(400);
    const action = postbackAction("Test", longData);

    expect((action as { data: string }).data.length).toBe(300);
  });

  it("truncates displayText to 300 characters", () => {
    const longText = "y".repeat(400);
    const action = postbackAction("Test", "data", longText);

    expect((action as { displayText: string }).displayText?.length).toBe(300);
  });

  it("omits displayText when not provided", () => {
    const action = postbackAction("Test", "data");

    expect((action as { displayText?: string }).displayText).toBeUndefined();
  });
});

describe("datetimePickerAction", () => {
  it("creates a date picker action", () => {
    const action = datetimePickerAction("Pick date", "date_picked", "date");

    expect(action.type).toBe("datetimepicker");
    expect(action.label).toBe("Pick date");
    expect((action as { mode: string }).mode).toBe("date");
    expect((action as { data: string }).data).toBe("date_picked");
  });

  it("creates a time picker action", () => {
    const action = datetimePickerAction("Pick time", "time_picked", "time");

    expect((action as { mode: string }).mode).toBe("time");
  });

  it("creates a datetime picker action", () => {
    const action = datetimePickerAction("Pick datetime", "datetime_picked", "datetime");

    expect((action as { mode: string }).mode).toBe("datetime");
  });

  it("includes initial/min/max when provided", () => {
    const action = datetimePickerAction("Pick", "data", "date", {
      initial: "2024-06-15",
      min: "2024-01-01",
      max: "2024-12-31",
    });

    expect((action as { initial: string }).initial).toBe("2024-06-15");
    expect((action as { min: string }).min).toBe("2024-01-01");
    expect((action as { max: string }).max).toBe("2024-12-31");
  });
});

describe("createGridLayout", () => {
  it("creates a 2x3 grid layout for tall menu", () => {
    const actions = [
      messageAction("A1"),
      messageAction("A2"),
      messageAction("A3"),
      messageAction("A4"),
      messageAction("A5"),
      messageAction("A6"),
    ] as [
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
    ];

    const areas = createGridLayout(1686, actions);

    expect(areas.length).toBe(6);

    // Check first row positions
    expect(areas[0].bounds.x).toBe(0);
    expect(areas[0].bounds.y).toBe(0);
    expect(areas[1].bounds.x).toBe(833);
    expect(areas[1].bounds.y).toBe(0);
    expect(areas[2].bounds.x).toBe(1666);
    expect(areas[2].bounds.y).toBe(0);

    // Check second row positions
    expect(areas[3].bounds.y).toBe(843);
    expect(areas[4].bounds.y).toBe(843);
    expect(areas[5].bounds.y).toBe(843);
  });

  it("creates a 2x3 grid layout for short menu", () => {
    const actions = [
      messageAction("A1"),
      messageAction("A2"),
      messageAction("A3"),
      messageAction("A4"),
      messageAction("A5"),
      messageAction("A6"),
    ] as [
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
    ];

    const areas = createGridLayout(843, actions);

    expect(areas.length).toBe(6);

    // Row height should be half of 843
    expect(areas[0].bounds.height).toBe(421);
    expect(areas[3].bounds.y).toBe(421);
  });

  it("assigns correct actions to areas", () => {
    const actions = [
      messageAction("Help", "/help"),
      messageAction("Status", "/status"),
      messageAction("Settings", "/settings"),
      messageAction("About", "/about"),
      messageAction("Feedback", "/feedback"),
      messageAction("Contact", "/contact"),
    ] as [
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
      ReturnType<typeof messageAction>,
    ];

    const areas = createGridLayout(843, actions);

    expect((areas[0].action as { text: string }).text).toBe("/help");
    expect((areas[1].action as { text: string }).text).toBe("/status");
    expect((areas[2].action as { text: string }).text).toBe("/settings");
    expect((areas[3].action as { text: string }).text).toBe("/about");
    expect((areas[4].action as { text: string }).text).toBe("/feedback");
    expect((areas[5].action as { text: string }).text).toBe("/contact");
  });
});

describe("createDefaultMenuConfig", () => {
  it("creates a valid default menu configuration", () => {
    const config = createDefaultMenuConfig();

    expect(config.size.width).toBe(2500);
    expect(config.size.height).toBe(843);
    expect(config.selected).toBe(false);
    expect(config.name).toBe("Default Menu");
    expect(config.chatBarText).toBe("Menu");
    expect(config.areas.length).toBe(6);
  });

  it("has valid area bounds", () => {
    const config = createDefaultMenuConfig();

    for (const area of config.areas) {
      expect(area.bounds.x).toBeGreaterThanOrEqual(0);
      expect(area.bounds.y).toBeGreaterThanOrEqual(0);
      expect(area.bounds.width).toBeGreaterThan(0);
      expect(area.bounds.height).toBeGreaterThan(0);
      expect(area.bounds.x + area.bounds.width).toBeLessThanOrEqual(2500);
      expect(area.bounds.y + area.bounds.height).toBeLessThanOrEqual(843);
    }
  });

  it("has message actions for all areas", () => {
    const config = createDefaultMenuConfig();

    for (const area of config.areas) {
      expect(area.action.type).toBe("message");
    }
  });

  it("has expected default commands", () => {
    const config = createDefaultMenuConfig();

    const commands = config.areas.map((a) => (a.action as { text: string }).text);
    expect(commands).toContain("/help");
    expect(commands).toContain("/status");
    expect(commands).toContain("/settings");
  });
});
