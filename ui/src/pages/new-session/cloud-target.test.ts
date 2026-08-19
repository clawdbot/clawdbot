/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderCloudMachineMenuItems, renderCloudProfileMenuItems } from "./cloud-target.ts";
import { DraftSubmissionFlow } from "./draft-submission-flow.ts";

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

  it.each([
    {
      name: "keeps an advertised supported runtime enabled",
      runtime: { id: "codex", cloudPlacementSupported: true, source: "model" as const },
      expected: undefined,
    },
    {
      name: "leaves an unadvertised runtime to the Gateway dispatch gate",
      runtime: { id: "codex", source: "model" as const },
      expected: undefined,
    },
    {
      name: "explains an advertised unsupported runtime",
      runtime: { id: "acpx", cloudPlacementSupported: false, source: "model" as const },
      expected: "The acpx runtime does not support cloud workers.",
    },
  ])("$name", ({ runtime, expected }) => {
    const flow = new DraftSubmissionFlow(
      {} as never,
      {
        modelControl: { resolveAgentRuntime: () => runtime },
        repository: { kind: "git", repoRoot: "/repo", branches: [] },
        selectedAgent: () => undefined,
        worktreeAvailable: () => true,
      } as never,
      () => ({ context: undefined, data: undefined, isConnected: true }),
      { requestUpdate: vi.fn(), closeTransientUi: vi.fn() },
    );

    expect(flow.cloudDisabledReason()).toBe(expected);
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
});
