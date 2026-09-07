import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { meetingStatus } from "../../test-helpers/transcripts.test-support.ts";
import { ConfigPage } from "./config-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("keeps Messages default and opens capture with a collapsed schema editor inside the section panel", async () => {
  const config = { messages: { ackReaction: "ok" }, transcripts: { enabled: true } };
  const request = vi.fn(async (method: string) => {
    if (method === "transcripts.status") {
      return meetingStatus;
    }
    if (method === "config.schema") {
      return {
        schema: {
          type: "object",
          properties: {
            messages: { type: "object", properties: { ackReaction: { type: "string" } } },
            tts: { type: "object", properties: { enabled: { type: "boolean" } } },
            transcripts: { type: "object", properties: { enabled: { type: "boolean" } } },
          },
        },
        uiHints: {},
      };
    }
    return {
      config,
      hash: "one",
      appliedConfigHash: "one",
      raw: JSON.stringify(config),
      valid: true,
      issues: [],
    };
  });
  const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const container = document.createElement("div");
  try {
    await runtimeConfig.ensureLoaded();
    await runtimeConfig.ensureSchemaLoaded();
    const context = {
      basePath: "",
      gateway: { ...gateway, connection: { gatewayUrl: "ws://transcripts.test" } },
      runtimeConfig,
      navigate: vi.fn(),
      config: { current: { assistantIdentity: { name: "OpenClaw" } } },
      overlays: { snapshot: { updateRunning: false, updateReconciliationPending: false } },
      webPush: { snapshot: {} },
    } as unknown as ApplicationContext;
    const page = new ConfigPage();
    (page as unknown as { context: ApplicationContext }).context = context;
    page.pageId = "communications";
    render(page.render(), container);
    expect(container.querySelector("openclaw-meeting-capture-settings")).toBeNull();
    const captureTab = container.querySelector<HTMLElement>('wa-tab[panel="transcripts"]')!;
    expect(captureTab.textContent?.trim()).toBe("Meeting capture");
    const tabs = captureTab.closest("wa-tab-group") as HTMLElement & { active: string };
    expect(tabs.active).toBe("messages");
    captureTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    render(page.render(), container);
    const capture = container.querySelector("openclaw-meeting-capture-settings") as HTMLElement & {
      context: ApplicationContext;
      updateComplete: Promise<boolean>;
    };
    expect(container.querySelector("#config-section-panel")?.contains(capture)).toBe(true);
    capture.context = context;
    document.body.append(container);
    await capture.updateComplete;
    const advanced = capture.querySelector<HTMLDetailsElement>("details")!;
    expect(advanced).not.toBeNull();
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector("#config-section-transcripts")).not.toBeNull();
    const toggle = capture.querySelector<HTMLElement & { checked: boolean }>("wa-switch")!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(runtimeConfig.state.configForm).toMatchObject({ transcripts: { enabled: false } });
    expect(
      [...capture.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Save",
      ),
    ).toBe(false);
    page.routeData = {
      pathname: "/settings/communications",
      search: "?section=transcripts&advanced=1",
      hash: "#config-section-transcripts",
      section: "transcripts",
      advanced: true,
      tab: null,
      targetBlockId: "config-section-transcripts",
    };
    page.willUpdate(new Map([["routeData", null]]));
    render(page.render(), container);
    await capture.updateComplete;
    expect(advanced.open).toBe(true);
    container
      .querySelector<HTMLElement>('wa-tab[panel="messages"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    render(page.render(), container);
    expect(container.querySelector("openclaw-meeting-capture-settings")).toBeNull();
  } finally {
    container.remove();
    runtimeConfig.dispose();
  }
});
