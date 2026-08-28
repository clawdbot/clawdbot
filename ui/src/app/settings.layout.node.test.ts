// @vitest-environment node
// Chat split, workspace dock, board, and sidebar layout persistence. Split from
// settings.node.test.ts to keep each file under the lint size budget.
import { describe, expect, it } from "vitest";
import { openSlot } from "../pages/chat/sidebar-layout.ts";
import {
  expectedGatewayUrl,
  installSettingsStorageLifecycle,
  setTestLocation,
} from "../test-helpers/settings-node.ts";
import { loadSettings, saveSettings } from "./settings.ts";

describe("settings layout persistence", () => {
  installSettingsStorageLifecycle();

  it("persists and parses a chat split layout", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const settings = loadSettings();
    const chatSplitLayout = {
      columns: [
        { id: "c1", panes: [{ id: "p1", sessionKey: "main" }], paneWeights: [1] },
        { id: "c2", panes: [{ id: "p2", sessionKey: "agent:main:work" }], paneWeights: [1] },
      ],
      columnWeights: [0.4, 0.6],
      activePaneId: "p2",
    };

    saveSettings({ ...settings, chatSplitLayout });

    expect(loadSettings().chatSplitLayout).toEqual(chatSplitLayout);
  });

  it("omits an invalid stored chat split layout", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({ gatewayUrl: gwUrl, chatSplitLayout: { columns: "invalid" } }),
    );

    expect(loadSettings().chatSplitLayout).toBeUndefined();
  });

  it("preserves an opted-in bottom workspace dock", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    saveSettings({ ...loadSettings(), chatWorkspaceDock: "bottom" });

    expect(loadSettings().chatWorkspaceDock).toBe("bottom");
  });

  it("persists dashboard tab and dock state per session", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const settings = loadSettings();
    const boardSessionViews = {
      "agent:main:main": {
        activeTabId: "research",
        reopenDockByTab: { research: "left" as const },
      },
    };

    saveSettings({ ...settings, boardSessionViews });

    expect(loadSettings().boardSessionViews).toEqual(boardSessionViews);
  });

  it("silently drops legacy local face while preserving per-device tab state", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({
        gatewayUrl: gwUrl,
        boardSessionViews: {
          "agent:main:main": { face: "grid", activeTabId: "research" },
        },
      }),
    );

    expect(loadSettings().boardSessionViews).toEqual({
      "agent:main:main": { activeTabId: "research" },
    });
  });

  it("persists normalized sidebar layouts per session", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example:8443", pathname: "/" });
    const settings = loadSettings();
    const sidebarSessionLayouts = {
      "agent:main:main": openSlot({ columns: [] }, "discussion"),
    };

    saveSettings({ ...settings, sidebarSessionLayouts });

    // Deep-partial match: loading also fills dock/expanded defaults, which the
    // corrupt-layout test below pins down.
    expect(loadSettings().sidebarSessionLayouts).toMatchObject(sidebarSessionLayouts);
  });

  it("normalizes corrupt stored sidebar layouts to empty columns", () => {
    setTestLocation({ protocol: "https:", host: "gateway.example:8443", pathname: "/" });
    const gwUrl = expectedGatewayUrl("");
    localStorage.setItem(
      `openclaw.control.settings.v1:${gwUrl}`,
      JSON.stringify({
        gatewayUrl: gwUrl,
        sidebarSessionLayouts: { "agent:main:main": { columns: "invalid" } },
      }),
    );

    expect(loadSettings().sidebarSessionLayouts).toEqual({
      "agent:main:main": { columns: [], open: false, expanded: false },
    });
  });
});
