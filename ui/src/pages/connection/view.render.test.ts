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
      colorVision: "standard",
      chatShowThinking: true,
      chatShowToolCalls: true,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
      locale: "en",
    },
    password: "",
    lastError: null,
    lastChannelsRefresh: null,
    systemInfo: null,
    systemInfoUnavailable: false,
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

function expectStatByLabel(container: Element, text: string): HTMLElement {
  const stat = Array.from(container.querySelectorAll<HTMLElement>(".config-host__stat")).find(
    (candidate) =>
      candidate.querySelector(".config-host__stat-label")?.textContent?.trim() === text,
  );
  if (!(stat instanceof HTMLElement)) {
    throw new Error(`Expected system stat "${text}"`);
  }
  return stat;
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

  it("keeps every gateway access input labeled when credentials are revealed", () => {
    const container = document.createElement("div");
    const props = createConnectionProps({ password: "password" });
    const labels = [
      "WebSocket URL",
      "Gateway Token",
      "Password (not stored)",
      "Default Session Key",
    ];
    const inputLabels = () =>
      Array.from(container.querySelectorAll<HTMLInputElement>(".settings-group input")).map(
        (input) => input.getAttribute("aria-label"),
      );

    render(renderConnection(props), container);
    expect(inputLabels()).toEqual(labels);
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Gateway Token"]')?.type,
    ).toBe("password");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Password (not stored)"]')?.type,
    ).toBe("password");

    render(
      renderConnection({ ...props, showGatewayToken: true, showGatewayPassword: true }),
      container,
    );
    expect(inputLabels()).toEqual(labels);
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Gateway Token"]')?.type,
    ).toBe("text");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Password (not stored)"]')?.type,
    ).toBe("text");
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
    expect(container.textContent).not.toContain("Uptime");
  });

  it("renders Gateway host identity and resources between access and snapshot", async () => {
    const container = document.createElement("div");
    render(
      renderConnection(
        createConnectionProps({
          systemInfo: {
            machineName: "Gateway Mac",
            hostname: "gateway.local",
            platform: "darwin",
            release: "25.5.0",
            arch: "arm64",
            osLabel: "macOS 26.5.0",
            lanAddress: "192.168.1.20",
            port: 18789,
            nodeVersion: "v24.1.0",
            pid: 1234,
            uptimeMs: 3_600_000,
            cpuCount: 10,
            cpuModel: "Apple M4",
            loadAverage: [1.2, 1.1, 0.9],
            memoryTotalBytes: 34_359_738_368,
            memoryFreeBytes: 17_179_869_184,
            diskTotalBytes: 994_662_584_320,
            diskAvailableBytes: 497_331_292_160,
            diskPath: "/Users/operator/.openclaw",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const sections = [...container.querySelectorAll(".settings-section__heading")].map((node) =>
      node.textContent?.trim(),
    );
    expect(sections).toEqual(["Gateway Access", "Gateway Host", "Snapshot"]);
    expect(container.querySelector("#settings-connection-host")).not.toBeNull();
    const name = container.querySelector(".config-host__name");
    expect(name?.textContent?.trim()).toBe("Gateway Mac");
    expect(name?.getAttribute("title")).toBe("gateway.local");
    expect(container.querySelector(".config-host__address")?.textContent?.trim()).toBe(
      "192.168.1.20:18789",
    );
    const metas = Array.from(container.querySelectorAll(".config-host__meta")).map((node) =>
      node.textContent?.trim(),
    );
    expect(metas).toEqual(["macOS 26.5.0 · arm64", "Node v24.1.0 · PID 1234"]);
    expect(
      container
        .querySelector("#settings-connection-host .settings-section__actions .settings-status")
        ?.textContent?.trim(),
    ).toBe("Up 1h");

    const cpu = expectStatByLabel(container, "CPU");
    expect(
      cpu.querySelector(".config-host__stat-value")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("1.2 load");
    expect(cpu.querySelector(".config-host__stat-detail")?.textContent?.trim()).toBe("10 cores");
    expect(cpu.getAttribute("title")).toBe("Apple M4 · Load average: 1.2 · 1.1 · 0.9");
    expect(cpu.querySelector(".config-host__meter")?.getAttribute("aria-valuenow")).toBe("12");

    const memory = expectStatByLabel(container, "Memory");
    expect(
      memory.querySelector(".config-host__stat-value")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("50% used");
    expect(memory.querySelector(".config-host__stat-detail")?.textContent?.trim()).toBe(
      "16 GB free of 32 GB",
    );

    const disk = expectStatByLabel(container, "Disk");
    expect(
      disk.querySelector(".config-host__stat-value")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("50% used");
    expect(disk.querySelector(".config-host__stat-detail")?.textContent?.trim()).toBe(
      "463 GB free of 926 GB",
    );
    expect(disk.getAttribute("title")).toBe("/Users/operator/.openclaw");
    expect(container.textContent).not.toContain("Uptime");
  });

  it("escalates host meter tones and hides the section when the RPC is unavailable", async () => {
    const container = document.createElement("div");
    render(
      renderConnection(
        createConnectionProps({
          systemInfo: {
            machineName: "Gateway Mac",
            hostname: "gateway.local",
            platform: "darwin",
            release: "25.5.0",
            arch: "arm64",
            osLabel: "macOS 26.5.0",
            nodeVersion: "v24.1.0",
            pid: 1234,
            uptimeMs: 60_000,
            cpuCount: 10,
            loadAverage: [9.8, 9.1, 8.4],
            memoryTotalBytes: 34_359_738_368,
            memoryFreeBytes: 2_147_483_648,
            diskTotalBytes: 994_662_584_320,
            diskAvailableBytes: 198_932_516_864,
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const tone = (label: string) =>
      expectStatByLabel(container, label).querySelector(".config-host__meter-fill")?.classList[1];
    expect(tone("CPU")).toBe("config-host__meter-fill--critical");
    expect(tone("Memory")).toBe("config-host__meter-fill--critical");
    expect(tone("Disk")).toBe("config-host__meter-fill--warn");

    render(
      renderConnection(createConnectionProps({ systemInfo: null, systemInfoUnavailable: true })),
      container,
    );
    await Promise.resolve();
    expect(container.querySelector("#settings-connection-host")).toBeNull();
  });

  it("reserves the Gateway host section while its first snapshot loads", async () => {
    const container = document.createElement("div");
    render(renderConnection(createConnectionProps()), container);
    await Promise.resolve();

    const systemSection = container.querySelector("#settings-connection-host");
    expect(systemSection).not.toBeNull();
    expect(systemSection?.querySelector(".config-host__name")?.textContent).toContain("—");
    for (const label of ["CPU", "Memory", "Disk"]) {
      const stat = expectStatByLabel(systemSection ?? container, label);
      expect(stat.querySelector(".config-host__stat-value")?.textContent).toContain("—");
      expect(stat.querySelector(".config-host__meter")).toBeNull();
    }
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
