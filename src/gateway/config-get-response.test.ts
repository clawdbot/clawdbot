import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL, restoreRedactedValues } from "../config/redact-snapshot.js";
import { makeSnapshot } from "../config/redact-snapshot.test-helpers.js";
import { buildRuntimeConfigSchemaFromRegistry } from "../config/runtime-schema.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  appliedConfigHash: "applied-1" as string | null,
  pluginRegistryVersion: 1,
  readConfigFileSnapshot: vi.fn<() => Promise<ConfigFileSnapshot>>(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  };
});

vi.mock("../config/runtime-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/runtime-snapshot.js")>();
  return {
    ...actual,
    getRuntimeConfigAppliedHash: () => mocks.appliedConfigHash,
  };
});

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistryVersion: () => mocks.pluginRegistryVersion,
}));

const { invalidateConfigGetResponseCache, readConfigGetResponse: readConfigGetResponseImpl } =
  await import("./config-get-response.js");

const revisionProjector = {
  projectRawHash: (hash: string) => `raw-token:${hash}`,
  projectResolvedHash: (hash: string) => `resolved-token:${hash}`,
};

function readConfigGetResponse(
  params: Omit<Parameters<typeof readConfigGetResponseImpl>[0], "revisionProjector">,
) {
  return readConfigGetResponseImpl({ ...params, revisionProjector });
}

const activeWatcher = () => "active" as const;
const disabledWatcher = () => "disabled" as const;

