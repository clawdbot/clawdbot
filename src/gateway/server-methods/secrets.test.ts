/**
 * Tests for gateway secret resolution and redacted secret method responses.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  deleteEntry: vi.fn(),
  listEntries: vi.fn(() => [] as Array<Record<string, unknown>>),
  purgeEntries: vi.fn(() => 0),
  writeEntry: vi.fn(),
  getSnapshot: vi.fn(() => ({ sourceConfig: {} })),
  collectRefKeys: vi.fn((_config: unknown, _name: string) => new Set<string>()),
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  collectSecretStoreRefKeysInConfig: storeMocks.collectRefKeys,
  getActiveSecretsRuntimeSnapshotState: storeMocks.getSnapshot,
}));

vi.mock("../../secrets/store/secret-store.js", () => {
  class SecretStoreValidationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "SecretStoreValidationError";
    }
  }
  return {
    deleteSecretStoreEntry: storeMocks.deleteEntry,
    listSecretStoreEntries: storeMocks.listEntries,
    purgeExpiredSecretStoreEntries: storeMocks.purgeEntries,
    SecretStoreValidationError,
    writeSecretStoreEntry: storeMocks.writeEntry,
  };
});

// Handler tests only need the registry verdicts they exercise. Dedicated
// target-registry tests own bundled plugin discovery and compilation.
vi.mock("../../secrets/target-registry.js", () => ({
  isKnownCoreSecretTargetId: (value: unknown) => value === "talk.providers.*.apiKey",
  isKnownSecretTargetId: () => false,
}));

import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../../test-utils/talk-test-provider.js";
import { createSecretsHandlers } from "./secrets.js";

async function invokeSecretsReload(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
}) {
  await expectDefined(
    params.handlers["secrets.reload"],
    'params.handlers["secrets.reload"] test invariant',
  )({
    req: { type: "req", id: "1", method: "secrets.reload" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.reload"]
    >[0]["respond"],
    context: {} as never,
  });
}

async function invokeSecretsResolve(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
  commandName: unknown;
  targetIds: unknown;
  allowedPaths?: unknown;
  forcedActivePaths?: unknown;
}) {
  await expectDefined(
    params.handlers["secrets.resolve"],
    'params.handlers["secrets.resolve"] test invariant',
  )({
    req: { type: "req", id: "1", method: "secrets.resolve" },
    params: {
      commandName: params.commandName,
      targetIds: params.targetIds,
      ...(params.allowedPaths !== undefined ? { allowedPaths: params.allowedPaths } : {}),
      ...(params.forcedActivePaths !== undefined
        ? { forcedActivePaths: params.forcedActivePaths }
        : {}),
    },
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.resolve"]
    >[0]["respond"],
    context: {} as never,
  });
}

async function invokeStoreMethod(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  method: "secrets.store.list" | "secrets.store.set" | "secrets.store.delete";
  requestParams: Record<string, unknown>;
  respond: ReturnType<typeof vi.fn>;
}) {
  await expectDefined(
    params.handlers[params.method],
    `handler ${params.method}`,
  )({
    req: { type: "req", id: "store-1", method: params.method },
    params: params.requestParams,
    client: {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: "control-ui",
          version: "test",
          platform: "web",
          mode: "webchat",
          displayName: "Control UI",
        },
        role: "operator",
        scopes: ["operator.admin"],
      },
    } as never,
    isWebchatConnect: () => false,
    respond: params.respond as never,
    context: {} as never,
  });
}

function expectRespondError(
  respond: ReturnType<typeof vi.fn>,
  expected: { code: string; message?: string },
): void {
  const call = respond.mock.calls.at(0);
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  const error = call?.[2];
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    throw new Error("Expected a non-array error record");
  }
  const errorRecord = error as Record<string, unknown>;
  expect(errorRecord.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(errorRecord.message).toBe(expected.message);
  }
}

function expectWarnMessageWith(warn: ReturnType<typeof vi.fn>, text: string): void {
  expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(text);
}

async function expectMemoryStatusResolveUnavailable(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  warn: ReturnType<typeof vi.fn>;
  warningText: string;
}) {
  const respond = vi.fn();
  await invokeSecretsResolve({
    handlers: params.handlers,
    respond,
    commandName: "memory status",
    targetIds: ["talk.providers.*.apiKey"],
  });
  expectRespondError(respond, {
    code: "UNAVAILABLE",
    message: "secrets.resolve failed",
  });
  expectWarnMessageWith(params.warn, params.warningText);
}

describe("secrets handlers", () => {
  beforeEach(() => {
    storeMocks.deleteEntry.mockReset();
    storeMocks.listEntries.mockReset().mockReturnValue([]);
    storeMocks.purgeEntries.mockReset().mockReturnValue(0);
    storeMocks.writeEntry.mockReset();
    storeMocks.getSnapshot.mockReset().mockReturnValue({ sourceConfig: {} });
    storeMocks.collectRefKeys.mockReset().mockReturnValue(new Set());
  });

  function createHandlers(overrides?: {
    reloadSecrets?: (options?: {
      forceColdRefKeys?: ReadonlySet<string>;
      joinInFlight?: boolean;
    }) => Promise<{ warningCount: number }>;
    resolveSecrets?: (params: {
      commandName: string;
      targetIds: string[];
      allowedPaths?: string[];
      forcedActivePaths?: string[];
    }) => Promise<{
      assignments: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      diagnostics: string[];
      inactiveRefPaths: string[];
    }>;
    log?: { warn?: (message: string) => void };
  }) {
    const reloadSecrets = overrides?.reloadSecrets ?? (async () => ({ warningCount: 0 }));
    const resolveSecrets =
      overrides?.resolveSecrets ??
      (async () => ({
        assignments: [],
        diagnostics: [],
        inactiveRefPaths: [],
      }));
    return createSecretsHandlers({
      reloadSecrets,
      resolveSecrets,
      log: overrides?.log,
    });
  }

  it("responds with warning count on successful reload", async () => {
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockResolvedValue({ warningCount: 2 }),
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 2 });
  });

  it("returns unavailable when reload fails", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("disk full")),
      log: { warn },
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message: "secrets.reload failed",
    });
    expectWarnMessageWith(warn, "disk full");
  });

  it("resolves requested command secret assignments from the active snapshot", async () => {
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
      allowedPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
      forcedActivePaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    expect(resolveSecrets).toHaveBeenCalledWith({
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
      allowedPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
      forcedActivePaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
  });

  it("rejects invalid secrets.resolve params", async () => {
    const handlers = createHandlers();
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "",
      targetIds: "bad",
    });
    expectRespondError(respond, { code: "INVALID_REQUEST" });
  });

  it("rejects secrets.resolve params when targetIds entries are not strings", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey", 12],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: "invalid secrets.resolve params: targetIds",
    });
  });

  it("rejects unknown secrets.resolve target ids", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["unknown.target"],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: 'invalid secrets.resolve params: unknown target id "unknown.target"',
    });
  });

  it("returns unavailable when secrets.resolve handler returns an invalid payload shape", async () => {
    const warn = vi.fn();
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [{ path: TALK_TEST_PROVIDER_API_KEY_PATH, pathSegments: [""], value: "sk" }],
      diagnostics: [],
      inactiveRefPaths: [],
    });
    const handlers = createHandlers({ resolveSecrets, log: { warn } });
    await expectMemoryStatusResolveUnavailable({
      handlers,
      warn,
      warningText: "secrets.resolve returned invalid payload.",
    });
  });

  it("logs error details when secrets.resolve throws", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      resolveSecrets: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
      log: { warn },
    });
    await expectMemoryStatusResolveUnavailable({
      handlers,
      warn,
      warningText: "EACCES: permission denied",
    });
  });

  it("lists env values without structurally disclosing secret values", async () => {
    storeMocks.listEntries.mockReturnValueOnce([
      {
        name: "SERVICE_API_KEY",
        kind: "secret",
        scopeKind: "team",
        scopeId: "",
        createdAtMs: 1,
        updatedAtMs: 2,
        updatedBy: "Operator",
        valuePreview: "malicious-leak",
      },
      {
        name: "SERVICE_URL",
        kind: "env",
        scopeKind: "team",
        scopeId: "",
        createdAtMs: 1,
        updatedAtMs: 2,
        updatedBy: "Operator",
        valuePreview: "https://service.test",
      },
    ]);
    const respond = vi.fn();
    await invokeStoreMethod({
      handlers: createHandlers(),
      method: "secrets.store.list",
      requestParams: {},
      respond,
    });
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      entries: [
        { name: "SERVICE_API_KEY", kind: "secret" },
        { name: "SERVICE_URL", kind: "env", value: "https://service.test" },
      ],
    });
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("malicious-leak");
  });

  it("refreshes the runtime only after mutations of referenced store names", async () => {
    storeMocks.collectRefKeys.mockImplementation((_config, name) =>
      name === "SERVICE_API_KEY" ? new Set(["store:default:SERVICE_API_KEY"]) : new Set(),
    );
    const reloadSecrets = vi.fn().mockResolvedValue({ warningCount: 2 });
    storeMocks.getSnapshot.mockReturnValue({
      sourceConfig: {
        models: {
          providers: {
            test: {
              apiKey: { source: "store", provider: "default", id: "SERVICE_API_KEY" },
            },
          },
        },
      },
    });
    const handlers = createHandlers({ reloadSecrets });

    const setRespond = vi.fn();
    await invokeStoreMethod({
      handlers,
      method: "secrets.store.set",
      requestParams: { name: "SERVICE_API_KEY", value: "new-value", kind: "secret" },
      respond: setRespond,
    });
    expect(storeMocks.writeEntry).toHaveBeenCalledWith({
      scope: { kind: "team" },
      name: "SERVICE_API_KEY",
      value: "new-value",
      kind: "secret",
      updatedBy: "Control UI",
    });
    expect(setRespond).toHaveBeenCalledWith(true, {
      ok: true,
      reloaded: true,
      warningCount: 2,
    });

    const deleteRespond = vi.fn();
    await invokeStoreMethod({
      handlers,
      method: "secrets.store.delete",
      requestParams: { name: "SERVICE_URL" },
      respond: deleteRespond,
    });
    expect(deleteRespond).toHaveBeenCalledWith(true, { ok: true, reloaded: false });
    expect(reloadSecrets).toHaveBeenCalledTimes(1);
    expect(reloadSecrets).toHaveBeenCalledWith({
      forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]),
      joinInFlight: false,
    });
  });

  it("rejects invalid store params before writing", async () => {
    const respond = vi.fn();
    await invokeStoreMethod({
      handlers: createHandlers(),
      method: "secrets.store.set",
      requestParams: { name: "lowercase", value: "value", kind: "secret" },
      respond,
    });
    expect(storeMocks.writeEntry).not.toHaveBeenCalled();
    expectRespondError(respond, { code: "INVALID_REQUEST" });
  });

  it("reports a saved entry when its required runtime refresh fails", async () => {
    storeMocks.collectRefKeys.mockReturnValue(new Set(["store:default:SERVICE_API_KEY"]));
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });
    const respond = vi.fn();

    await invokeStoreMethod({
      handlers,
      method: "secrets.store.set",
      requestParams: { name: "SERVICE_API_KEY", value: "new-value", kind: "secret" },
      respond,
    });

    expect(storeMocks.writeEntry).toHaveBeenCalledOnce();
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message:
        "Secret store entry was saved, but post-write runtime refresh failed. Resolve provider errors and retry secrets.reload.",
    });
  });
});
