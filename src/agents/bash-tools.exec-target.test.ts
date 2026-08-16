import { describe, expect, it } from "vitest";
import { resolveExecTarget } from "./bash-tools.exec-runtime.js";

function expectExecTarget(
  actual: ReturnType<typeof resolveExecTarget>,
  expected: {
    configuredTarget: string;
    requestedTarget: string | null;
    selectedTarget: string;
    effectiveHost: string;
  },
) {
  expect(actual.configuredTarget).toBe(expected.configuredTarget);
  expect(actual.requestedTarget).toBe(expected.requestedTarget);
  expect(actual.selectedTarget).toBe(expected.selectedTarget);
  expect(actual.effectiveHost).toBe(expected.effectiveHost);
}

describe("resolveExecTarget", () => {
  it("keeps implicit auto on sandbox when a sandbox runtime is available", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: null,
        selectedTarget: "auto",
        effectiveHost: "sandbox",
      },
    );
  });

  it("keeps implicit auto on gateway when no sandbox runtime is available", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: null,
        selectedTarget: "auto",
        effectiveHost: "gateway",
      },
    );
  });

  it("allows per-call host=node override when configured host is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("allows per-call host=gateway override when configured host is auto and no sandbox", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "gateway",
        selectedTarget: "gateway",
        effectiveHost: "gateway",
      },
    );
  });

  it("rejects per-call host=gateway override from auto when sandbox is available", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is auto; set tools.exec.host=gateway to allow this override).",
    );
  });

  it("rejects per-call host=node override from auto when sandbox is available", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested node; configured host is auto; set tools.exec.host=node to allow this override).",
    );
  });

  it("allows per-call host=sandbox override when configured host is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        selectedTarget: "sandbox",
        effectiveHost: "sandbox",
      },
    );
  });

  it("rejects cross-host override when configured target is a concrete host", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    );
  });

  it("allows explicit auto request when configured host is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "auto",
        selectedTarget: "auto",
        effectiveHost: "sandbox",
      },
    );
  });

  it("requires an exact match for non-auto configured targets", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "gateway",
        requestedTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested auto; configured host is gateway; set tools.exec.host=auto to allow this override).",
    );
  });

  it("allows exact node matches", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "node",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("forces elevated requests onto the gateway host when configured target is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        elevatedRequested: true,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        selectedTarget: "gateway",
        effectiveHost: "gateway",
      },
    );
  });

  it("keeps explicit node override under elevated requests when configured target is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("honours node target for elevated requests when configured target is node", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "node",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("routes to node for elevated when configured=node and no per-call override", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "node",
        requestedTarget: null,
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("rejects mismatched requestedTarget under elevated+node", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "gateway",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    );
  });
});
