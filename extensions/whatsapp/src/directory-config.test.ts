// Whatsapp tests cover directory config plugin behavior.
import { createDirectoryTestRuntime } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWebAuthExistsForDecision } from "./auth-store.js";
import { getWhatsAppConnectionController } from "./connection-controller-runtime-context.js";
import {
  acquireWhatsAppStandaloneConnectionOwner,
  WhatsAppConnectionOwnerBusyError,
} from "./connection-owner.js";
import {
  listWhatsAppDirectoryGroupsLive,
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./directory-config.js";
import type { OpenClawConfig } from "./runtime-api.js";
import {
  createWaDirectorySocket,
  waitForCredsSaveQueueWithTimeout,
  waitForWaConnection,
} from "./session.js";

const mocks = vi.hoisted(() => ({
  acquireOwner: vi.fn(),
  createSocket: vi.fn(),
  getController: vi.fn(),
  hasPendingOwner: vi.fn(),
  readAuth: vi.fn(),
  releaseOwner: vi.fn(),
  resolveAuthDir: vi.fn(),
  waitForConnection: vi.fn(),
  waitForCreds: vi.fn(),
}));

vi.mock("./active-listener.js", () => ({
  resolveWebAccountId: () => "default",
}));

vi.mock("./accounts.js", () => ({
  resolveWhatsAppAuthDir: mocks.resolveAuthDir,
}));

vi.mock("./connection-controller-runtime-context.js", () => ({
  getWhatsAppConnectionController: mocks.getController,
  hasPendingWhatsAppConnectionOwner: mocks.hasPendingOwner,
}));

vi.mock("./connection-owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connection-owner.js")>();
  return {
    ...actual,
    acquireWhatsAppStandaloneConnectionOwner: mocks.acquireOwner,
  };
});

vi.mock("./auth-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-store.js")>();
  return {
    ...actual,
    readWebAuthExistsForDecision: mocks.readAuth,
  };
});

vi.mock("./session.js", () => ({
  createWaDirectorySocket: mocks.createSocket,
  waitForCredsSaveQueueWithTimeout: mocks.waitForCreds,
  waitForWaConnection: mocks.waitForConnection,
}));

const getControllerMock = vi.mocked(getWhatsAppConnectionController);
const acquireOwnerMock = vi.mocked(acquireWhatsAppStandaloneConnectionOwner);
const readAuthMock = vi.mocked(readWebAuthExistsForDecision);
const createSocketMock = vi.mocked(createWaDirectorySocket);
const waitForConnectionMock = vi.mocked(waitForWaConnection);
const waitForCredsMock = vi.mocked(waitForCredsSaveQueueWithTimeout);