beforeEach(() => {
  invalidateConfigGetResponseCache();
  mocks.appliedConfigHash = "applied-1";
  mocks.pluginRegistryVersion = 1;
  mocks.readConfigFileSnapshot.mockReset();
  mocks.readConfigFileSnapshot.mockResolvedValue(makeSnapshot({ gateway: { port: 19_001 } }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("config.get response cache", () => {
  it("round-trips wildcard plugin SecretRefs through an unrelated form save", async () => {
    const secretRef = {
      source: "store" as const,
      provider: "default",
      id: `TEST_${randomUUID().replaceAll("-", "").toUpperCase()}`,
    };
    const plaintext = randomUUID();
    const config = {
      gateway: { port: 19_001 },
      plugins: {
        entries: {
          webhooks: {
            enabled: true,
            config: {
              routes: {
                publish: { sessionKey: "agent:main", secret: secretRef },
                deploy: { sessionKey: "agent:main", secret: secretRef },
                plain: { sessionKey: "agent:main", secret: plaintext },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const { manifestRegistry } = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "webhooks",
          origin: "bundled",
          configContracts: {
            secretInputs: {
              paths: [{ path: "routes.*.secret", expected: "string", ownerKind: "route" }],
            },
          },
          configSchema: {
            type: "object",
            $defs: {
              secretRef: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  provider: { type: "string" },
                  id: { type: "string" },
                },
              },
              secretInput: {
                anyOf: [{ type: "string" }, { $ref: "#/$defs/secretRef" }],
              },
              route: {
                type: "object",
                properties: { secret: { $ref: "#/$defs/secretInput" } },
              },
            },
            properties: {
              routes: {
                type: "object",
                additionalProperties: { $ref: "#/$defs/route" },
              },
            },
          },
        },
      ],
    });
    const runtimeSchema = buildRuntimeConfigSchemaFromRegistry(manifestRegistry, config);
    const secretPath = "plugins.entries.webhooks.config.routes.*.secret";
    expect(runtimeSchema.uiHints[secretPath]?.sensitive).toBe(true);

    mocks.readConfigFileSnapshot.mockResolvedValue(makeSnapshot(config));
    const response = await readConfigGetResponse({
      loadUiHints: () => runtimeSchema.uiHints,
    });
    const redactedSecret = {
      source: "store",
      provider: "default",
      id: REDACTED_SENTINEL,
    };
    expect(response.config.plugins?.entries?.webhooks?.config).toMatchObject({
      routes: {
        publish: { secret: redactedSecret },
        deploy: { secret: redactedSecret },
        plain: { secret: REDACTED_SENTINEL },
      },
    });
    expect(response.raw).not.toBeNull();
    expect(response.raw).toContain(REDACTED_SENTINEL);
    expect(response.raw).not.toContain(secretRef.id);
    expect(JSON.stringify(response)).not.toContain(plaintext);
    expect(JSON.stringify(response)).not.toContain(secretRef.id);

    const formValue = structuredClone(response.config);
    formValue.gateway = { ...formValue.gateway, port: 19_002 };
    expect(restoreRedactedValues(formValue, config, runtimeSchema.uiHints)).toEqual({
      ok: true,
      result: {
        ...config,
        gateway: { port: 19_002 },
      },
    });
    for (const identityChange of [{ source: "env" }, { provider: "alternate" }]) {
      const changedIdentity = {
        ...formValue,
        plugins: {
          entries: {
            webhooks: {
              config: {
                routes: {
                  publish: { secret: { ...redactedSecret, ...identityChange } },
                },
              },
            },
          },
        },
      };
      expect(restoreRedactedValues(changedIdentity, config, runtimeSchema.uiHints)).toMatchObject({
        ok: false,
      });
    }
  });

  it.each(["core", "plus"])(
    "redacts retained owner credentials from every snapshot projection with %s selected",
    async (owner) => {
      const config: OpenClawConfig = {
        plugins: {
          entries: { core: { enabled: owner === "core" }, plus: { enabled: owner === "plus" } },
        },
        channels: {
          proofchat: { core: "synthetic-core", plus: "synthetic-plus", visible: "public-setting" },
        },
      };
      const { manifestRegistry } = createPluginMetadataSnapshotFixture({
        plugins: ["core", "plus"].map((id) => ({
          id,
          origin: "config",
          channels: ["proofchat"],
          channelConfigs: {
            proofchat: {
              schema: {
                type: "object",
                properties: { [id]: { type: "string" } },
              },
              uiHints: { [id]: { sensitive: true } },
            },
          },
        })),
      });
      mocks.readConfigFileSnapshot.mockResolvedValue(makeSnapshot(config));
      const response = await readConfigGetResponse({
        loadUiHints: () => buildRuntimeConfigSchemaFromRegistry(manifestRegistry, config).uiHints,
      });
      const output = JSON.stringify(response);
      expect(output).not.toContain("synthetic-core");
      expect(output).not.toContain("synthetic-plus");
      for (const field of [
        "config",
        "sourceConfig",
        "runtimeConfig",
        "parsed",
        "resolved",
      ] as const) {
        expect(response[field]).toMatchObject({
          channels: {
            proofchat: {
              core: "__OPENCLAW_REDACTED__",
              plus: "__OPENCLAW_REDACTED__",
              visible: "public-setting",
            },
          },
        });
      }
      expect(response.raw).toContain("public-setting");
    },
  );

  it("serves identical bytes without filesystem work on an active-watcher cache hit", async () => {
    const loadUiHints = vi.fn(() => undefined);
    const first = await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });
    const stat = vi.spyOn(fs.promises, "stat");
    mocks.readConfigFileSnapshot.mockClear();
    loadUiHints.mockClear();

    const hit = await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    expect(hit).toBe(first);
    expect(stat).not.toHaveBeenCalled();
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(loadUiHints).not.toHaveBeenCalled();

    invalidateConfigGetResponseCache();
    const fresh = await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });
    expect(hit).toEqual(fresh);
  });

  it("shares one projection across concurrent active-watcher callers", async () => {
    const loadUiHints = vi.fn(() => undefined);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints }),
      ),
    );

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(loadUiHints).toHaveBeenCalledOnce();
    expect(responses.every((response) => response === responses[0])).toBe(true);
  });

  it("evicts a failed projection instead of retaining its rejected promise", async () => {
    const loadUiHints = vi.fn(() => undefined);
    mocks.readConfigFileSnapshot.mockRejectedValueOnce(new Error("transient read failure"));

    await expect(
      readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints }),
    ).rejects.toThrow("transient read failure");
    await expect(
      readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints }),
    ).resolves.toMatchObject({ appliedConfigHash: "resolved-token:applied-1" });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      reason: "the active plugin metadata generation changes",
      invalidate: () => {
        mocks.pluginRegistryVersion = 2;
      },
    },
    {
      reason: "the watcher or write path invalidates",
      invalidate: invalidateConfigGetResponseCache,
    },
  ])("rebuilds when $reason", async ({ invalidate }) => {
    const loadUiHints = vi.fn(() => undefined);
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    invalidate();
    await readConfigGetResponse({ getHotReloadStatus: activeWatcher, loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
    expect(loadUiHints).toHaveBeenCalledTimes(2);
  });

  it.each([
    { reason: "hot reload is disabled", getHotReloadStatus: disabledWatcher },
    { reason: "no watcher status is available", getHotReloadStatus: undefined },
  ])("bypasses the cache when $reason", async ({ getHotReloadStatus }) => {
    const loadUiHints = vi.fn(() => undefined);

    await readConfigGetResponse({ getHotReloadStatus, loadUiHints });
    await readConfigGetResponse({ getHotReloadStatus, loadUiHints });

    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
    expect(loadUiHints).toHaveBeenCalledTimes(2);
  });
});
