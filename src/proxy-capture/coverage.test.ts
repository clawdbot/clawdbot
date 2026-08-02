// Proxy capture coverage tests cover capture coverage accounting and summaries.
import { describe, expect, it } from "vitest";
import { buildDebugProxyCoverageReport } from "./coverage.js";

describe("debug proxy coverage report", () => {
  it("summarizes captured and partial transport seams", () => {
    const report = buildDebugProxyCoverageReport();

    expect(report.summary.total).toBe(report.entries.length);
    expect(report.summary.captured).toBeGreaterThan(0);
    expect(report.summary.proxyOnly).toBeGreaterThan(0);
    const entryIds = new Set(report.entries.map((entry) => entry.id));
    expect(entryIds.has("provider-transport-fetch")).toBe(true);
    expect(entryIds.has("feishu-client-http")).toBe(true);
  });

  it.each([
    ["discord-rest", "extensions/discord/src/monitor/rest-fetch.ts"],
    ["discord-gateway", "extensions/discord/src/monitor/gateway-plugin.ts"],
    ["telegram-fetch", "extensions/telegram/src/fetch.ts"],
    ["mattermost-ws", "extensions/mattermost/src/mattermost/monitor-websocket.ts"],
    ["feishu-client-http", "extensions/feishu/src/client.ts"],
    ["feishu-client-ws", "extensions/feishu/src/client.ts"],
  ])("reports the canonical source module for %s", (entryId, modulePath) => {
    const entry = buildDebugProxyCoverageReport().entries.find(({ id }) => id === entryId);

    expect(entry?.modulePath).toBe(modulePath);
  });
});
