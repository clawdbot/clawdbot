import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { useMockHttp } from "../test-utils/mock-http.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { buildTelemetryPayload, checkTelemetryUpdate } from "./telemetry.js";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TELEMETRY_URL = "https://telemetry.openclaw.ai/api/latest-version";
const TELEMETRY_STATE_KEY = "telemetry.updateCheck";
const mockHttp = useMockHttp();

function createFeatureConfig(enabled = true): OpenClawConfig {
  return {
    telemetry: { enabled },
    auth: {
      profiles: {
        "anthropic:private-account": {
          provider: "anthropic",
          mode: "api_key",
          email: "private@example.invalid",
        },
      },
    },
    channels: {
      telegram: { enabled: true, botToken: "private-telegram-token" },
      discord: { enabled: true, token: "private-discord-token" },
      slack: { enabled: false, botToken: "private-slack-token" },
      defaults: { groupPolicy: "allowlist" },
      modelByChannel: { telegram: { "private-account-id": "openai/private-model" } },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://private-provider.example.invalid/v1",
          apiKey: "private-provider-api-key",
          models: [],
        },
        anthropic: {
          baseUrl: "https://private-anthropic.example.invalid/v1",
          apiKey: "private-anthropic-api-key",
          models: [],
        },
      },
    },
    plugins: {
      entries: {
        telegram: { enabled: true },
        discord: { enabled: true },
        memory: { enabled: true },
        disabled: { enabled: false },
      },
    },
    gateway: { auth: { mode: "token", token: "private-gateway-token" } },
  };
}

