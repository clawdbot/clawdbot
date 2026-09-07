import { afterEach, describe, expect, it } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "../../agents/model-auth-markers.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";

const credential = "synthetic-resolved-provider-credential";

function sourceConfig(id = "provider-key") {
  return {
    models: {
      providers: {
        diagnostic: {
          baseUrl: "https://diagnostic.invalid/v1",
          api: "openai-completions",
          apiKey: { source: "exec", provider: "diagnostic", id },
          models: [],
        },
      },
    },
    secrets: {
      providers: {
        diagnostic: { source: "exec", command: "/synthetic/credential-provider" },
      },
    },
  } satisfies OpenClawConfig;
}

function publishResolvedConfig(source: ReturnType<typeof sourceConfig>) {
  const resolved = {
    ...source,
    models: {
      providers: {
        diagnostic: { ...source.models.providers.diagnostic, apiKey: credential },
      },
    },
  };
  setRuntimeConfigSnapshot(resolved, source);
  return resolved;
}

function overview(cfg: OpenClawConfig) {
  return resolveProviderAuthOverview({
    provider: "diagnostic",
    cfg,
    store: { version: 1, profiles: {} },
    modelsPath: "/synthetic/models.json",
    aliasMap: {},
    envCandidateMap: { diagnostic: [] },
    authEvidenceMap: { diagnostic: [] },
  });
}

describe("resolved non-env config credentials in the auth overview", () => {
  afterEach(() => clearRuntimeConfigSnapshot());

  it("shows the resolved config source without exposing its credential", () => {
    const cfg = publishResolvedConfig(sourceConfig());

    const result = overview(cfg);

    expect(result.effective).toEqual({
      kind: "models.json",
      detail: `marker(${NON_ENV_SECRETREF_MARKER})`,
    });
    expect(result.modelsJson?.value).toBe(`marker(${NON_ENV_SECRETREF_MARKER})`);
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("keeps a cold configured reference missing without resolved material", () => {
    const result = overview(sourceConfig());

    expect(result.effective).toEqual({ kind: "missing", detail: "missing" });
    expect(result.modelsJson?.value).toBe(`marker(${NON_ENV_SECRETREF_MARKER})`);
  });

  it("does not borrow resolved material after the configured reference changes", () => {
    publishResolvedConfig(sourceConfig("old-reference"));

    const result = overview(sourceConfig("new-reference"));

    expect(result.effective).toEqual({ kind: "missing", detail: "missing" });
    expect(JSON.stringify(result)).not.toContain(credential);
  });
});
