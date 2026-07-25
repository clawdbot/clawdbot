/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import { renderConnection } from "./view.ts";

type ConnectionProps = Parameters<typeof renderConnection>[0];

function createConnectionProps(overrides: Partial<ConnectionProps> = {}): ConnectionProps {
  return {
    connected: false,
    hello: null,
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "tok",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
      locale: "en",
    },
    password: "",
    lastError: null,
    lastChannelsRefresh: null,
    showGatewayToken: false,
    showGatewayPassword: false,
    onConnectionChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onToggleGatewayTokenVisibility: () => undefined,
    onToggleGatewayPasswordVisibility: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

function accessRowTitles(container: HTMLElement): string[] {
  const accessGroup = container.querySelectorAll(".settings-group")[0];
  return [...(accessGroup?.querySelectorAll(".settings-row__title") ?? [])].map(
    (node) => node.textContent?.trim() ?? "",
  );
}

describe("connection view rendering", () => {
  it("renders the gateway access form with credential fields", async () => {
    const container = document.createElement("div");
    render(renderConnection(createConnectionProps()), container);
    await Promise.resolve();

    expect(accessRowTitles(container)).toEqual([
      "WebSocket URL",
      "Gateway Token",
      "Password (not stored)",
      "Default Session Key",
    ]);
    expect(container.textContent).not.toContain("Last error");
  });

  it("hides token and password fields for trusted-proxy auth", async () => {
    const container = document.createElement("div");
    const hello = {
      snapshot: { authMode: "trusted-proxy", uptimeMs: 90_000 },
      policy: { tickIntervalMs: 30_000 },
    } as unknown as GatewayHelloOk;
    render(renderConnection(createConnectionProps({ connected: true, hello })), container);
    await Promise.resolve();

    expect(accessRowTitles(container)).toEqual(["WebSocket URL", "Default Session Key"]);
    expect(container.textContent).toContain("Authenticated via trusted proxy.");
    expect(container.textContent).toContain("30s");
  });

  it("surfaces the last connection error as a snapshot row", async () => {
    const container = document.createElement("div");
    render(
      renderConnection(createConnectionProps({ lastError: "connect failed: unauthorized" })),
      container,
    );
    await Promise.resolve();

    const errorStatus = container.querySelector(".settings-status--danger");
    expect(errorStatus?.textContent).toContain("Last error");
    expect(errorStatus?.closest(".settings-row")?.textContent).toContain(
      "connect failed: unauthorized",
    );
  });
});
