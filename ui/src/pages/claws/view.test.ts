/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawsDoctorResult,
  ClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { i18n } from "../../i18n/index.ts";
import { renderClaws } from "./view.ts";

const status: ClawsStatusResult = {
  schemaVersion: "openclaw.clawsGatewayStatus.v1",
  records: [
    {
      agentId: "analyst",
      name: "financial-analyst",
      version: "1.2.0",
      sourceKind: "package",
      status: "complete",
      agentState: "present",
      bootstrapState: "complete",
      orphaned: false,
      addedAtMs: 1_000,
      updatedAtMs: 2_000,
      resources: [
        {
          kind: "plugin",
          id: "@openclaw/markets@2.0.0",
          state: "present",
          relationship: "referenced",
          origin: "pre-existing",
          independentOwner: true,
        },
      ],
    },
  ],
  summary: { claws: 1, healthy: 1, attention: 0, managed: 0, referenced: 1 },
};

const doctor: ClawsDoctorResult = {
  schemaVersion: "openclaw.clawsGatewayDoctor.v1",
  findings: [],
  summary: { info: 0, warnings: 0, errors: 0 },
};

describe("renderClaws", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("renders inventory, provenance, and lifecycle health", () => {
    const container = document.createElement("div");
    render(
      renderClaws({
        connected: true,
        available: true,
        loading: false,
        busy: false,
        error: null,
        status,
        doctor,
        selectedAgentId: "analyst",
        onSelect: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector(".claws-inventory__name")?.textContent).toBe(
      "financial-analyst",
    );
    expect(container.querySelector(".claws-resource__id")?.textContent).toContain(
      "@openclaw/markets@2.0.0",
    );
    expect(container.textContent).toContain("Referenced");
    expect(container.textContent).toContain("Pre-existing");
    expect(container.textContent).toContain("Healthy");
    expect(container.textContent).toContain("First-run setup");
  });

  it("shows pending first-run setup as needing attention", () => {
    const container = document.createElement("div");
    const pendingStatus: ClawsStatusResult = {
      ...status,
      records: [{ ...status.records[0], bootstrapState: "pending" }],
      summary: { claws: 1, healthy: 0, attention: 1, managed: 0, referenced: 1 },
    };
    render(
      renderClaws({
        connected: true,
        available: true,
        loading: false,
        busy: false,
        error: null,
        status: pendingStatus,
        doctor,
        selectedAgentId: "analyst",
        onSelect: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("First-run setup");
    expect(container.textContent).toContain("Pending");
  });

  it("does not render lifecycle state when the method is unavailable", () => {
    const container = document.createElement("div");
    render(
      renderClaws({
        connected: true,
        available: false,
        loading: false,
        busy: false,
        error: null,
        status,
        doctor,
        selectedAgentId: "analyst",
        onSelect: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("not enabled");
    expect(container.textContent).not.toContain("financial-analyst");
  });
});
