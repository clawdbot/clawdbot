import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { withEnvAsync } from "../../test-utils/env.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{ provider: SessionCatalogProvider }>;
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  listSessionEntriesReadOnly: vi.fn(() => []),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  listSessionEntriesReadOnly: hoisted.listSessionEntriesReadOnly,
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");

function provider(
  id: string,
  overrides: Partial<SessionCatalogProvider> = {},
): SessionCatalogProvider {
  return {
    id,
    label: id.toUpperCase(),
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

async function call(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  logGateway?: { warn: (message: string, fields?: Record<string, unknown>) => void },
) {
  const respond = vi.fn();
  await sessionCatalogHandlers[method]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}), ...(logGateway ? { logGateway } : {}) },
  } as never);
  return respond;
}

function withProfile<T>(profile: string | undefined, run: () => Promise<T>): Promise<T> {
  const home = os.userInfo().homedir;
  const stateDir = path.join(home, profile ? `.openclaw-${profile}` : ".openclaw");
  return withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: profile,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    },
    run,
  );
}

describe("session catalog Gateway HOME isolation", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    hoisted.listSessionEntriesReadOnly.mockReset().mockReturnValue([]);
  });

  it("suppresses only process-HOME local hosts for a named profile", async () => {
    const localHost = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const nodeHost = {
      hostId: "node:devbox",
      label: "Devbox",
      kind: "node" as const,
      connected: true,
      nodeId: "devbox",
      sessions: [],
    };
    const list = vi.fn(async (query: Parameters<SessionCatalogProvider["list"]>[0]) => [
      ...(query.allowProcessHomeFallback === false ? [] : [localHost]),
      nodeHost,
    ]);
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("claude", { list }) }];
    const logGateway = { warn: vi.fn() };

    const defaultRespond = await withProfile(undefined, () =>
      call("sessions.catalog.list", {}, logGateway),
    );
    expect(defaultRespond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "claude", hosts: [localHost, nodeHost] })],
    });

    const respond = await withProfile("dev", () => call("sessions.catalog.list", {}, logGateway));
    await withProfile("dev", () =>
      call("sessions.catalog.list", { search: "second request" }, logGateway),
    );

    expect(list).toHaveBeenCalledTimes(3);
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "claude", hosts: [nodeHost] })],
    });
    expect(logGateway.warn).toHaveBeenCalledOnce();
    expect(logGateway.warn).toHaveBeenCalledWith(
      "external session catalog HOME fallback skipped: isolated state; configure an explicit root to enable",
      { reason: "isolated_state" },
    );
  });

  it.each([
    ["continue", "continueSession", {}],
    ["archive", "archive", { confirmNoOtherRunner: true }],
  ] as const)("rejects a known local %s for a named profile", async (method, hook, extra) => {
    const rejectLocal = vi.fn(async (request: { allowProcessHomeFallback?: boolean }) => {
      if (request.allowProcessHomeFallback === false) {
        throw new Error("local Test sessions are unavailable in isolated state");
      }
      return hook === "archive" ? { ok: true as const } : { sessionKey: "agent:main:known" };
    });
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("test", { [hook]: rejectLocal } as Partial<SessionCatalogProvider>) },
    ];

    const respond = await withProfile("dev", () =>
      call(`sessions.catalog.${method}`, {
        catalogId: "test",
        hostId: "gateway:local",
        threadId: "known-thread",
        ...extra,
      }),
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "local Test sessions are unavailable in isolated state" }),
    );
  });
});
