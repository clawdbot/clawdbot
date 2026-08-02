import { describe, expect, it } from "vitest";
import type { HealthSummary } from "../gateway/health/types.js";
import { formatHealthChannelLines } from "./health-format.js";

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

  it("surfaces a failed sibling probe over the selected account's passive healthy state", () => {
    const summary = createHealthSummary({
      channels: {
        matrix: {
          accountId: "main",
          configured: true,
          healthState: "healthy",
          probe: { ok: true, elapsedMs: 12 },
          accounts: {
            main: {
              accountId: "main",
              configured: true,
              healthState: "healthy",
              probe: { ok: true, elapsedMs: 12 },
            },
            alerts: {
              accountId: "alerts",
              configured: true,
              healthState: "healthy",
              probe: { ok: false, error: "sync rejected" },
            },
          },
        },
      },
      channelOrder: ["matrix"],
      channelLabels: { matrix: "Matrix" },
    });

    expect(formatHealthChannelLines(summary, { accountMode: "all" })).toStrictEqual([
      "Matrix: failed (unknown) - sync rejected",
    ]);
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

  it("surfaces configured plugin failures in owner order without warning for disabled plugins", () => {
    const summary = createHealthSummary({
      channels: {
        telegram: { accountId: "default", configured: true },
      },
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
    });
    summary.plugins = {
      loaded: ["telegram"],
      errors: [
        {
          id: "zeta",
          origin: "global",
          activated: true,
          error: "registration failed",
        },
        {
          id: "shared",
          origin: "config",
          activated: false,
          activationSource: "explicit",
          error: "configured owner failed",
        },
        {
          id: "ignored",
          origin: "workspace",
          activated: false,
          activationSource: "disabled",
          error: "disabled plugin ignored",
        },
      ],
      unavailable: [
        {
          id: "shared",
          state: "configured-unavailable",
          diagnostic: {
            kind: "plugin-verification",
            reason: "missing-main-entry",
            detail: "main entry missing",
          },
        },
        {
          id: "alpha",
          state: "configured-unavailable",
          diagnostic: {
            kind: "plugin-verification",
            reason: "missing-package-json",
            detail: "package metadata missing",
          },
        },
      ],
    };

    expect(formatHealthChannelLines(summary)).toStrictEqual([
      "Telegram: configured",
      "Plugin: failed - alpha: configured-unavailable (missing-package-json): package metadata missing",
      "Plugin: failed - shared: configured owner failed",
      "Plugin: failed - shared: configured-unavailable (missing-main-entry): main entry missing",
      "Plugin: failed - zeta: registration failed",
    ]);
  });

  it("keeps untrusted plugin ids and diagnostics inside one fixed failed health line", () => {
    const summary = createHealthSummary({
      channels: {},
      channelOrder: [],
      channelLabels: {},
    });
    summary.plugins = {
      loaded: [],
      errors: [
        {
          id: "\u001b[32msp\u202eoof:\u2066ok\u2069\u001b[0m\n\u200bnext\u2028",
          origin: "global",
          activated: false,
          activationSource: "explicit",
          error: "\u001b]52;c;YWJj\u0007fa\u{E0061}iled\nretry\t\u2029la\ufeffter\uD800",
        },
      ],
    };

    const [line] = formatHealthChannelLines(summary);

    expect(line).toBe("Plugin: failed - spoof:ok\\nnext: failed\\nretry\\tlater");
    expect(line?.split(":", 1)).toStrictEqual(["Plugin"]);
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\n");
    expect(line).not.toMatch(/[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
  });

  it("bounds plugin ids and diagnostics without splitting Unicode code points", () => {
    const summary = createHealthSummary({
      channels: {},
      channelOrder: [],
      channelLabels: {},
    });
    summary.plugins = {
      loaded: [],
      errors: [
        {
          id: "📦".repeat(90),
          origin: "global",
          activated: true,
          error: "🦀".repeat(170),
        },
      ],
    };

    expect(formatHealthChannelLines(summary)).toStrictEqual([
      `Plugin: failed - ${"📦".repeat(79)}…: ${"🦀".repeat(159)}…`,
    ]);
  });

  it("does not add warnings for healthy loaded or explicitly disabled plugins", () => {
    const summary = createHealthSummary({
      channels: {},
      channelOrder: [],
      channelLabels: {},
    });
    summary.plugins = {
      loaded: ["healthy"],
      errors: [
        {
          id: "ignored",
          origin: "workspace",
          activated: false,
          activationSource: "disabled",
          error: "disabled plugin ignored",
        },
      ],
      unavailable: [],
    };

    expect(formatHealthChannelLines(summary)).toStrictEqual([]);
  });
});
