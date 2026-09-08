/* @vitest-environment jsdom */
import "../../../ui/src/test-helpers/lit-warnings.setup.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../ui/src/i18n/index.ts";
import { createFirstRunContext } from "../../../ui/src/pages/model-setup/model-setup-first-run.test-support.ts";
import { ModelSetupPage } from "../../../ui/src/pages/model-setup/model-setup-page.ts";
import { createApplicationContextProvider } from "../../../ui/src/test-helpers/application-context.ts";
import { createStorageMock } from "../../../ui/src/test-helpers/storage.ts";
import { waitForFast } from "../../../ui/src/test-helpers/wait-for.ts";
import { applyWizardMetadata } from "../../commands/onboard-helpers.js";
import { createConfigFileSnapshot } from "../../config/io.snapshot-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { initializeNativeSessionCatalogPreferences } from "../../plugins/native-session-catalog-config.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { systemAgentHandlers } from "./system-agent.js";

const fixture = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  exists: false,
  additionalCatalog: false,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshotWithPluginMetadata: async () => ({
    snapshot: createConfigFileSnapshot({
      path: "/tmp/synthetic-onboarding/openclaw.json",
      exists: fixture.exists,
      valid: true,
      raw: null,
      parsed: fixture.config,
      sourceConfig: fixture.config,
      runtimeConfig: fixture.config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    }),
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: fixture.additionalCatalog
        ? [
            {
              id: "fixture-catalog",
              setup: {
                nativeSessionCatalog: { label: "Fixture archive", legacyDefaultEnabled: true },
              },
            },
          ]
        : [],
    }),
  }),
}));
vi.mock("../../plugins/provider-install-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-install-catalog.js")>()),
  resolveProviderInstallCatalogEntries: () => [],
}));
vi.mock("../../system-agent/setup-inference-detection.js", () => ({
  // Replace worker/process discovery only. Actual handler parameters, authored
  // config interpretation, consent decision, RPC client and UI all compose here.
  detectSetupInferenceIsolated: async (params: { agentId?: string }) => {
    const { detectSetupInference } = await import("../../system-agent/setup-inference-detect.js");
    return detectSetupInference(
      {
        resolveManifestProviderAuthChoices: () => [],
        detectInferenceBackends: async () => [],
        probeLocalCommand: async (command) => ({ command, found: false }),
      },
      params.agentId,
    );
  },
}));

describe("selected-agent Gateway detection and Model Setup consent", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
  });
  afterEach(async () => {
    document.body.replaceChildren();
    await vi.dynamicImportSettled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    "unwritten",
    "initialized",
    "doctor",
    "onboard",
    "upgrade",
    "authored",
    "additional-catalog",
  ] as const)(
    "uses server-owned first-install evidence for %s selected-agent setup",
    async (state) => {
      const authored: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      };
      fixture.exists = state !== "unwritten";
      fixture.additionalCatalog = state === "additional-catalog";
      fixture.config =
        state === "unwritten"
          ? {}
          : state === "upgrade"
            ? authored
            : initializeNativeSessionCatalogPreferences(authored);
      if (state === "doctor" || state === "onboard") {
        fixture.config = applyWizardMetadata(fixture.config, { command: state, mode: "local" });
      }
      if (state === "authored") {
        fixture.config.plugins!.entries!.codex!.config = { sessionCatalog: { enabled: true } };
      }
      const { context, request } = createFirstRunContext();
      const agentId = state === "unwritten" ? "main" : "research";
      Object.assign(context.agentSelection.state, { selectedId: agentId, scopeId: agentId });
      request.mockImplementation(async (method, params) => {
        if (method === "openclaw.setup.detect") {
          const handler = systemAgentHandlers[method]!;
          return await new Promise((resolve, reject) => {
            const response = handler({
              params,
              respond: (ok, payload, error) =>
                ok ? resolve(payload) : reject(new Error(error?.message, { cause: error })),
            } as Parameters<typeof handler>[0]);
            void Promise.resolve(response).catch(reject);
          });
        }
        if (method === "openclaw.setup.auth.start") {
          return { done: true, status: "cancelled" };
        }
        throw new Error(`Unexpected setup RPC: ${method}`);
      });
      const provider = createApplicationContextProvider(context);
      const page = new ModelSetupPage();
      page.routeData = { firstRun: true };
      provider.append(page);
      document.body.append(provider);
      await waitForFast(() =>
        expect(page.querySelector('[data-auth-choice="custom-api-key"] button')).not.toBeNull(),
      );
      expect(request.mock.calls).toEqual([
        [
          "openclaw.setup.detect",
          { agentId },
          expect.objectContaining({
            timeoutMs: expect.any(Number),
            signal: expect.any(AbortSignal),
          }),
        ],
      ]);
      const checkbox = page.querySelector<HTMLInputElement>(".model-setup__native-discovery input");
      const required = state !== "upgrade" && state !== "authored";
      if (required) {
        expect(checkbox?.checked).toBe(false);
      } else {
        expect(checkbox).toBeNull();
      }
      if (fixture.additionalCatalog) {
        expect(page.textContent).toContain("Fixture archive");
      }
      page.querySelector<HTMLButtonElement>('[data-auth-choice="custom-api-key"] button')!.click();
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "openclaw.setup.auth.start")).toBe(
          true,
        ),
      );
      const activation = request.mock.calls.find(
        ([method]) => method === "openclaw.setup.auth.start",
      )![1];
      expect(activation).toMatchObject({ authChoice: "custom-api-key", agentId });
      if (required) {
        expect(activation).toHaveProperty("nativeSessionCatalogsEnabled", false);
      } else {
        expect(activation).not.toHaveProperty("nativeSessionCatalogsEnabled");
      }
    },
  );
});