describe("whatsapp directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;
  const cfg = {
    channels: {
      whatsapp: {
        authDir: "/tmp/wa-auth",
        allowFrom: [
          "whatsapp:+15551230001",
          "15551230002@s.whatsapp.net",
          "120363999999999999@g.us",
        ],
        groups: {
          "120363111111111111@g.us": {},
          "120363222222222222@g.us": {},
        },
      },
    },
  } as unknown as OpenClawConfig;

  const makeParams = (overrides: { query?: string; limit?: number } = {}) =>
    ({
      cfg,
      accountId: undefined,
      query: overrides.query,
      limit: overrides.limit,
      runtime: runtimeEnv,
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    getControllerMock.mockReturnValue(null);
    mocks.hasPendingOwner.mockReturnValue(false);
    mocks.releaseOwner.mockResolvedValue(undefined);
    mocks.resolveAuthDir.mockImplementation(({ accountId }: { accountId: string }) => ({
      authDir: accountId === "secondary" ? "/tmp/secondary-wa-auth" : "/tmp/wa-auth",
      isLegacy: false,
    }));
    acquireOwnerMock.mockResolvedValue({ release: mocks.releaseOwner });
    readAuthMock.mockResolvedValue({ outcome: "stable", exists: true });
    waitForConnectionMock.mockResolvedValue(undefined);
    waitForCredsMock.mockResolvedValue("drained");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists peers and groups from config", async () => {
    await expect(
      listWhatsAppDirectoryPeersFromConfig({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual([
      { kind: "user", id: "+15551230001" },
      { kind: "user", id: "+15551230002" },
    ]);

    await expect(
      listWhatsAppDirectoryGroupsFromConfig({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).resolves.toEqual([
      { kind: "group", id: "120363111111111111@g.us" },
      { kind: "group", id: "120363222222222222@g.us" },
    ]);
  });

  it("uses the active gateway owner and applies deterministic filtering", async () => {
    const sock = {
      groupFetchAllParticipating: vi.fn().mockResolvedValue({
        "120363300000000000@g.us": { id: "120363300000000000@g.us", subject: "Beta" },
        "120363100000000000@g.us": { id: "120363100000000000@g.us", subject: "Beta Team" },
      }),
    };
    getControllerMock.mockReturnValue({ getCurrentSock: () => sock } as never);

    await expect(
      listWhatsAppDirectoryGroupsLive(makeParams({ query: "beta", limit: 1 })),
    ).resolves.toEqual([{ kind: "group", id: "120363100000000000@g.us", name: "Beta Team" }]);
    expect(acquireOwnerMock).not.toHaveBeenCalled();
  });

  it("reports a typed error when the gateway owner has no active socket", async () => {
    getControllerMock.mockReturnValue({ getCurrentSock: () => null } as never);

    await expect(listWhatsAppDirectoryGroupsLive(makeParams())).rejects.toMatchObject({
      code: "whatsapp_directory_unavailable",
      reason: "active_owner_unavailable",
    });
    expect(acquireOwnerMock).not.toHaveBeenCalled();
  });

  it("does not start a standalone socket while the gateway owner is connecting", async () => {
    mocks.hasPendingOwner.mockReturnValueOnce(true);

    await expect(listWhatsAppDirectoryGroupsLive(makeParams())).rejects.toMatchObject({
      code: "whatsapp_directory_unavailable",
      reason: "active_owner_unavailable",
    });
    expect(acquireOwnerMock).not.toHaveBeenCalled();
  });

  it("does not substitute configured groups when the gateway lookup fails", async () => {
    getControllerMock.mockReturnValue({
      getCurrentSock: () => ({
        groupFetchAllParticipating: vi.fn().mockRejectedValue(new Error("query failed")),
      }),
    } as never);

    await expect(listWhatsAppDirectoryGroupsLive(makeParams())).rejects.toMatchObject({
      code: "whatsapp_directory_unavailable",
      reason: "lookup_failed",
    });
  });

  it("runs a standalone lookup under exclusive ownership and awaits cleanup", async () => {
    const order: string[] = [];
    let closed = false;
    const sock = {
      groupFetchAllParticipating: vi.fn().mockResolvedValue({
        "120363300000000000@g.us": { id: "120363300000000000@g.us", subject: "Three" },
      }),
      end: vi.fn(async () => {
        closed = true;
        order.push("socket-ended");
      }),
      ws: {
        close: vi.fn(async () => {
          closed = true;
        }),
        get isClosed() {
          return closed;
        },
      },
    };
    createSocketMock.mockResolvedValue(sock as never);
    waitForCredsMock.mockImplementationOnce(async () => {
      order.push("creds-drained");
      return "drained";
    });
    mocks.releaseOwner.mockImplementationOnce(async () => {
      order.push("owner-released");
    });

    await expect(listWhatsAppDirectoryGroupsLive(makeParams())).resolves.toEqual([
      { kind: "group", id: "120363300000000000@g.us", name: "Three" },
    ]);
    expect(acquireOwnerMock).toHaveBeenCalledWith("/tmp/wa-auth");
    expect(waitForConnectionMock).toHaveBeenCalledWith(sock, { timeoutMs: 30_000 });
    expect(order).toEqual(["socket-ended", "creds-drained", "owner-released"]);
  });

  it("reports connection-owner contention without opening a socket", async () => {
    acquireOwnerMock.mockRejectedValueOnce(new WhatsAppConnectionOwnerBusyError("/tmp/wa-auth"));

    await expect(listWhatsAppDirectoryGroupsLive(makeParams())).rejects.toMatchObject({
      code: "whatsapp_directory_unavailable",
      reason: "connection_owner_busy",
    });
    expect(createSocketMock).not.toHaveBeenCalled();
  });

  it("reports unlinked auth and releases standalone ownership", async () => {
    readAuthMock.mockResolvedValueOnce({ outcome: "stable", exists: false });

    await expect(listWhatsAppDirectoryGroupsLive(makeParams())).rejects.toMatchObject({
      code: "whatsapp_directory_unavailable",
      reason: "not_linked",
    });
    expect(mocks.releaseOwner).toHaveBeenCalledOnce();
  });

  it("resolves standalone credentials for the selected account", async () => {
    readAuthMock.mockResolvedValueOnce({ outcome: "stable", exists: false });
    const namedCfg = {
      channels: { whatsapp: { accounts: { secondary: { enabled: true } } } },
    } as unknown as OpenClawConfig;

    await expect(
      listWhatsAppDirectoryGroupsLive({
        cfg: namedCfg,
        accountId: "secondary",
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      } as never),
    ).rejects.toMatchObject({ reason: "not_linked" });

    expect(mocks.resolveAuthDir).toHaveBeenCalledWith({
      cfg: namedCfg,
      accountId: "secondary",
    });
    expect(acquireOwnerMock).toHaveBeenCalledWith("/tmp/secondary-wa-auth");
  });

  it("closes a created socket when standalone connection setup fails", async () => {
    let closed = false;
    const sock = {
      groupFetchAllParticipating: vi.fn(),
      end: vi.fn(async () => {
        closed = true;
      }),
      ws: {
        close: vi.fn(async () => {
          closed = true;
        }),
        get isClosed() {
          return closed;
        },
      },
    };
    createSocketMock.mockResolvedValueOnce(sock as never);
    waitForConnectionMock.mockRejectedValueOnce(new Error("offline"));

    await expect(listWhatsAppDirectoryGroupsLive(makeParams())).rejects.toMatchObject({
      code: "whatsapp_directory_unavailable",
      reason: "connection_failed",
    });
    expect(sock.end).toHaveBeenCalledOnce();
    expect(waitForCredsMock).toHaveBeenCalledWith("/tmp/wa-auth");
    expect(mocks.releaseOwner).toHaveBeenCalledOnce();
  });

  it("retries retained ownership after credential cleanup times out", async () => {
    vi.useFakeTimers();
    let closed = false;
    const sock = {
      groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
      end: vi.fn(async () => {
        closed = true;
      }),
      ws: {
        close: vi.fn(async () => {
          closed = true;
        }),
        get isClosed() {
          return closed;
        },
      },
    };
    createSocketMock.mockResolvedValueOnce(sock as never);
    waitForCredsMock.mockResolvedValueOnce("timed_out");

    await expect(listWhatsAppDirectoryGroupsLive(makeParams())).rejects.toMatchObject({
      code: "whatsapp_directory_unavailable",
      reason: "cleanup_failed",
    });
    expect(mocks.releaseOwner).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.releaseOwner).toHaveBeenCalledOnce();
  });
});
