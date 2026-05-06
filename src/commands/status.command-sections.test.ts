import { describe, expect, it } from "vitest";
import type { HealthSummary } from "./health.js";
import {
  buildStatusFooterLines,
  buildStatusHealthRows,
  buildStatusPairingRecoveryLines,
  buildStatusPluginCompatibilityLines,
  buildStatusSecurityAuditLines,
  buildStatusSessionsRows,
  buildStatusSystemEventsRows,
  buildStatusSystemEventsTrailer,
  statusHealthColumns,
} from "./status.command-sections.ts";

describe("status.command-sections", () => {
  it("formats security audit lines with finding caps and follow-up commands", () => {
    const lines = buildStatusSecurityAuditLines({
      securityAudit: {
        summary: { critical: 1, warn: 6, info: 2 },
        findings: [
          {
            severity: "warn",
            title: "Warn first",
            detail: "warn detail",
          },
          {
            severity: "critical",
            title: "Critical first",
            detail: "critical\ndetail",
            remediation: "fix it",
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            severity: "warn" as const,
            title: `Warn ${index + 2}`,
            detail: `detail ${index + 2}`,
          })),
        ],
      },
      theme: {
        error: (value) => `error(${value})`,
        warn: (value) => `warn(${value})`,
        muted: (value) => `muted(${value})`,
      },
      shortenText: (value) => value,
      formatCliCommand: (value) => `cmd:${value}`,
    });

    expect(lines[0]).toBe("muted(Summary: error(1 critical) · warn(6 warn) · muted(2 info))");
    expect(lines).toContain("  error(CRITICAL) Critical first");
    expect(lines).toContain("    critical detail");
    expect(lines).toContain("    muted(Fix: fix it)");
    expect(lines).toContain("muted(… +1 more)");
    expect(lines.at(-2)).toBe("muted(Full report: cmd:openclaw security audit)");
    expect(lines.at(-1)).toBe("muted(Deep probe: cmd:openclaw security audit --deep)");
  });

  it("builds verbose sessions rows and empty fallback rows", () => {
    const verboseRows = buildStatusSessionsRows({
      recent: [
        {
          key: "session-key-1234567890",
          kind: "direct",
          updatedAt: 1,
          age: 5_000,
          model: "gpt-5.4",
          runtime: "OpenAI Codex",
          totalTokens: null,
          totalTokensFresh: false,
          remainingTokens: null,
          percentUsed: null,
          contextTokens: null,
          flags: [],
        },
        {
          key: "agent:main:cron:daily-digest",
          kind: "cron",
          updatedAt: 2,
          age: 7_000,
          model: "gpt-5.5",
          runtime: "OpenClaw Pi Default",
          totalTokens: null,
          totalTokensFresh: false,
          remainingTokens: null,
          percentUsed: null,
          contextTokens: null,
          flags: [],
        },
      ],
      verbose: true,
      shortenText: (value) => value.slice(0, 8),
      formatTimeAgo: (value) => `${value}ms`,
      formatTokensCompact: () => "12k",
      formatPromptCacheCompact: () => "cache ok",
      muted: (value) => `muted(${value})`,
    });

    expect(verboseRows).toEqual([
      {
        Key: "session-",
        Kind: "direct",
        Age: "5000ms",
        Model: "gpt-5.4",
        Runtime: "OpenAI Codex",
        Tokens: "12k",
        Cache: "cache ok",
      },
      {
        Key: "agent:ma",
        Kind: "cron",
        Age: "7000ms",
        Model: "gpt-5.5",
        Runtime: "OpenClaw Pi Default",
        Tokens: "12k",
        Cache: "cache ok",
      },
    ]);

    const emptyRows = buildStatusSessionsRows({
      recent: [],
      verbose: true,
      shortenText: (value) => value,
      formatTimeAgo: () => "",
      formatTokensCompact: () => "",
      formatPromptCacheCompact: () => null,
      muted: (value) => `muted(${value})`,
    });

    expect(emptyRows).toEqual([
      {
        Key: "muted(no sessions yet)",
        Kind: "",
        Age: "",
        Model: "",
        Runtime: "",
        Tokens: "",
        Cache: "",
      },
    ]);
  });

  it("maps health channel detail lines into status rows", () => {
    const rows = buildStatusHealthRows({
      health: { durationMs: 42 } as HealthSummary,
      formatHealthChannelLines: () => [
        "QuietChat: OK · ready",
        "WorkChat: failed · auth",
        "Forum: not configured",
        "Matrix: linked",
        "Pager: not linked",
      ],
      ok: (value) => `ok(${value})`,
      warn: (value) => `warn(${value})`,
      muted: (value) => `muted(${value})`,
    });

    expect(rows).toEqual([
      { Item: "Gateway", Status: "ok(reachable)", Detail: "42ms" },
      { Item: "QuietChat", Status: "ok(OK)", Detail: "OK · ready" },
      { Item: "WorkChat", Status: "warn(WARN)", Detail: "failed · auth" },
      { Item: "Forum", Status: "muted(OFF)", Detail: "not configured" },
      { Item: "Matrix", Status: "ok(LINKED)", Detail: "linked" },
      { Item: "Pager", Status: "warn(UNLINKED)", Detail: "not linked" },
    ]);
  });

  it("adds degraded event-loop health to status rows", () => {
    const rows = buildStatusHealthRows({
      health: {
        durationMs: 42,
        eventLoop: {
          degraded: true,
          reasons: ["event_loop_delay"],
          intervalMs: 62_000,
          delayP99Ms: 61_000,
          delayMaxMs: 62_000,
          utilization: 1,
          cpuCoreRatio: 1,
        },
      } as HealthSummary,
      formatHealthChannelLines: () => [],
      ok: (value) => `ok(${value})`,
      warn: (value) => `warn(${value})`,
      muted: (value) => `muted(${value})`,
    });

    expect(rows).toEqual([
      { Item: "Gateway", Status: "ok(reachable)", Detail: "42ms" },
      {
        Item: "Event loop",
        Status: "warn(WARN)",
        Detail: "reasons event_loop_delay · max 62000ms · p99 61000ms · util 1 · cpu 1",
      },
    ]);
  });

  it("builds footer lines from update and reachability state", () => {
    expect(
      buildStatusFooterLines({
        updateHint: "upgrade ready",
        warn: (value) => `warn(${value})`,
        formatCliCommand: (value) => `cmd:${value}`,
        nodeOnlyGateway: null,
        gatewayReachable: false,
      }),
    ).toEqual([
      "FAQ: https://docs.openclaw.ai/faq",
      "Troubleshooting: https://docs.openclaw.ai/troubleshooting",
      "",
      "warn(upgrade ready)",
      "Next steps:",
      "  Need to share?      cmd:openclaw status --all",
      "  Need to debug live? cmd:openclaw logs --follow",
      "  Fix reachability first: cmd:openclaw gateway probe",
    ]);
  });

  it("builds plugin compatibility lines and pairing recovery guidance", () => {
    expect(
      buildStatusPluginCompatibilityLines({
        notices: [
          { severity: "warn" as const, message: "legacy" },
          { severity: "info" as const, message: "heads-up" },
          { severity: "warn" as const, message: "extra" },
        ],
        limit: 2,
        formatNotice: (notice) => notice.message,
        warn: (value) => `warn(${value})`,
        muted: (value) => `muted(${value})`,
      }),
    ).toEqual(["  warn(WARN) legacy", "  muted(INFO) heads-up", "muted(  … +1 more)"]);

    expect(
      buildStatusPairingRecoveryLines({
        pairingRecovery: {
          requestId: "req-123",
          reason: "scope-upgrade",
          remediationHint: "Review the requested scopes, then approve the pending upgrade.",
        },
        warn: (value) => `warn(${value})`,
        muted: (value) => `muted(${value})`,
        formatCliCommand: (value) => `cmd:${value}`,
      }),
    ).toEqual([
      "warn(Gateway scope upgrade approval required.)",
      "muted(Reason: device is asking for more scopes than currently approved.)",
      "muted(Hint: Review the requested scopes, then approve the pending upgrade.)",
      "muted(Recovery: cmd:openclaw devices approve req-123)",
      "muted(Fallback: cmd:openclaw devices approve --latest)",
      "muted(Inspect: cmd:openclaw devices list)",
    ]);
  });

  it("builds system event rows and health columns", () => {
    expect(
      buildStatusSystemEventsRows({
        queuedSystemEvents: ["one", "two", "three"],
        limit: 2,
      }),
    ).toEqual([{ Event: "one" }, { Event: "two" }]);
    expect(
      buildStatusSystemEventsTrailer({
        queuedSystemEvents: ["one", "two", "three"],
        limit: 2,
        muted: (value) => `muted(${value})`,
      }),
    ).toBe("muted(… +1 more)");
    expect(statusHealthColumns).toEqual([
      { key: "Item", header: "Item", minWidth: 10 },
      { key: "Status", header: "Status", minWidth: 8 },
      { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
    ]);
  });
});
