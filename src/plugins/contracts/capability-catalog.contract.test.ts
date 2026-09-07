import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
  PluginCapabilityCatalogEntry,
  PluginCapabilityCatalogContext,
} from "../capability-catalog-context.types.js";

// These are actual import traps: descriptor construction must never evaluate host runtime/auth.
vi.mock("../loader-runtime-load.js", () => {
  throw new Error("cold catalog imported full plugin loader");
});
vi.mock("../capability-provider-runtime.js", () => {
  throw new Error("cold catalog imported capability runtime");
});
vi.mock("../../plugin-sdk/provider-auth.js", () => {
  throw new Error("cold catalog imported broad auth SDK");
});

vi.mock("../../realtime-transcription/websocket-session.js", () => {
  throw new Error("cold catalog imported transcription transport");
});

vi.mock("../../agents/provider-request-config.js", () => {
  throw new Error("cold catalog imported provider headers");
});

vi.mock("../../proxy-capture/runtime.js", () => {
  throw new Error("cold catalog imported capture runtime");
});

vi.mock("../../infra/http-body.js", () => {
  throw new Error("cold catalog imported inbound HTTP runtime");
});

vi.mock("../../logging/redact.js", () => {
  throw new Error("cold catalog imported logging redaction");
});

const extensions = fileURLToPath(new URL("../../../extensions/", import.meta.url));
const families = [
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
] as const;
const fixtures = fs.readdirSync(extensions).flatMap((dir) => {
  const root = path.join(extensions, dir);
  const manifestPath = path.join(root, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const contracts = Object.fromEntries(
    families
      .filter((key) => manifest.contracts?.[key]?.length)
      .map((key) => [key, manifest.contracts[key]]),
  );
  return Object.keys(contracts).length ? [{ dir, root, manifest, contracts }] : [];
});

const unavailable = () => {
  throw new Error("catalog construction invoked host runtime");
};
const context: PluginCapabilityCatalogContext = {
  isProviderApiKeyConfigured: unavailable,
  isProviderAuthProfileConfigured: unavailable,
  resolveAgentDir: unavailable,
  createRealtimeTranscriptionWebSocketSession: unavailable,
  resolveProviderRequestHeaders: unavailable,
  resolveProviderAuthProfileApiKey: unavailable,
  resolveApiKeyForProvider: unavailable,
  captureWsEvent: unavailable,
  createDebugProxyWebSocketAgent: unavailable,
  resolveDebugProxySettings: unavailable,
  fetchWithSsrFGuard: unavailable,
  createProviderHttpError: unavailable,
  readProviderJsonResponse: unavailable,
  readProviderTextResponse: unavailable,
  formatErrorMessage: unavailable,
  warn: unavailable,
  redactSensitiveText: unavailable,
};

describe("bundled capability catalog import boundary", () => {
  it.each(fixtures)(
    "constructs $dir descriptors without runtime or auth discovery",
    async ({ root, manifest, contracts }) => {
      expect(manifest.capabilityCatalogEntry).toEqual(expect.any(String));
      const module = await import(
        pathToFileURL(path.resolve(root, manifest.capabilityCatalogEntry)).href
      );
      const entry = module.default as PluginCapabilityCatalogEntry;
      const catalog = typeof entry === "function" ? entry(context) : entry;
      for (const [family, ids] of Object.entries(contracts)) {
        const providers = catalog[family as keyof typeof catalog]!;
        for (const id of ids as string[]) {
          expect(
            providers.some((provider) => provider.id === id || provider.aliases?.includes(id)),
          ).toBe(true);
        }
        expect(providers.every((provider) => (ids as string[]).includes(provider.id))).toBe(true);
        for (const provider of providers) {
          expect(provider.label).toEqual(expect.any(String));
          expect(provider.isConfigured).toEqual(expect.any(Function));
        }
      }
      // OpenAI's readiness/control methods are deliberately non-enumerable.
      const internal = catalog.realtimeVoiceProviders?.flatMap((provider) =>
        Object.getOwnPropertySymbols(provider),
      );
      if (internal?.length) {
        const provider = catalog.realtimeVoiceProviders![0]!;
        for (const key of internal) {
          expect(Object.getOwnPropertyDescriptor(provider, key)?.enumerable).toBe(false);
        }
      }
    },
  );
});

afterAll(() => {
  vi.doUnmock("../loader-runtime-load.js");
  vi.doUnmock("../capability-provider-runtime.js");
  vi.doUnmock("../../plugin-sdk/provider-auth.js");
  vi.doUnmock("../../realtime-transcription/websocket-session.js");
  vi.doUnmock("../../agents/provider-request-config.js");
  vi.doUnmock("../../proxy-capture/runtime.js");
  vi.doUnmock("../../infra/http-body.js");
  vi.doUnmock("../../logging/redact.js");
  vi.resetModules();
});
