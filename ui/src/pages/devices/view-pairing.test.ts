/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderDevicePairSetup } from "./view-pairing.runtime.ts";

describe("device pairing dialog", () => {
  it.each([
    {
      access: "full" as const,
      href: "https://docs.openclaw.ai/channels/pairing#pair-from-the-control-ui-recommended",
    },
    {
      access: "limited" as const,
      href: "https://docs.openclaw.ai/channels/pairing#pair-from-the-control-ui-recommended",
    },
    {
      access: "node" as const,
      href: "https://docs.openclaw.ai/gateway/pairing#one-paste-node-pairing",
    },
  ])("links $access setup help to the matching workflow", ({ access, href }) => {
    const container = document.createElement("div");

    render(
      renderDevicePairSetup({
        open: true,
        lifecycle: { phase: "selection", access },
        nowMs: 0,
        pendingCount: 0,
        onRefresh: vi.fn(),
        onAccessChange: vi.fn(),
        onClose: vi.fn(),
        onManageDevices: vi.fn(),
        onGetApps: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector<HTMLAnchorElement>(".device-pair-setup__footer a")?.href).toBe(
      href,
    );
  });

  it("renders the node one-paste command and quiet expiry countdown", () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderDevicePairSetup({
        open: true,
        lifecycle: {
          phase: "waiting",
          access: "node",
          setup: {
            setupId: "setup-node",
            setupCode: "AbC_123",
            gatewayUrl: "wss://gateway.example",
            auth: "token",
            urlSource: "test",
            access: "node",
            expiresAtMs: 70_000,
          },
        },
        nowMs: 10_000,
        pendingCount: 0,
        onRefresh: vi.fn(),
        onAccessChange: vi.fn(),
        onClose: vi.fn(),
        onManageDevices: vi.fn(),
        onGetApps: vi.fn(),
      }),
      container,
    );

    expect(container.querySelectorAll('input[name="device-pair-access"]')).toHaveLength(3);
    expect(container.querySelector(".device-pair-setup__command code")?.textContent).toBe(
      'openclaw node run --pair "oc-pair://AbC_123"',
    );
    expect(container.querySelector('[role="timer"]')?.textContent?.trim()).toBe(
      "This setup link expires in 1:00.",
    );
  });
});
