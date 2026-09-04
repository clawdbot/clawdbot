import { describe, expect, it, vi } from "vitest";
import {
  installRemoteProfileTestLifecycle,
  loadRemoteProfileTestDeps,
  type RemoteProfileTestDeps,
} from "./server-context.remote-profile-tab-ops.test-helpers.js";

const deps: RemoteProfileTestDeps = await loadRemoteProfileTestDeps();
installRemoteProfileTestLifecycle(deps);

function mockExtensionPage(): void {
  vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
    listPagesViaPlaywright: vi.fn(async () => [
      {
        targetId: "TARGET-41",
        title: "Extension test",
        url: "https://example.com/login",
        type: "page",
      },
    ]),
  } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);
}

function createExtensionProfile() {
  const state = deps.makeState("openclaw");
  state.resolved.defaultProfile = "chrome";
  state.resolved.profiles.chrome = {
    cdpUrl: "http://127.0.0.1:18799",
    cdpPort: 18799,
    color: "#FF4500",
    driver: "extension",
  };
  return deps
    .createTestBrowserRouteContext({
      getState: () => state,
    })
    .forProfile("chrome");
}

describe("browser extension profile tab ops", () => {
  it("exposes the native WebExtension tab id with its matching CDP target", async () => {
    mockExtensionPage();
    globalThis.fetch = vi.fn(async () =>
      Response.json([
        {
          id: "TARGET-41",
          tabId: 41,
          title: "Extension test",
          url: "https://example.com/login",
          type: "page",
        },
      ]),
    );
    const extension = createExtensionProfile();

    await expect(extension.listTabs()).resolves.toEqual([
      expect.objectContaining({
        targetId: "TARGET-41",
        tabId: "t1",
        webExtensionTabId: 41,
      }),
    ]);
  });

  it("does not expose a malformed native WebExtension tab id", async () => {
    mockExtensionPage();
    globalThis.fetch = vi.fn(async () =>
      Response.json([
        {
          id: "TARGET-41",
          tabId: "41",
          title: "Extension test",
          url: "https://example.com/login",
          type: "page",
        },
      ]),
    );

    const tabs = await createExtensionProfile().listTabs();

    expect(tabs).toHaveLength(1);
    expect(tabs[0]).not.toHaveProperty("webExtensionTabId");
  });

  it("keeps tab listing available when native extension metadata cannot be read", async () => {
    mockExtensionPage();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("relay metadata unavailable");
    });

    const tabs = await createExtensionProfile().listTabs();

    expect(tabs).toEqual([expect.objectContaining({ targetId: "TARGET-41", tabId: "t1" })]);
    expect(tabs[0]).not.toHaveProperty("webExtensionTabId");
  });
});
