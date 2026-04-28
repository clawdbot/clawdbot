import {
  promptSetupWizardAllowFrom,
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createAllowlistSetupWizardProxy,
  createDelegatedFinalize,
  createDelegatedPrepare,
  createDelegatedResolveConfigured,
  createDelegatedSetupWizardProxy,
} from "./setup-wizard-proxy.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";

describe("createDelegatedResolveConfigured", () => {
  it("forwards configured resolution to the loaded wizard", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        status: {
          configuredLabel: "configured",
          unconfiguredLabel: "needs setup",
          resolveConfigured: async ({ cfg, accountId }) =>
            Boolean(cfg.channels?.[accountId ?? "demo"]),
        },
        credentials: [],
      }),
    );

    const resolveConfigured = createDelegatedResolveConfigured(loadWizard);

    expect(await resolveConfigured({ cfg: {} })).toBe(false);
    expect(await resolveConfigured({ cfg: { channels: { work: {} } }, accountId: "work" })).toBe(
      true,
    );
  });
});

describe("createDelegatedPrepare", () => {
  it("forwards prepare when the loaded wizard implements it", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        status: {
          configuredLabel: "configured",
          unconfiguredLabel: "needs setup",
          resolveConfigured: () => true,
        },
        credentials: [],
        prepare: async ({ cfg }) => ({ cfg: { ...cfg, channels: { demo: { enabled: true } } } }),
      }),
    );

    const prepare = createDelegatedPrepare(loadWizard);

    expect(await runSetupWizardPrepare({ prepare })).toEqual({
      cfg: {
        channels: {
          demo: { enabled: true },
        },
      },
    });
  });
});

describe("createDelegatedFinalize", () => {
  it("forwards finalize when the loaded wizard implements it", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        status: {
          configuredLabel: "configured",
          unconfiguredLabel: "needs setup",
          resolveConfigured: () => true,
        },
        credentials: [],
        finalize: async ({ cfg, forceAllowFrom }) => ({
          cfg: {
            ...cfg,
            channels: {
              demo: { forceAllowFrom },
            },
          },
        }),
      }),
    );

    const finalize = createDelegatedFinalize(loadWizard);

    expect(await runSetupWizardFinalize({ finalize, forceAllowFrom: true })).toEqual({
      cfg: {
        channels: {
          demo: { forceAllowFrom: true },
        },
      },
    });
  });
});

describe("createAllowlistSetupWizardProxy", () => {
  it("falls back when delegated surfaces are absent", async () => {
    const wizard = createAllowlistSetupWizardProxy({
      loadWizard: async () =>
        ({
          channel: "demo",
          status: {
            configuredLabel: "configured",
            unconfiguredLabel: "needs setup",
            resolveConfigured: () => true,
          },
          credentials: [],
        }) satisfies ChannelSetupWizard,
      createBase: ({ promptAllowFrom, resolveAllowFromEntries, resolveGroupAllowlist }) => ({
        channel: "demo",
        status: {
          configuredLabel: "configured",
          unconfiguredLabel: "needs setup",
          resolveConfigured: () => true,
        },
        credentials: [],
        dmPolicy: {
          label: "Demo",
          channel: "demo" as never,
          policyKey: "channels.demo.dmPolicy",
          allowFromKey: "channels.demo.allowFrom",
          getCurrent: () => "pairing",
          setPolicy: (cfg) => cfg,
          promptAllowFrom,
        },
        allowFrom: {
          message: "Allow from",
          placeholder: "id",
          invalidWithoutCredentialNote: "need id",
          parseId: () => null,
          resolveEntries: resolveAllowFromEntries,
          apply: (params) => params.cfg,
        },
        groupAccess: {
          label: "Groups",
          placeholder: "group",
          currentPolicy: () => "allowlist",
          currentEntries: () => [],
          updatePrompt: () => false,
          setPolicy: (params) => params.cfg,
          resolveAllowlist: resolveGroupAllowlist,
        },
      }),
      fallbackResolvedGroupAllowlist: (entries) => entries.map((input) => ({ input })),
    });

    expect(
      await promptSetupWizardAllowFrom({ promptAllowFrom: wizard.dmPolicy?.promptAllowFrom }),
    ).toEqual({});
    expect(
      await resolveSetupWizardAllowFromEntries({
        resolveEntries: wizard.allowFrom?.resolveEntries,
        entries: ["alice"],
      }),
    ).toEqual([{ input: "alice", resolved: false, id: null }]);
    expect(
      await resolveSetupWizardGroupAllowlist({
        resolveAllowlist: wizard.groupAccess?.resolveAllowlist,
        entries: ["general"],
      }),
    ).toEqual([{ input: "general" }]);
  });
});

describe("createDelegatedSetupWizardProxy", () => {
  it("builds a direct proxy wizard with delegated status/prepare/finalize", async () => {
    const wizard = createDelegatedSetupWizardProxy({
      channel: "demo",
      loadWizard: async () =>
        ({
          channel: "demo",
          status: {
            configuredLabel: "configured",
            unconfiguredLabel: "needs setup",
            configuredHint: "ready",
            unconfiguredHint: "missing",
            configuredScore: 1,
            unconfiguredScore: 0,
            resolveConfigured: async ({ cfg }) => Boolean(cfg.channels?.demo),
            resolveStatusLines: async () => ["line"],
            resolveSelectionHint: async () => "hint",
            resolveQuickstartScore: async () => 3,
          },
          credentials: [],
          prepare: async ({ cfg }) => ({
            cfg: { ...cfg, channels: { demo: { prepared: true } } },
          }),
          finalize: async ({ cfg }) => ({
            cfg: { ...cfg, channels: { demo: { finalized: true } } },
          }),
        }) satisfies ChannelSetupWizard,
      status: {
        configuredLabel: "configured",
        unconfiguredLabel: "needs setup",
        configuredHint: "ready",
        unconfiguredHint: "missing",
        configuredScore: 1,
        unconfiguredScore: 0,
      },
      credentials: [],
      textInputs: [],
      completionNote: { title: "Done", lines: ["line"] },
      delegatePrepare: true,
      delegateFinalize: true,
    });

    expect(await wizard.status.resolveConfigured({ cfg: {} })).toBe(false);
    expect(await wizard.status.resolveStatusLines?.({ cfg: {}, configured: false })).toEqual([
      "line",
    ]);
    expect(await runSetupWizardPrepare({ prepare: wizard.prepare })).toEqual({
      cfg: {
        channels: {
          demo: { prepared: true },
        },
      },
    });
    expect(await runSetupWizardFinalize({ finalize: wizard.finalize })).toEqual({
      cfg: {
        channels: {
          demo: { finalized: true },
        },
      },
    });
  });
});
