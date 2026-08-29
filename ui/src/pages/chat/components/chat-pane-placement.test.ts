/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { renderChatPanePlacement } from "./chat-pane-placement.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

function mount(status: "available" | "offline"): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const session: GatewaySessionRow = {
    key: "agent:main:device",
    kind: "direct",
    updatedAt: 0,
    placement: {
      state: "active",
      generation: 1,
      createdAtMs: 100_000,
      updatedAtMs: 300_000,
      stateChangedAtMs: 300_000,
      environmentId: "worker:device",
      activeOwnerEpoch: 1,
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "base-manifest",
      remoteWorkspaceDir: "/worker/repo",
      runner: { kind: "device", status },
    },
  };
  render(
    renderChatPanePlacement({
      session,
      placementReclaimDisabledReason:
        status === "offline"
          ? "Reconnect the device to stop and sync its workspace, or Continue on Gateway."
          : undefined,
    }),
    container,
  );
  return container;
}

describe("chat pane device placement", () => {
  it.each([
    {
      status: "available" as const,
      label: "Runs on device",
      move: "Move session…",
      waiting: false,
    },
    {
      status: "offline" as const,
      label: "Device offline",
      move: "Continue on Gateway…",
      waiting: true,
    },
  ])("renders $status runner availability without rediscovery", (scenario) => {
    const container = mount(scenario.status);

    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      scenario.label,
    );
    expect(container.querySelector(".chat-pane__placement-move")?.textContent?.trim()).toBe(
      scenario.move,
    );
    const note = container.querySelector(".chat-pane__placement-note");
    const move = container.querySelector<HTMLElement>(".chat-pane__placement-move");
    const reclaim = container.querySelector<HTMLElement>(".chat-pane__placement-reclaim");
    expect(move?.hasAttribute("disabled")).toBe(false);
    if (scenario.waiting) {
      expect(note?.textContent).toContain("Waiting for device to reconnect");
      expect(reclaim?.hasAttribute("disabled")).toBe(true);
      expect(reclaim?.title).toContain("Reconnect the device");
    } else {
      expect(note).toBeNull();
      expect(reclaim?.hasAttribute("disabled")).toBe(false);
    }
  });
});
