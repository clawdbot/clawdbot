import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Debug copy loads with its page and overlay; the sidebar's overlay title stays eager.
const enDebug = {
  debug: {
    snapshotsTitle: "Snapshots",
    snapshotsSubtitle: "Status, health, and heartbeat data.",
    refreshingSnapshots: "Refreshing Gateway diagnostics.",
    offlineSnapshots: "Connect to the Gateway to refresh diagnostics.",
    status: "Status",
    health: "Health",
    lastHeartbeat: "Last heartbeat",
    security: {
      audit: "Security audit",
      critical: "{count} critical",
      warnings: "{count} warnings",
      noCriticalIssues: "No critical issues",
      info: "{count} info",
      runPrefix: "Run",
      runSuffix: "for details.",
    },
    manualRpcTitle: "Manual RPC",
    manualRpcSubtitle: "Send a raw gateway method with JSON params.",
    callFailed: "Call failed",
    method: "Method",
    selectMethod: "Select a method…",
    paramsJson: "Params (JSON)",
    modelsTitle: "Models",
    modelsSubtitle: "Catalog from models.list.",
    eventLogTitle: "Event Log",
    eventLogSubtitle: "Latest gateway events.",
    noEvents: "No events yet.",
    lanes: {
      title: "Lanes",
      subtitle: "Live command-lane capacity and queue pressure.",
      lane: "Lane",
      sessionLanes: "Session lanes · {count}",
      active: "Active",
      queued: "Queued",
      group: "Group",
      blocked: "Blocked",
    },
    overlay: {
      ...en.debug.overlay,
      eyebrow: "Live diagnostics",
      open: "Open overlay",
      openWithShortcut: "Open overlay · {shortcut}",
      unavailable: "Unavailable",
      lanes: "Lanes",
      status: "Event loop / status",
      activeRuns: "Active runs",
      events: "Events",
      cpu: "CPU",
      memory: "Memory",
      disk: "Disk",
      memoryMb: "{value} MB",
      loopShort: "loop {value}",
      heapShort: "heap {value}",
      maxShort: "max {value}",
      freeShort: "{value} free",
      totalShort: "{value} total",
      delayP99: "Delay p99",
      uptime: "Uptime",
      activeRunsCount: "{count} active",
      noActiveRuns: "No active runs.",
    },
  },
} satisfies TranslationMap;

export const registerDebugEnglish = Object.assign(
  () => {
    const { overlay, ...sections } = enDebug.debug;
    // Keep the eager title and existing namespace readers intact.
    Object.assign(en.debug, sections);
    Object.assign(en.debug.overlay, overlay);
  },
  { catalog: enDebug },
);
