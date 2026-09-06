/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderCloudMachineMenuItems, renderCloudProfileMenuItems } from "./cloud-target.ts";

describe("cloud target menu", () => {
  it.each([
    {
      name: "CPU and memory",
      machine: { id: "standard", label: "Standard", cpu: 32, memoryGb: 64 },
      expected: "32 vCPU · 64 GB",
    },
    {
      name: "CPU only",
      machine: { id: "compute", label: "Compute", cpu: 48 },
      expected: "48 vCPU",
    },
    {
      name: "memory only",
      machine: { id: "memory", label: "Memory", memoryGb: 256 },
      expected: "256 GB",
    },
    {
      name: "no shape",
      machine: { id: "custom", label: "Custom" },
      expected: undefined,
    },
  ])("renders $name without an empty sub-line", ({ machine, expected }) => {
    const container = document.createElement("div");
    render(
      renderCloudMachineMenuItems({
        machines: [machine],
        selectedId: "",
        submitting: false,
        onSelect: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector(".session-menu__sub")?.textContent).toBe(expected);
  });

  it("renders the default badge before the machine shape", () => {
    const container = document.createElement("div");
    render(
      renderCloudMachineMenuItems({
        machines: [{ id: "standard", label: "Standard", cpu: 32, memoryGb: 64, default: true }],
        selectedId: "standard",
        submitting: false,
        onSelect: vi.fn(),
      }),
      container,
    );

    const badge = container.querySelector(".new-session-page__menu-facts");
    const shape = container.querySelector(".session-menu__sub");
    expect(badge?.compareDocumentPosition(shape as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("disables cloud profiles with the runtime preflight reason", () => {
    const container = document.createElement("div");
    render(
      renderCloudProfileMenuItems({
        profiles: [{ id: "aws", providerId: "crabbox" }],
        selectedId: "",
        submitting: false,
        disabled: true,
        disabledReason: "The acpx runtime does not support cloud workers.",
        onSelect: vi.fn(),
      }),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("The acpx runtime does not support cloud workers.");
  });

  it("disables only the cloud profile with a profile-specific reason", () => {
    const reason =
      "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.";
    const container = document.createElement("div");
    render(
      renderCloudProfileMenuItems({
        profiles: [
          { id: "aws", providerId: "crabbox" },
          { id: "ssh", providerId: "static-ssh" },
        ],
        selectedId: "",
        submitting: false,
        profileDisabledReason: (profile) => (profile.id === "aws" ? reason : undefined),
        onSelect: vi.fn(),
      }),
      container,
    );

    const disabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
    const enabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:ssh"]');
    expect(disabled?.disabled).toBe(true);
    expect(disabled?.title).toBe(reason);
    expect(enabled?.disabled).toBe(false);
    expect(enabled?.title).toBe("Cloud worker provider: static-ssh");
  });
});