describe("anonymous telemetry", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-telemetry-",
      env: {
        DO_NOT_TRACK: undefined,
        OPENCLAW_NIX_MODE: undefined,
        OPENCLAW_NO_AUTO_UPDATE: undefined,
        OPENCLAW_TELEMETRY_ENDPOINT: undefined,
      },
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  it("builds deterministic feature facts without credentials, identities, paths, or hostnames", () => {
    const payload = buildTelemetryPayload(createFeatureConfig(), { surface: "gateway" });
    const serialized = JSON.stringify(payload);

    expect(payload).toEqual({
      schema: 1,
      version: expect.any(String),
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      surface: "gateway",
      features: {
        channels: ["discord", "telegram"],
        providerFamilies: ["anthropic", "openai"],
        pluginsEnabled: 3,
        sessionsLast24h: expect.any(Number),
      },
    });
    expect(serialized).not.toMatch(
      /"(?:id|accountId|userId|machineId|installId|token|apiKey|secret|password|prompt|message|host|hostname|baseUrl|path|email|models)"\s*:/iu,
    );
    expect(serialized).not.toContain("private-");
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain(testState.stateDir);
    expect(payload.features.sessionsLast24h).toBeGreaterThanOrEqual(0);
  });

  it("counts auto-enabled channel plugins and provider families configured through agent models", () => {
    const payload = buildTelemetryPayload(
      {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/private-model",
              fallbacks: ["openai/private-fallback"],
            },
          },
          entries: {
            researcher: { model: "google/private-research-model" },
          },
        },
        channels: { whatsapp: { allowFrom: ["+15555550123"] } },
      },
      { surface: "gateway" },
    );

    expect(payload.features).toMatchObject({
      channels: ["whatsapp"],
      providerFamilies: ["anthropic", "google", "openai"],
      pluginsEnabled: 1,
    });
    expect(JSON.stringify(payload)).not.toContain("private-");
    expect(JSON.stringify(payload)).not.toContain("+15555550123");
  });

  it("counts only session creation events from the previous 24 hours", async () => {
    const { recordSessionStateEvent } = await import("../sessions/session-state-events.js");
    const now = Date.now();
    for (const event of [
      { sessionKey: "recent", kind: "created" as const, occurredAt: now - 1000 },
      { sessionKey: "older", kind: "created" as const, occurredAt: now - DAY_MS - 1000 },
      { sessionKey: "other", kind: "run_completed" as const, occurredAt: now - 1000 },
    ]) {
      recordSessionStateEvent(
        {
          ...event,
          agentId: "main",
          actorType: "system",
          summary: "test session event",
        },
        { now: event.occurredAt },
      );
    }

    expect(buildTelemetryPayload({}, { surface: "gateway" }).features.sessionsLast24h).toBe(1);
  });

  it("sends at most one request per 24 hours and reuses the persisted update result", async () => {
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.24", note: "A newer release is available." } },
    });
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.25" } },
    });
    const options = { surface: "gateway" as const, fetchImpl: globalThis.fetch };

    const first = await checkTelemetryUpdate({}, { ...options, nowMs: NOW });
    const cached = await checkTelemetryUpdate({}, { ...options, nowMs: NOW + DAY_MS - 1 });

    expect(first).toEqual({ version: "2026.8.24", note: "A newer release is available." });
    expect(cached).toEqual(first);
    expect(mockHttp.requests()).toHaveLength(1);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual({
      lastPingAt: NOW,
      latestVersion: "2026.8.24",
      note: "A newer release is available.",
    });

    const refreshed = await checkTelemetryUpdate({}, { ...options, nowMs: NOW + DAY_MS + 1 });

    expect(refreshed).toEqual({ version: "2026.8.25" });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toEqual({
      lastPingAt: NOW + DAY_MS + 1,
      latestVersion: "2026.8.25",
    });
  });

  it.each([
    { name: "never opted in", config: {} satisfies OpenClawConfig },
    { name: "explicitly opted out", config: createFeatureConfig(false) },
  ])("sends only an anonymous GET when $name", async ({ config }) => {
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "GET",
      requestHeaders: {
        "user-agent": `openclaw/${VERSION} (${process.platform}; node/${process.versions.node}; ${process.arch}; gateway)`,
      },
      reply: { json: { version: "2026.8.24" } },
    });

    await expect(
      checkTelemetryUpdate(config, {
        surface: "gateway",
        fetchImpl: globalThis.fetch,
        nowMs: NOW,
      }),
    ).resolves.toEqual({ version: "2026.8.24" });

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it("POSTs exactly the canonical payload only after explicit feature-stats opt-in", async () => {
    const config = createFeatureConfig();
    const expectedBody = JSON.stringify(buildTelemetryPayload(config, { surface: "gateway" }));
    mockHttp.intercept({
      url: TELEMETRY_URL,
      method: "POST",
      requestBody: expectedBody,
      requestHeaders: { "content-type": /^application\/json(?:\s*;.*)?$/u },
      reply: { json: { version: "2026.8.24" } },
    });

    await expect(
      checkTelemetryUpdate(config, {
        surface: "gateway",
        fetchImpl: globalThis.fetch,
        nowMs: NOW,
      }),
    ).resolves.toEqual({ version: "2026.8.24" });

    expect(mockHttp.requests()).toHaveLength(1);
  });

  it.each(["1", "true"])(
    "DO_NOT_TRACK=%s suppresses feature stats but keeps update checks",
    async (value) => {
      setTestEnvValue("DO_NOT_TRACK", value);
      mockHttp.intercept({
        url: TELEMETRY_URL,
        method: "GET",
        reply: { json: { version: "2026.8.24" } },
      });

      await expect(
        checkTelemetryUpdate(createFeatureConfig(), {
          surface: "gateway",
          fetchImpl: globalThis.fetch,
          nowMs: NOW,
        }),
      ).resolves.toEqual({ version: "2026.8.24" });

      expect(mockHttp.requests()).toHaveLength(1);
    },
  );

  it("never sends a request when startup update checks are disabled", async () => {
    await expect(
      checkTelemetryUpdate(
        { ...createFeatureConfig(), update: { checkOnStart: false } },
        { surface: "gateway", fetchImpl: globalThis.fetch, nowMs: NOW },
      ),
    ).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(0);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toBeUndefined();
  });

  it("never sends a request when OPENCLAW_NO_AUTO_UPDATE disables update checks", async () => {
    setTestEnvValue("OPENCLAW_NO_AUTO_UPDATE", "1");

    await expect(
      checkTelemetryUpdate(createFeatureConfig(), {
        surface: "gateway",
        fetchImpl: globalThis.fetch,
        nowMs: NOW,
      }),
    ).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(0);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toBeUndefined();
  });

  it("never sends a request for Nix-managed installations", async () => {
    setTestEnvValue("OPENCLAW_NIX_MODE", "1");

    await expect(
      checkTelemetryUpdate(createFeatureConfig(), {
        surface: "gateway",
        fetchImpl: globalThis.fetch,
        nowMs: NOW,
      }),
    ).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(0);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toBeUndefined();
  });

  it("never accesses the network in a test environment without an injected fetch", async () => {
    await expect(checkTelemetryUpdate({}, { surface: "gateway", nowMs: NOW })).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(0);
  });

  it("uses the configured telemetry endpoint instead of the public endpoint", async () => {
    const customEndpoint = "https://telemetry.example.invalid/api/latest-version";
    setTestEnvValue("OPENCLAW_TELEMETRY_ENDPOINT", customEndpoint);
    mockHttp.intercept({
      url: customEndpoint,
      reply: { json: { version: "2026.8.24" } },
    });

    await expect(
      checkTelemetryUpdate({}, { surface: "cli", fetchImpl: globalThis.fetch, nowMs: NOW }),
    ).resolves.toEqual({ version: "2026.8.24" });

    expect(mockHttp.requests().map((request) => request.fullUrl)).toEqual([customEndpoint]);
  });

  it.each([
    { name: "HTTP errors", reply: { status: 503, json: { version: "2026.8.24" } } },
    { name: "a missing version", reply: { json: { note: "Missing required version" } } },
    { name: "a non-string version", reply: { json: { version: 20260824 } } },
    { name: "invalid JSON", reply: { body: "{invalid" } },
    { name: "network failures", reply: new Error("network unavailable") },
  ])("fails silently on $name without stamping a successful ping", async ({ reply }) => {
    mockHttp.intercept({ url: TELEMETRY_URL, reply });

    await expect(
      checkTelemetryUpdate({}, { surface: "gateway", fetchImpl: globalThis.fetch, nowMs: NOW }),
    ).resolves.toBeNull();

    expect(mockHttp.requests()).toHaveLength(1);
    expect(readConfigMachineState(TELEMETRY_STATE_KEY)).toBeUndefined();
  });

  it("bounds untrusted remote update notes before display or persistence", async () => {
    mockHttp.intercept({
      url: TELEMETRY_URL,
      reply: { json: { version: "2026.8.24", note: "x".repeat(800) } },
    });

    const result = await checkTelemetryUpdate(
      {},
      {
        surface: "gateway",
        fetchImpl: globalThis.fetch,
        nowMs: NOW,
      },
    );
    const persisted = readConfigMachineState<{ note?: string }>(TELEMETRY_STATE_KEY);

    expect(result?.note).toHaveLength(500);
    expect(persisted?.note).toHaveLength(500);
  });
});
