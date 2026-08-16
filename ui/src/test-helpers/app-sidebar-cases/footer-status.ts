import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { CONTROL_UI_BUILD_INFO, type ControlUiBuildInfo } from "../../build-info.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

type SidebarNativeGatewayTestSnapshot = {
  gateways: Array<{
    id: string;
    name: string;
    isPrimary: boolean;
    health: "ok" | "error" | "unknown";
  }>;
  currentId: string;
};

type SidebarNativeGatewayTestWindow = Window & {
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_GATEWAYS__?: SidebarNativeGatewayTestSnapshot;
};

type MutableControlUiBuildInfo = {
  -readonly [Key in keyof ControlUiBuildInfo]: ControlUiBuildInfo[Key];
};

const ORIGINAL_CONTROL_UI_BUILD_INFO = { ...CONTROL_UI_BUILD_INFO };
const CONTROL_UI_TEST_COMMIT = "e8cbc62f0123456789abcdef0123456789abcdef";

function setControlUiBuildInfo(overrides: Partial<ControlUiBuildInfo>): void {
  Object.assign(
    CONTROL_UI_BUILD_INFO as MutableControlUiBuildInfo,
    ORIGINAL_CONTROL_UI_BUILD_INFO,
    overrides,
  );
}

function setNativeGatewayTestState(snapshot: SidebarNativeGatewayTestSnapshot): void {
  const nativeWindow = window as SidebarNativeGatewayTestWindow;
  nativeWindow["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
  nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"] = snapshot;
}

afterEach(() => {
  const nativeWindow = window as SidebarNativeGatewayTestWindow;
  Reflect.deleteProperty(nativeWindow, "__OPENCLAW_NATIVE_WEB_CHROME__");
  Reflect.deleteProperty(nativeWindow, "__OPENCLAW_NATIVE_GATEWAYS__");
  Object.assign(CONTROL_UI_BUILD_INFO as MutableControlUiBuildInfo, ORIGINAL_CONTROL_UI_BUILD_INFO);
  vi.useRealTimers();
});

describe("AppSidebar gateway footer subtitle", () => {
  const twoGateways = {
    gateways: [
      { id: "local", name: "Local Gateway", isPrimary: true, health: "ok" },
      { id: "remote", name: "Remote Gateway", isPrimary: false, health: "unknown" },
    ],
    currentId: "local",
  } satisfies SidebarNativeGatewayTestSnapshot;

  it("shows custom build provenance and hides official releases", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-10T16:00:00.000Z"));
    setControlUiBuildInfo({
      commit: CONTROL_UI_TEST_COMMIT,
      commitAt: "2026-07-10T12:00:00.000Z",
      branch: "main",
      dirty: false,
      release: false,
    });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")?.textContent).toBe(
      "git@e8cbc62 · 4h ago",
    );
    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Account: git@e8cbc62 · 4h ago",
    );

    setControlUiBuildInfo({
      commit: CONTROL_UI_TEST_COMMIT,
      commitAt: "2026-07-10T12:00:00.000Z",
      branch: "main",
      dirty: false,
      release: true,
    });
    sidebar.requestUpdate();
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Account",
    );
  });

  it("stays hidden outside native chrome", async () => {
    const nativeWindow = window as SidebarNativeGatewayTestWindow;
    nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"] = twoGateways;
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
  });

  it("stays hidden with one configured gateway", async () => {
    setNativeGatewayTestState({ gateways: [twoGateways.gateways[0]!], currentId: "local" });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
  });

  it("shows the current gateway health, name, and primary suffix", async () => {
    setControlUiBuildInfo({ commit: CONTROL_UI_TEST_COMMIT, release: false });
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(
      sidebar.querySelector(".sidebar-identity-card__gateway-health")?.getAttribute("data-health"),
    ).toBe("ok");
    expect(sidebar.querySelector(".sidebar-identity-card__gateway-name")?.textContent).toBe(
      "Local Gateway",
    );
    expect(sidebar.querySelector(".sidebar-identity-card__gateway-primary")?.textContent).toBe(
      "· primary",
    );
    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")?.textContent).not.toContain(
      "git@e8cbc62",
    );
    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Account: Local Gateway, primary",
    );
    expect(
      sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label"),
    ).not.toContain("git@e8cbc62");
  });

  it("keeps the reconnecting subtitle while offline", async () => {
    setControlUiBuildInfo({ commit: CONTROL_UI_TEST_COMMIT, release: false });
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.offline = true;
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")?.textContent).toBe(
      "Reconnecting…",
    );
    expect(sidebar.querySelector(".sidebar-identity-card__gateway-name")).toBeNull();
    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Account: Reconnecting…",
    );
    expect(
      sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label"),
    ).not.toContain("git@e8cbc62");
  });

  it("updates when the native gateway snapshot changes", async () => {
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    setNativeGatewayTestState({
      gateways: [
        { id: "local", name: "Local Gateway", isPrimary: true, health: "ok" },
        { id: "remote", name: "Remote Gateway", isPrimary: false, health: "error" },
      ],
      currentId: "remote",
    });
    window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed"));
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card__gateway-name")?.textContent).toBe(
      "Remote Gateway",
    );
    expect(
      sidebar.querySelector(".sidebar-identity-card__gateway-health")?.getAttribute("data-health"),
    ).toBe("error");
    expect(sidebar.querySelector(".sidebar-identity-card__gateway-primary")).toBeNull();
  });
});
