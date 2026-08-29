import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

function createDiagnosticFixture() {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const createRecord = (id: string) =>
    createPluginRecord({
      id,
      source: `/plugins/${id}/index.ts`,
      origin: "global",
      enabled: true,
      configSchema: false,
    });
  return { builder, createRecord };
}

describe("plugin registration diagnostics", () => {
  it("preserves ordered severity and call-time provenance across registrars and rollback", () => {
    const { builder, createRecord } = createDiagnosticFixture();
    const alpha = createRecord("alpha");
    const beta = createRecord("beta");
    const alphaApi = builder.createApi(alpha, { config: {} });
    const betaApi = builder.createApi(beta, { config: {} });
    alpha.source = "/plugins/alpha/resolved.ts";

    alphaApi.registerService({ id: "", start() {} });
    betaApi.registerContextEngine("", () => {
      throw new Error("invalid registration must not instantiate its factory");
    });
    alphaApi.registerReload({});
    betaApi.registerTextTransforms({});
    // @ts-expect-error JavaScript plugins may omit the required supplement builder.
    alphaApi.registerMemoryPromptSupplement(undefined);
    // @ts-expect-error JavaScript plugins may omit the required hosted-media resolver.
    betaApi.registerHostedMediaResolver(undefined);
    // @ts-expect-error Unknown JavaScript hook names must produce a diagnostic.
    alphaApi.on("unknown-hook", () => {});
    betaApi.registerRuntimeLifecycle({ id: "" });

    const expected = [
      ["error", "alpha", "/plugins/alpha/resolved.ts", "service registration missing id"],
      ["error", "beta", "/plugins/beta/index.ts", "context engine registration missing id"],
      ["warn", "alpha", "/plugins/alpha/resolved.ts", "reload registration missing prefixes"],
      [
        "warn",
        "beta",
        "/plugins/beta/index.ts",
        "text transform registration has no input or output replacements",
      ],
      [
        "error",
        "alpha",
        "/plugins/alpha/resolved.ts",
        "memory prompt supplement registration missing builder",
      ],
      [
        "error",
        "beta",
        "/plugins/beta/index.ts",
        "hosted media resolver registration missing resolver",
      ],
      ["warn", "alpha", "/plugins/alpha/resolved.ts", 'unknown typed hook "unknown-hook" ignored'],
      ["error", "beta", "/plugins/beta/index.ts", "runtime lifecycle registration missing id"],
    ].map(([level, pluginId, source, message]) => ({ level, pluginId, source, message }));
    expect(builder.registry.diagnostics).toEqual(expected);
    expect(builder.registry.services).toEqual([]);
    expect(builder.registry.contextEngines.size).toBe(0);
    expect(builder.registry.reloads).toEqual([]);
    expect(builder.registry.textTransforms).toEqual([]);
    expect(builder.registry.memoryPromptSupplements).toEqual([]);
    expect(builder.registry.hostedMediaResolvers).toEqual([]);
    expect(builder.registry.typedHooks).toEqual([]);
    expect(builder.registry.runtimeLifecycles).toEqual([]);

    alpha.source = "/plugins/alpha/later.ts";
    alphaApi.registerService({ id: "alpha-service", start() {} });
    betaApi.registerService({ id: "beta-service", start() {} });
    expect(builder.registry.services.map((entry) => entry.pluginId)).toEqual(["alpha", "beta"]);
    builder.rollbackPluginGlobalSideEffects(alpha.id, alpha);
    expect(builder.registry.services.map((entry) => entry.pluginId)).toEqual(["beta"]);
    builder.rollbackPluginGlobalSideEffects(beta.id, beta);
    expect(builder.registry.services).toEqual([]);
    expect(builder.registry.diagnostics).toEqual(expected);
  });

  it("keeps provider and catalog ownership unchanged after blank and duplicate registration", () => {
    const { builder, createRecord } = createDiagnosticFixture();
    const alpha = createRecord("alpha");
    const beta = createRecord("beta");
    const alphaApi = builder.createApi(alpha, { config: {} });
    const betaApi = builder.createApi(beta, { config: {} });
    const speech = {
      id: "shared-speech",
      label: "Shared speech",
      models: ["speech-model"],
      isConfigured: () => true,
      synthesize: async () => {
        throw new Error("registration must not synthesize audio");
      },
    } satisfies Parameters<OpenClawPluginApi["registerSpeechProvider"]>[0];
    const media = { id: "shared-media" };
    alphaApi.registerSpeechProvider(speech);
    alphaApi.registerMediaUnderstandingProvider(media);

    betaApi.registerSpeechProvider({ ...speech, id: " " });
    betaApi.registerSpeechProvider({ ...speech, label: "Rejected replacement" });
    betaApi.registerMediaUnderstandingProvider({ id: " " });
    betaApi.registerMediaUnderstandingProvider({ ...media });

    expect(builder.registry.diagnostics).toEqual(
      [
        "speech provider registration missing id",
        "speech provider already registered: shared-speech (alpha)",
        "media provider registration missing id",
        "media provider already registered: shared-media (alpha)",
      ].map((message) => ({
        level: "error",
        pluginId: "beta",
        source: "/plugins/beta/index.ts",
        message,
      })),
    );
    expect(
      builder.registry.speechProviders.map(({ pluginId, provider }) => ({ pluginId, provider })),
    ).toEqual([{ pluginId: "alpha", provider: speech }]);
    expect(
      builder.registry.mediaUnderstandingProviders.map(({ pluginId, provider }) => ({
        pluginId,
        provider,
      })),
    ).toEqual([{ pluginId: "alpha", provider: media }]);
    expect(alpha.speechProviderIds).toEqual(["shared-speech"]);
    expect(alpha.mediaUnderstandingProviderIds).toEqual(["shared-media"]);
    expect(beta.speechProviderIds).toEqual([]);
    expect(beta.mediaUnderstandingProviderIds).toEqual([]);
    expect(
      builder.registry.modelCatalogProviders.map(({ pluginId, provider }) => ({
        pluginId,
        provider: provider.provider,
        kinds: provider.kinds,
      })),
    ).toEqual([{ pluginId: "alpha", provider: "shared-speech", kinds: ["voice"] }]);
  });

  it.each([false, true])(
    "keeps reentrant diagnostics host-owned and stops coercion after register closes (throws=%s)",
    (throws) => {
      const { builder, createRecord } = createDiagnosticFixture();
      const record = createRecord("owner");
      let captured: OpenClawPluginApi | undefined;
      let coercions = 0;
      // Exercise the existing unknown-hook path for untyped plugin input, not host-record accessors.
      const hookName = {
        toString() {
          coercions += 1;
          const api = expectDefined(captured, "captured registration API");
          api.id = "plugin-copy";
          api.source = "/plugins/plugin-copy.ts";
          api.registerReload({});
          return "unknown-hook";
        },
      };
      const register = () =>
        runPluginRegisterSyncInRegistry(
          (api) => {
            captured = api;
            // @ts-expect-error Untyped hook input reaches the existing rejection/coercion path.
            api.on(hookName, () => {});
            if (throws) {
              throw new Error("registration failed");
            }
          },
          builder.createApi(record, { config: {} }),
          builder.registry,
          record.id,
        );
      if (throws) {
        expect(register).toThrow("registration failed");
      } else {
        register();
      }

      const expected = [
        {
          level: "warn",
          pluginId: "owner",
          source: "/plugins/owner/index.ts",
          message: "reload registration missing prefixes",
        },
        {
          level: "warn",
          pluginId: "owner",
          source: "/plugins/owner/index.ts",
          message: 'unknown typed hook "unknown-hook" ignored',
        },
      ];
      expect(builder.registry.diagnostics).toEqual(expected);
      expect(record.id).toBe("owner");
      expect(record.source).toBe("/plugins/owner/index.ts");
      const retained = expectDefined(captured, "captured registration API");
      // @ts-expect-error Closed registration must stop before coercing untyped hook input.
      expect(retained.on(hookName, () => {})).toBeUndefined();
      expect(coercions).toBe(1);
      expect(builder.registry.diagnostics).toEqual(expected);
      expect(builder.registry.typedHooks).toEqual([]);
      expect(builder.registry.reloads).toEqual([]);
    },
  );
});
