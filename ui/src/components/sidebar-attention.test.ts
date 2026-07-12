/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import { buildSidebarAttentionItems } from "./sidebar-attention.ts";

const NOW = 1_750_000_000_000;

function cronJob(overrides: Partial<CronJob>): CronJob {
  return { id: "job", enabled: true, ...overrides } as CronJob;
}

function authStatus(providers: ReadonlyArray<Record<string, unknown>>): ModelAuthStatusResult {
  return { ts: NOW, providers } as unknown as ModelAuthStatusResult;
}

describe("buildSidebarAttentionItems", () => {
  it("returns nothing when everything is healthy", () => {
    const items = buildSidebarAttentionItems({
      cronJobs: [cronJob({ state: { lastRunStatus: "ok" } as CronJob["state"] })],
      modelAuthStatus: authStatus([
        {
          provider: "openai",
          displayName: "Codex",
          status: "ok",
          profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
        },
      ]),
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it("flags enabled failing cron jobs but not disabled ones", () => {
    const items = buildSidebarAttentionItems({
      cronJobs: [
        cronJob({ state: { lastRunStatus: "error" } as CronJob["state"] }),
        cronJob({ enabled: false, state: { lastRunStatus: "error" } as CronJob["state"] }),
      ],
      modelAuthStatus: null,
      now: NOW,
    });
    expect(items).toEqual([
      {
        severity: "error",
        icon: "clock",
        label: "1 cron job(s) failed",
        routeId: "cron",
      },
    ]);
  });

  it("flags overdue jobs only past the grace window", () => {
    const items = buildSidebarAttentionItems({
      cronJobs: [
        cronJob({ state: { nextRunAtMs: NOW - 400_000 } as CronJob["state"] }),
        cronJob({ state: { nextRunAtMs: NOW - 100_000 } as CronJob["state"] }),
        cronJob({ enabled: false, state: { nextRunAtMs: NOW - 400_000 } as CronJob["state"] }),
      ],
      modelAuthStatus: null,
      now: NOW,
    });
    expect(items).toEqual([
      {
        severity: "warning",
        icon: "clock",
        label: "1 cron job(s) overdue",
        routeId: "cron",
      },
    ]);
  });

  it("splits monitored providers into expired and expiring chips", () => {
    const items = buildSidebarAttentionItems({
      cronJobs: [],
      modelAuthStatus: authStatus([
        {
          provider: "openai",
          displayName: "Codex",
          status: "expired",
          profiles: [{ profileId: "codex", type: "oauth", status: "expired" }],
        },
        {
          provider: "anthropic",
          displayName: "Claude",
          status: "expiring",
          profiles: [{ profileId: "claude", type: "oauth", status: "ok" }],
          expiry: { at: NOW + 6 * 86_400_000, label: "6d" },
        },
        {
          // API-key-only providers are not monitored and must stay silent.
          provider: "static",
          displayName: "Static",
          status: "expired",
          profiles: [{ profileId: "static", type: "api-key", status: "ok" }],
        },
      ]),
      now: NOW,
    });
    expect(items).toEqual([
      {
        severity: "error",
        icon: "plug",
        label: "Model auth expired: Codex",
        routeId: "model-providers",
      },
      {
        severity: "warning",
        icon: "plug",
        label: "Model auth expiring: Claude (6d)",
        routeId: "model-providers",
      },
    ]);
  });
});
