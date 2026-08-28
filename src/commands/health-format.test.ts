import { describe, expect, it } from "vitest";
import type { ChannelAccountHealthSummary, HealthSummary } from "../gateway/health/types.js";
import { formatGatewayClosedDiagnostic, formatHealthChannelLines } from "./health-format.js";

describe("formatGatewayClosedDiagnostic", () => {
  it("formats a coded gateway transport close", () => {
    const error = Object.assign(new Error("gateway closed (1006): no close reason"), {
      name: "GatewayTransportError",
      kind: "closed",
      code: 1006,
      connectionDetails: {},
    });

    expect(formatGatewayClosedDiagnostic(error)).toBe(
      "Gateway connect failed: gateway closed (1006): no close reason",
    );
  });

  it("does not equate an uncoded connect-time close with a websocket close", () => {
    const error = Object.assign(new Error("Gateway not reachable at ws://127.0.0.1:18789"), {
      name: "GatewayTransportError",
      kind: "closed",
      connectionDetails: {},
    });

    expect(formatGatewayClosedDiagnostic(error)).toBeUndefined();
  });
});

const createHealthSummary = (
  params: Pick<HealthSummary, "channels" | "channelOrder" | "channelLabels">,
): HealthSummary => ({
  ok: true,
  ts: 0,
  durationMs: 0,
  heartbeatSeconds: 60,
  defaultAgentId: "main",
  agents: [],
  sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
  ...params,
});

function createMultiAccountHealthSummary(
  secondary: Partial<ChannelAccountHealthSummary>,
): HealthSummary {
  const primary = {
    accountId: "main",
    enabled: true,
    configured: true,
    linked: true,
    healthState: "healthy",
    probe: { ok: true, elapsedMs: 12 },
  };
  return createHealthSummary({
    channels: {
      matrix: {
        ...primary,
        accounts: {
          main: primary,
          alerts: {
            accountId: "alerts",
            enabled: true,
            configured: true,
            linked: true,
            ...secondary,
          },
        },
      },
    },
    channelOrder: ["matrix"],
    channelLabels: { matrix: "Matrix" },
  });
}

