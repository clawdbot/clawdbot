import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";

const PLUGIN_MANIFEST_ENV_KEYS = [
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
] as const;

function cleanPluginManifestEnv(): Record<(typeof PLUGIN_MANIFEST_ENV_KEYS)[number], undefined> {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    OPENCLAW_SKIP_PROVIDERS: undefined,
    OPENCLAW_SKIP_CHANNELS: undefined,
    OPENCLAW_SKIP_CRON: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
  };
}

let listKnownProviderEnvApiKeyNames: typeof import("./model-auth-env-vars.js").listKnownProviderEnvApiKeyNames;
let GCP_VERTEX_CREDENTIALS_MARKER: typeof import("./model-auth-markers.js").GCP_VERTEX_CREDENTIALS_MARKER;
let NON_ENV_SECRETREF_MARKER: typeof import("./model-auth-markers.js").NON_ENV_SECRETREF_MARKER;
let isKnownEnvApiKeyMarker: typeof import("./model-auth-markers.js").isKnownEnvApiKeyMarker;
let isNonSecretApiKeyMarker: typeof import("./model-auth-markers.js").isNonSecretApiKeyMarker;
let listKnownNonSecretApiKeyMarkers: typeof import("./model-auth-markers.js").listKnownNonSecretApiKeyMarkers;
let resolveOAuthApiKeyMarker: typeof import("./model-auth-markers.js").resolveOAuthApiKeyMarker;
let manifestEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

async function loadMarkerModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  const [envVarsModule, markersModule] = await Promise.all([
    import("./model-auth-env-vars.js"),
    import("./model-auth-markers.js"),
  ]);
  listKnownProviderEnvApiKeyNames = envVarsModule.listKnownProviderEnvApiKeyNames;
  GCP_VERTEX_CREDENTIALS_MARKER = markersModule.GCP_VERTEX_CREDENTIALS_MARKER;
  NON_ENV_SECRETREF_MARKER = markersModule.NON_ENV_SECRETREF_MARKER;
  isKnownEnvApiKeyMarker = markersModule.isKnownEnvApiKeyMarker;
  isNonSecretApiKeyMarker = markersModule.isNonSecretApiKeyMarker;
  listKnownNonSecretApiKeyMarkers = markersModule.listKnownNonSecretApiKeyMarkers;
  resolveOAuthApiKeyMarker = markersModule.resolveOAuthApiKeyMarker;
}

beforeAll(async () => {
  await withEnvAsync(cleanPluginManifestEnv(), loadMarkerModules);
});

beforeEach(() => {
  manifestEnvSnapshot = captureEnv([...PLUGIN_MANIFEST_ENV_KEYS]);
  for (const key of PLUGIN_MANIFEST_ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  manifestEnvSnapshot?.restore();
  manifestEnvSnapshot = undefined;
});

describe("model auth markers", () => {
  it("recognizes explicit non-secret markers", () => {
    expect(isNonSecretApiKeyMarker(NON_ENV_SECRETREF_MARKER)).toBe(true);
    expect(isNonSecretApiKeyMarker(resolveOAuthApiKeyMarker("chutes"))).toBe(true);
    expect(isNonSecretApiKeyMarker("ollama-local")).toBe(true);
    expect(isNonSecretApiKeyMarker("lmstudio-local")).toBe(true);
    expect(isNonSecretApiKeyMarker("codex-app-server")).toBe(true);
    expect(isNonSecretApiKeyMarker(GCP_VERTEX_CREDENTIALS_MARKER)).toBe(true);
  });

  it("reads bundled plugin-owned non-secret markers from manifests", () => {
    expect(listKnownNonSecretApiKeyMarkers()).toEqual(
      expect.arrayContaining([
        "codex-app-server",
        "gcp-vertex-credentials",
        "lmstudio-local",
        "minimax-oauth",
        "ollama-local",
      ]),
    );
  });

  it("does not treat removed provider markers as active auth markers", () => {
    expect(isNonSecretApiKeyMarker("qwen-oauth")).toBe(false);
  });

  it("recognizes known env marker names but not arbitrary all-caps keys", () => {
    expect(isNonSecretApiKeyMarker("OPENAI_API_KEY")).toBe(true);
    expect(isNonSecretApiKeyMarker("ALLCAPS_EXAMPLE")).toBe(false);
  });

  it("recognizes all built-in provider env marker names", () => {
    for (const envVarName of listKnownProviderEnvApiKeyNames()) {
      expect(isNonSecretApiKeyMarker(envVarName)).toBe(true);
    }
  });

  it("can exclude env marker-name interpretation for display-only paths", () => {
    expect(isNonSecretApiKeyMarker("OPENAI_API_KEY", { includeEnvVarName: false })).toBe(false);
  });

  it("excludes aws-sdk env markers from known api key env marker helper", () => {
    expect(isKnownEnvApiKeyMarker("OPENAI_API_KEY")).toBe(true);
    expect(isKnownEnvApiKeyMarker("AWS_PROFILE")).toBe(false);
  });
});
