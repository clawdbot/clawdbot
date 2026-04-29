import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultMenuConfig,
  createGridLayout,
  datetimePickerAction,
  messageAction,
  postbackAction,
  uploadRichMenuImage,
  uriAction,
} from "./rich-menu.js";

const { setRichMenuImageMock, MessagingApiBlobClientMock } = vi.hoisted(() => {
  const setRichMenuImageMock = vi.fn();
  const MessagingApiBlobClientMock = vi.fn(function () {
    return { setRichMenuImage: setRichMenuImageMock };
  });
  return { setRichMenuImageMock, MessagingApiBlobClientMock };
});

vi.mock("@line/bot-sdk", () => ({
  messagingApi: { MessagingApiBlobClient: MessagingApiBlobClientMock },
}));

describe("messageAction", () => {
  it("creates message actions with explicit or default text", () => {
    const cases = [
      { name: "explicit text", label: "Help", text: "/help", expectedText: "/help" },
      { name: "defaults to label", label: "Click", text: undefined, expectedText: "Click" },
    ] as const;
    for (const testCase of cases) {
      const action = testCase.text
        ? messageAction(testCase.label, testCase.text)
        : messageAction(testCase.label);
      expect(action.type, testCase.name).toBe("message");
      expect(action.label, testCase.name).toBe(testCase.label);
      expect((action as { text: string }).text, testCase.name).toBe(testCase.expectedText);
    }
  });
});

describe("uriAction", () => {
  it("creates a URI action", () => {
    const action = uriAction("Open", "https://example.com");

    expect(action.type).toBe("uri");
    expect(action.label).toBe("Open");
    expect((action as { uri: string }).uri).toBe("https://example.com");
  });
});

describe("action label truncation", () => {
  it.each([
    {
      createAction: () => messageAction("This is a very long label text"),
      expectedLabel: "This is a very long ",
    },
    {
      createAction: () => uriAction("Click here to visit our website", "https://example.com"),
      expectedLabel: "Click here to visit ",
    },
  ])("truncates labels to 20 characters", ({ createAction, expectedLabel }) => {
    const action = createAction();
    expect(action.label).toBe(expectedLabel);
    expect((action.label ?? "").length).toBe(20);
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

  it("applies postback payload truncation and displayText behavior", () => {
    const truncatedData = postbackAction("Test", "x".repeat(400));
    expect((truncatedData as { data: string }).data.length).toBe(300);

    const truncatedDisplay = postbackAction("Test", "data", "y".repeat(400));
    expect((truncatedDisplay as { displayText: string }).displayText?.length).toBe(300);

    const noDisplayText = postbackAction("Test", "data");
    expect((noDisplayText as { displayText?: string }).displayText).toBeUndefined();
  });
});

describe("datetimePickerAction", () => {
  it("creates picker actions for all supported modes", () => {
    const cases = [
      { label: "Pick date", data: "date_picked", mode: "date" as const },
      { label: "Pick time", data: "time_picked", mode: "time" as const },
      { label: "Pick datetime", data: "datetime_picked", mode: "datetime" as const },
    ];
    for (const testCase of cases) {
      const action = datetimePickerAction(testCase.label, testCase.data, testCase.mode);
      expect(action.type).toBe("datetimepicker");
      expect(action.label).toBe(testCase.label);
      expect((action as { mode: string }).mode).toBe(testCase.mode);
      expect((action as { data: string }).data).toBe(testCase.data);
    }
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
  function createSixSimpleActions() {
    return [
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
  }

  it("computes expected 2x3 layout for supported menu heights", () => {
    const actions = createSixSimpleActions();
    const cases = [
      { height: 1686, firstRowY: 0, secondRowY: 843, rowHeight: 843 },
      { height: 843, firstRowY: 0, secondRowY: 421, rowHeight: 421 },
    ] as const;
    for (const testCase of cases) {
      const areas = createGridLayout(testCase.height, actions);
      expect(areas.length).toBe(6);
      expect(areas[0]?.bounds.y).toBe(testCase.firstRowY);
      expect(areas[0]?.bounds.height).toBe(testCase.rowHeight);
      expect(areas[3]?.bounds.y).toBe(testCase.secondRowY);
      expect(areas[0]?.bounds.x).toBe(0);
      expect(areas[1]?.bounds.x).toBe(833);
      expect(areas[2]?.bounds.x).toBe(1666);
    }
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

  it("uses message actions with expected default commands", () => {
    const config = createDefaultMenuConfig();

    for (const area of config.areas) {
      expect(area.action.type).toBe("message");
    }
    const commands = config.areas.map((a) => (a.action as { text: string }).text);
    expect(commands).toContain("/help");
    expect(commands).toContain("/status");
    expect(commands).toContain("/settings");
  });
});

const richMenuUploadCfg: OpenClawConfig = {
  channels: {
    line: {
      channelAccessToken: "line-token",
      channelSecret: "line-secret",
    },
  },
};

describe("uploadRichMenuImage", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-rich-menu-"));
    setRichMenuImageMock.mockReset();
    MessagingApiBlobClientMock.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("loads local image paths through approved media localRoots", async () => {
    const workspaceDir = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const imagePath = path.join(workspaceDir, "menu.png");
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    await fs.writeFile(imagePath, imageBytes);

    await uploadRichMenuImage("rich-menu-1", imagePath, {
      cfg: richMenuUploadCfg,
      mediaLocalRoots: [workspaceDir],
    });

    expect(MessagingApiBlobClientMock).toHaveBeenCalledWith({ channelAccessToken: "line-token" });
    expect(setRichMenuImageMock).toHaveBeenCalledOnce();
    const [richMenuId, blob] = setRichMenuImageMock.mock.calls[0] ?? [];
    expect(richMenuId).toBe("rich-menu-1");
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe("image/png");
    await expect((blob as Blob).arrayBuffer()).resolves.toEqual(
      imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
    );
  });

  it("rejects local image paths outside approved media localRoots before uploading", async () => {
    const workspaceDir = path.join(tempRoot, "workspace");
    const outsideDir = path.join(tempRoot, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideImagePath = path.join(outsideDir, "menu.jpg");
    await fs.writeFile(outsideImagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    await expect(
      uploadRichMenuImage("rich-menu-1", outsideImagePath, {
        cfg: richMenuUploadCfg,
        mediaLocalRoots: [workspaceDir],
      }),
    ).rejects.toThrow(/Local media path is not under an allowed directory/i);

    expect(setRichMenuImageMock).not.toHaveBeenCalled();
  });

  it("preserves extension-based content-type fallback for approved local paths", async () => {
    const workspaceDir = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const imagePath = path.join(workspaceDir, "menu.jpg");
    const imageBytes = Buffer.from("placeholder image bytes");
    await fs.writeFile(imagePath, imageBytes);

    await uploadRichMenuImage("rich-menu-2", imagePath, {
      cfg: richMenuUploadCfg,
      mediaLocalRoots: [workspaceDir],
    });

    expect(setRichMenuImageMock).toHaveBeenCalledOnce();
    const blob = setRichMenuImageMock.mock.calls[0]?.[1] as Blob;
    expect(blob.type).toBe("image/jpeg");
    await expect(blob.arrayBuffer()).resolves.toEqual(
      imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
    );
  });
});
