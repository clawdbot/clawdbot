/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import { renderConnection } from "./view.ts";

type ConnectionProps = Parameters<typeof renderConnection>[0];

function createConnectionProps(overrides: Partial<ConnectionProps> = {}): ConnectionProps {
  return {
    connected: false,
    hello: null,
    liveGatewayUrl: "ws://127.0.0.1:18789",
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "tok",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
      locale: "en",
    },
    secret: "tok",
    lastError: null,
    systemInfo: null,
    systemInfoUnavailable: false,
    dirty: false,
    showGatewaySecret: false,
    onConnectionChange: () => undefined,
    onSecretChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onToggleGatewaySecretVisibility: () => undefined,
    onConnect: () => undefined,
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
      candidate
        .querySelector(".config-host__stat-label")
        ?.textContent?.replace(/\s+/g, " ")
        .trim() === text,
  );
  if (!(stat instanceof HTMLElement)) {
    throw new Error(`Expected system stat "${text}"`);
  }
  return stat;
}

describe("connection view rendering", () => {
  it("shows setup-code guidance beneath the secret before connecting", () => {
    const container = document.createElement("div");
    const secret = btoa(
      JSON.stringify({ url: "wss://gateway.example", bootstrapToken: "synthetic-bootstrap-token" }),
    ).replace(/=+$/g, "");
    render(renderConnection(createConnectionProps({ secret })), container);
    const control = container
      .querySelector('input[aria-label="Gateway secret"]')
      ?.closest(".settings-row__control");
    expect(control?.querySelector('[role="status"]')?.textContent).toContain(
      "device setup code for the OpenClaw mobile app",
    );
    expect(control?.textContent).toContain("openclaw gateway auth-token --show");
    render(renderConnection(createConnectionProps()), container);
    expect(control?.querySelector('[role="status"]')).toBeNull();
  });

  it("names the live Gateway in the summary, not the edited draft", () => {
    const props = createConnectionProps({
      connected: true,
      liveGatewayUrl: "wss://live.example:443/",
      settings: { ...createConnectionProps().settings, gatewayUrl: "wss://draft.example:443/" },
    });
    const container = document.createElement("div");
    render(renderConnection(props), container);

    const summary = container.querySelector(".settings-section__desc")?.textContent ?? "";
    expect(summary).toContain("Connected to live.example");
    expect(summary).not.toContain("draft.example");
  });

  it("renders the connection form with a single credential field and offline status", async () => {
    const container = document.createElement("div");
    render(renderConnection(createConnectionProps()), container);
    await Promise.resolve();

    expect(accessRowTitles(container)).toEqual([
      "Gateway URL",
      "Gateway secret",
      "Default session",
    ]);
    expect(container.querySelector(".settings-section__desc")?.textContent?.trim()).toBe(
      "Not connected.",
    );
    expect(container.querySelector(".settings-section__actions")?.textContent?.trim()).toBe(
      "Offline",
    );
    expect(container.querySelectorAll(".settings-secret input")).toHaveLength(1);
    expect(container.textContent).not.toContain("Last error");
  });

  it.each(["token", "password"] as const)(
    "keeps the secret labeled when revealed in %s mode",
    (authMode) => {
      const container = document.createElement("div");
      const props = createConnectionProps({
        hello: { snapshot: { authMode } } as unknown as GatewayHelloOk,
      });
      const input = () =>
        container.querySelector<HTMLInputElement>('input[aria-label="Gateway secret"]');

      render(renderConnection(props), container);
      expect(input()?.type).toBe("password");
      expect(input()?.value).toBe("tok");
      expect(input()?.placeholder).toBe("Paste the token or type the password");
      expect(container.textContent).toContain(`This Gateway expects its ${authMode}.`);
      expect(container.querySelector('[role="radiogroup"]')).toBeNull();
      expect(
        container.querySelector('button[aria-label="Toggle secret visibility"]'),
      ).not.toBeNull();

      render(renderConnection({ ...props, showGatewaySecret: true }), container);
      expect(input()?.type).toBe("text");
      expect(input()?.value).toBe("tok");
    },
  );

  it("hides token and password fields for trusted-proxy auth", async () => {
    const container = document.createElement("div");
    const hello = {
      snapshot: { authMode: "trusted-proxy", uptimeMs: 90_000 },
      policy: { tickIntervalMs: 30_000 },
    } as unknown as GatewayHelloOk;
    render(renderConnection(createConnectionProps({ connected: true, hello })), container);
    await Promise.resolve();

    expect(accessRowTitles(container)).toEqual([
      "Gateway URL",
      "Gateway secret",
      "Default session",
    ]);
    expect(container.querySelector('input[aria-label="Gateway secret"]')).toBeNull();
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container.querySelector(".settings-row .settings-status")?.textContent?.trim()).toBe(
      "Trusted proxy",
    );
    expect(container.textContent).toContain("Authenticated via trusted proxy.");
    expect(container.querySelector(".settings-section__desc")?.textContent?.trim()).toBe(
      "Connected to 127.0.0.1:18789 · proxy auth · 30s tick",
    );
    expect(container.querySelector(".settings-section__actions")?.textContent?.trim()).toBe(
      "Connected",
    );
    expect(container.textContent).not.toContain("Uptime");
  });

  it("renders Gateway host identity and resources after Connection", async () => {
    const container = document.createElement("div");
    const systemInfo = {
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
      disks: [
        {
          path: "/",
          totalBytes: 994_662_584_320,
          availableBytes: 497_331_292_160,
        },
        {
          path: "/Volumes/Archive",
          totalBytes: 2_199_023_255_552,
          availableBytes: 549_755_813_888,
        },
      ],
    } satisfies SystemInfoResult;
    render(renderConnection(createConnectionProps({ systemInfo })), container);
    await Promise.resolve();

    const sections = [...container.querySelectorAll(".settings-section__heading")].map((node) =>
      node.textContent?.trim(),
    );
    expect(sections).toEqual(["Connection", "Gateway Host"]);
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

    const disk = expectStatByLabel(container, "Disk /");
    expect(
      disk.querySelector(".config-host__stat-value")?.textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("50% used");
    expect(disk.querySelector(".config-host__stat-detail")?.textContent?.trim()).toBe(
      "463 GB free of 926 GB",
    );
    expect(disk.getAttribute("title")).toBe("/");
    expect(disk.querySelector('[role="meter"]')?.getAttribute("aria-label")).toBe("Disk / usage");
    const archive = expectStatByLabel(container, "Disk /Volumes/Archive");
    expect(archive.querySelector(".config-host__stat-detail")?.textContent?.trim()).toBe(
      "512 GB free of 2.0 TB",
    );
    expect(archive.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("75");
    expect(archive.querySelector('[role="meter"]')?.getAttribute("aria-label")).toBe(
      "Disk /Volumes/Archive usage",
    );
    expect(container.querySelectorAll(".config-host__stat")).toHaveLength(4);
    expect(container.textContent).not.toContain("Uptime");

    for (const disks of [systemInfo.disks.slice(0, 1), [], undefined]) {
      render(
        renderConnection(createConnectionProps({ systemInfo: { ...systemInfo, disks } })),
        container,
      );
      expect(container.querySelectorAll(".config-host__stat")).toHaveLength(
        2 + (disks?.length ?? 0),
      );
      expect(container.textContent).not.toContain("/Volumes/Archive");
      expect(container.textContent).not.toContain("/Users/operator/.openclaw");
    }
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
            disks: [
              {
                path: "/",
                totalBytes: 994_662_584_320,
                availableBytes: 198_932_516_864,
              },
            ],
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
    expect(tone("Disk /")).toBe("config-host__meter-fill--warn");

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

  it("surfaces the last connection error only while disconnected", async () => {
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
    expect(
      errorStatus?.closest(".settings-section")?.querySelector("h2")?.textContent?.trim(),
    ).toBe("Connection");

    render(
      renderConnection(
        createConnectionProps({ connected: true, lastError: "connect failed: unauthorized" }),
      ),
      container,
    );
    expect(container.querySelector(".settings-status--danger")).toBeNull();
    expect(container.textContent).not.toContain("connect failed: unauthorized");
  });
});
