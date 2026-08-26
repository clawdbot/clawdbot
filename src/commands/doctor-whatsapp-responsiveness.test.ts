// Doctor WhatsApp responsiveness tests cover warning heuristics and note output for stale connections.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

const { collectWhatsappResponsivenessHealthFindings, noteWhatsappResponsivenessHealth } =
  await import("./doctor-whatsapp-responsiveness.js");

describe("doctor WhatsApp responsiveness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns without signaling an installation-ambiguous TUI", async () => {
    const cfg = { channels: { whatsapp: { enabled: true } } } as OpenClawConfig;

    await noteWhatsappResponsivenessHealth({
      cfg,
      status: {
        eventLoop: {
          degraded: true,
          degradedSinceMs: 61_000,
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          delayP99Ms: 42,
          delayMaxMs: 12_000,
          utilization: 0.3,
          cpuCoreRatio: 0.4,
        },
      },
      shouldRepair: true,
      listLocalTuiProcesses: () => [{ pid: 101, command: "openclaw-tui", ownership: "ambiguous" }],
    });

    expect(noteMock).toHaveBeenCalledWith(
      [
        "Gateway event loop is degraded while local TUI clients are running.",
        "WhatsApp replies can queue behind TUI startup/session refresh work.",
        "Local TUI pids: 101",
        "",
        "Doctor cannot safely close a TUI whose installation is unknown; close those sessions and retry.",
      ].join("\n"),
      "WhatsApp responsiveness",
    );
  });

  it("collects a warning finding for local TUI pressure when WhatsApp is enabled", () => {
    const cfg = { channels: { whatsapp: { enabled: true } } } as OpenClawConfig;

    const findings = collectWhatsappResponsivenessHealthFindings({
      cfg,
      status: {
        eventLoop: {
          degraded: true,
          degradedSinceMs: 61_000,
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          delayP99Ms: 42,
          delayMaxMs: 12_000,
          utilization: 0.3,
          cpuCoreRatio: 0.4,
        },
      },
      listLocalTuiProcesses: () => [{ pid: 101, command: "openclaw-tui", ownership: "ambiguous" }],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/whatsapp-responsiveness",
        severity: "warning",
        path: "channels.whatsapp",
        target: "101",
        requirement: "local-tui-event-loop-pressure",
        fixHint: expect.stringContaining("Close local TUI sessions"),
      }),
    ]);
  });

  it("keeps WhatsApp responsiveness findings quiet without the exact pressure signal", () => {
    const cfg = { channels: { whatsapp: { enabled: true } } } as OpenClawConfig;

    expect(
      collectWhatsappResponsivenessHealthFindings({
        cfg,
        status: {
          eventLoop: {
            degraded: false,
            degradedSinceMs: null,
            reasons: [],
            intervalMs: 1,
            delayP99Ms: 0,
            delayMaxMs: 0,
            utilization: 0,
            cpuCoreRatio: 0,
          },
        },
        listLocalTuiProcesses: () => [
          { pid: 101, command: "openclaw-tui", ownership: "ambiguous" },
        ],
      }),
    ).toEqual([]);
    expect(
      collectWhatsappResponsivenessHealthFindings({
        cfg,
        status: {
          eventLoop: {
            degraded: true,
            degradedSinceMs: 61_000,
            reasons: ["event_loop_delay"],
            intervalMs: 30_000,
            delayP99Ms: 42,
            delayMaxMs: 12_000,
            utilization: 0.3,
            cpuCoreRatio: 0.4,
          },
        },
        listLocalTuiProcesses: () => [],
      }),
    ).toEqual([]);
    expect(
      collectWhatsappResponsivenessHealthFindings({
        cfg: { channels: { whatsapp: { enabled: false } } } as OpenClawConfig,
        status: {
          eventLoop: {
            degraded: true,
            degradedSinceMs: 61_000,
            reasons: ["event_loop_delay"],
            intervalMs: 30_000,
            delayP99Ms: 42,
            delayMaxMs: 12_000,
            utilization: 0.3,
            cpuCoreRatio: 0.4,
          },
        },
        listLocalTuiProcesses: () => [
          { pid: 101, command: "openclaw-tui", ownership: "ambiguous" },
        ],
      }),
    ).toEqual([]);
  });

  it("does not treat generic model routing as a WhatsApp-only issue", async () => {
    const cfg = {
      channels: { whatsapp: { enabled: true } },
      agents: { defaults: { model: { primary: "openai-codex/gpt-5.5" } } },
    } as OpenClawConfig;

    await noteWhatsappResponsivenessHealth({
      cfg,
      status: {
        eventLoop: {
          degraded: false,
          degradedSinceMs: null,
          reasons: [],
          intervalMs: 1,
          delayP99Ms: 0,
          delayMaxMs: 0,
          utilization: 0,
          cpuCoreRatio: 0,
        },
      },
      shouldRepair: true,
      listLocalTuiProcesses: () => [],
    });

    expect(noteMock).not.toHaveBeenCalled();
  });
});
