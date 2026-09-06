/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { deviceIcons } from "../../components/icons-devices.ts";
import { icons } from "../../components/icons.ts";
import { deviceIcon } from "./view-shared.ts";

describe("deviceIcon", () => {
  it.each([
    ["MacBook", { modelIdentifier: "MacBookPro18,1" }, deviceIcons.laptop],
    ["Mac Studio", { modelIdentifier: "Mac15,14" }, deviceIcons.pcCase],
    ["Mac mini", { modelIdentifier: "Mac16,11" }, deviceIcons.macMini],
    ["Mac Pro", { modelIdentifier: "MacPro7,1" }, deviceIcons.pcCase],
    ["iMac", { modelIdentifier: "iMac21,1" }, deviceIcons.allInOne],
    ["iPhone", { modelIdentifier: "iPhone17,1" }, deviceIcons.smartphone],
    ["iPad", { modelIdentifier: "iPad16,3", platform: "iOS 18.0" }, deviceIcons.tablet],
    ["watch", { modelIdentifier: "Watch7,1" }, deviceIcons.watch],
    ["browser client", { clientId: "openclaw-control-ui" }, deviceIcons.browser],
    ["CLI mode", { clientMode: "cli" }, deviceIcons.terminal],
    ["TUI client", { clientId: "openclaw-tui", clientMode: "ui" }, deviceIcons.terminal],
    ["gateway server", { clientMode: "gateway" }, deviceIcons.server],
    ["unknown", { modelIdentifier: "Mac99,99" }, icons.monitor],
  ] as const)("renders %s with its form-factor glyph", (_label, source, expectedIcon) => {
    const icon = deviceIcon(source);
    expect(icon).toBe(expectedIcon);
    const container = document.createElement("div");
    render(icon, container);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.children.length).toBeGreaterThan(0);
    for (const shape of svg?.children ?? []) {
      expect(shape.namespaceURI).toBe("http://www.w3.org/2000/svg");
    }
  });
});