describe("formatHealthChannelLines", () => {
  it("formats per-account probe timings", () => {
    const summary = createHealthSummary({
      channels: {
        telegram: {
          accountId: "main",
          configured: true,
          probe: { ok: true, elapsedMs: 196, bot: { username: "pinguini_ugi_bot" } },
          accounts: {
            main: {
              accountId: "main",
              configured: true,
              probe: { ok: true, elapsedMs: 196, bot: { username: "pinguini_ugi_bot" } },
            },
            flurry: {
              accountId: "flurry",
              configured: true,
              probe: { ok: true, elapsedMs: 190, bot: { username: "flurry_ugi_bot" } },
            },
            poe: {
              accountId: "poe",
              configured: true,
              probe: { ok: true, elapsedMs: 188, bot: { username: "poe_ugi_bot" } },
            },
          },
        },
      },
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
    });

    expect(formatHealthChannelLines(summary, { accountMode: "all" })).toStrictEqual([
      "Telegram: ok (@pinguini_ugi_bot:main:196ms, @flurry_ugi_bot:flurry:190ms, @poe_ugi_bot:poe:188ms)",
    ]);
  });

  it("formats statusState without inferring from linked", () => {
    const summary = createHealthSummary({
      channels: {
        whatsapp: {
          accountId: "default",
          statusState: "unstable",
          configured: true,
        },
      },
      channelOrder: ["whatsapp"],
      channelLabels: { whatsapp: "WhatsApp" },
    });

    expect(formatHealthChannelLines(summary)).toStrictEqual(["WhatsApp: auth stabilizing"]);
  });

  it.each([
    [
      "fresh probe failure over passive healthy state",
      { healthState: "healthy", probe: { ok: false, error: "sync rejected" } },
      "failed (unknown) - sync rejected",
    ],
    [
      "fresh probe success over passive healthy state",
      { healthState: "healthy", probe: { ok: true, elapsedMs: 12 } },
      "ok (12ms)",
    ],
    [
      "blocked lifecycle over a failed probe",
      { linked: true, healthState: "blocked", probe: { ok: false, error: "sync rejected" } },
      "blocked",
    ],
    [
      "unknown degraded lifecycle over a successful probe",
      { healthState: "degraded", probe: { ok: true, elapsedMs: 12 } },
      "degraded",
    ],
    [
      "unstable authentication over passive healthy state and a failed probe",
      {
        healthState: "healthy",
        statusState: "unstable",
        probe: { ok: false, error: "sync rejected" },
      },
      "auth stabilizing",
    ],
    [
      "disabled status over stale passive healthy state",
      { healthState: "healthy", statusState: "disabled" },
      "disabled",
    ],
    [
      "unconfigured account over stale lifecycle and authentication state",
      { configured: false, healthState: "blocked", statusState: "unstable" },
      "not configured",
    ],
    [
      "fresh probe failure over configured status",
      { statusState: "configured", probe: { ok: false, error: "credentials rejected" } },
      "failed (unknown) - credentials rejected",
    ],
    [
      "fresh probe failure over affirmative linked state",
      { linked: true, probe: { ok: false, error: "session rejected" } },
      "failed (unknown) - session rejected",
    ],
    [
      "negative linked state over a failed probe",
      { linked: false, probe: { ok: false, error: "session rejected" } },
      "not linked",
    ],
    ["passive healthy state without a probe", { healthState: "healthy" }, "healthy"],
  ])("formats %s", (_name, account, expected) => {
    const summary = createHealthSummary({
      channels: {
        test: {
          accountId: "default",
          configured: true,
          ...account,
        },
      },
      channelOrder: ["test"],
      channelLabels: { test: "Test" },
    });

    expect(formatHealthChannelLines(summary)).toStrictEqual([`Test: ${expected}`]);
  });

  it.each([
    ["blocked", { healthState: "blocked" }],
    ["disconnected", { healthState: "disconnected" }],
    ["ingress-unavailable", { healthState: "ingress-unavailable" }],
    ["stale-socket", { healthState: "stale-socket" }],
    ["auth stabilizing", { healthState: "healthy", statusState: "unstable" }],
  ])(
    "surfaces secondary account state %s in default and verbose health output",
    (expected, state) => {
      const summary = createMultiAccountHealthSummary(state);

      for (const accountMode of ["default", "all"] as const) {
        expect(formatHealthChannelLines(summary, { accountMode })).toStrictEqual([
          `Matrix: ${expected}`,
        ]);
      }
    },
  );

  it("preserves explicitly scoped account health outside verbose output", () => {
    const summary = createMultiAccountHealthSummary({ healthState: "blocked" });
    const accountIdsByChannel = { matrix: ["main"] };

    expect(
      formatHealthChannelLines(summary, { accountMode: "default", accountIdsByChannel }),
    ).toStrictEqual(["Matrix: ok (12ms)"]);
    expect(
      formatHealthChannelLines(summary, { accountMode: "all", accountIdsByChannel }),
    ).toStrictEqual(["Matrix: blocked"]);
  });

  it.each([
    ["disabled", { enabled: false }],
    ["unconfigured", { configured: false }],
    ["unlinked", { linked: false }],
    ["disabled by status", { statusState: "disabled" }],
    ["unconfigured by status", { statusState: "unconfigured" }],
  ])("does not promote stale failures from an intentionally %s account", (_reason, inactive) => {
    const summary = createMultiAccountHealthSummary({
      healthState: "blocked",
      probe: { ok: false, error: "stale old failure" },
      ...inactive,
    });

    expect(formatHealthChannelLines(summary)).toStrictEqual(["Matrix: ok (12ms)"]);
    expect(formatHealthChannelLines(summary, { accountMode: "all" })).toStrictEqual([
      "Matrix: ok (main:main:12ms)",
    ]);
  });

  it("surfaces a failed sibling probe over the selected account's passive healthy state", () => {
    const summary = createMultiAccountHealthSummary({
      healthState: "healthy",
      probe: { ok: false, error: "sync rejected" },
    });

    expect(formatHealthChannelLines(summary, { accountMode: "all" })).toStrictEqual([
      "Matrix: failed (unknown) - sync rejected",
    ]);
  });

  it("surfaces activated plugin failures without promoting inactive load errors", () => {
    const summary = createHealthSummary({ channels: {}, channelOrder: [], channelLabels: {} });
    summary.plugins = {
      loaded: ["calendar"],
      errors: [
        {
          id: "calendar",
          origin: "workspace",
          activated: true,
          failurePhase: "service",
          error: "service scheduler: address already in use",
        },
        {
          id: "inactive",
          origin: "workspace",
          activated: false,
          failurePhase: "load",
          error: "inactive plugin load failed",
        },
      ],
    };

    expect(formatHealthChannelLines(summary)).toStrictEqual([
      "Plugin calendar: failed - service scheduler: address already in use; run openclaw doctor",
    ]);
  });

  it("bounds activated plugin failure details and summarizes omitted failures", () => {
    const summary = createHealthSummary({ channels: {}, channelOrder: [], channelLabels: {} });
    summary.plugins = {
      loaded: [],
      errors: Array.from({ length: 22 }, (_, index) => ({
        id: `plugin-${index}`,
        origin: "workspace",
        activated: true,
        error: "x".repeat(600),
      })),
    };

    const lines = formatHealthChannelLines(summary);

    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe(`Plugin plugin-0: failed - ${"x".repeat(500)}; run openclaw doctor`);
    expect(lines.at(-1)).toBe(
      "Plugins: failed - 2 additional activated failures; run openclaw doctor",
    );
  });

  it("formats iMessage probe failures as failed health lines", () => {
    const summary = createHealthSummary({
      channels: {
        imessage: {
          accountId: "default",
          configured: true,
          probe: {
            ok: false,
            error:
              "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
          },
        },
      },
      channelOrder: ["imessage"],
      channelLabels: { imessage: "iMessage" },
    });

    expect(formatHealthChannelLines(summary)).toContain(
      "iMessage: failed (unknown) - imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    );
  });
});
