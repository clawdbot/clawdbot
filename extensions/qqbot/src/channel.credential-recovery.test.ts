// QQBot tests cover backup recovery eligibility at the channel lifecycle boundary.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedQQBotAccount } from "./types.js";

const { loadCredentialBackupMock, startGatewayMock, writeConfigMock } = vi.hoisted(() => ({
  loadCredentialBackupMock: vi.fn<(accountId?: string) => unknown>(),
  startGatewayMock: vi.fn<(options: unknown) => Promise<void>>(() => new Promise<void>(() => {})),
  writeConfigMock: vi.fn<(runtime: unknown, cfg: unknown) => Promise<void>>(async () => {}),
}));

vi.mock("./engine/config/credential-backup.js", () => ({
  loadCredentialBackup: (accountId?: string) => loadCredentialBackupMock(accountId),
  saveCredentialBackup: vi.fn(),
}));

vi.mock("./bridge/gateway.js", () => ({
  startGateway: (options: unknown) => startGatewayMock(options),
}));

vi.mock("./bridge/runtime.js", () => ({
  getQQBotRuntime: () => ({}),
}));

vi.mock("./bridge/narrowing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bridge/narrowing.js")>()),
  writeOpenClawConfigThroughRuntime: (runtime: unknown, cfg: unknown) =>
    writeConfigMock(runtime, cfg),
}));

import { qqbotPlugin } from "./channel.js";

function makeAccount(overrides: Partial<ResolvedQQBotAccount>): ResolvedQQBotAccount {
  return {
    accountId: "default",
    appId: "",
    clientSecret: "",
    enabled: true,
    markdownSupport: true,
    secretSource: "none",
    config: {},
    ...overrides,
  };
}

function startAccount(account: ResolvedQQBotAccount, cfg: Record<string, unknown>) {
  const start = qqbotPlugin.gateway?.startAccount;
  if (!start) {
    throw new Error("expected QQBot gateway startAccount");
  }
  void start({
    account,
    accountId: account.accountId,
    cfg,
    runtime: {},
    abortSignal: new AbortController().signal,
    getStatus: () => ({
      accountId: account.accountId,
      running: true,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
    }),
    setStatus: vi.fn(),
  } as never);
}

describe("QQBot credential backup recovery", () => {
  afterEach(() => {
    vi.clearAllMocks();
    startGatewayMock.mockImplementation(() => new Promise<void>(() => {}));
  });

  it("keeps partial live credentials authoritative over a stale backup", async () => {
    loadCredentialBackupMock.mockReturnValue({
      accountId: "default",
      appId: "old-app",
      clientSecret: "old-secret",
    });
    const cfg = { channels: { qqbot: { appId: "new-app" } } };
    const account = makeAccount({ appId: "new-app" });

    expect(qqbotPlugin.config.isConfigured?.(account, cfg as never)).toBe(false);
    expect(qqbotPlugin.config.describeAccount?.(account, cfg as never)?.configured).toBe(false);

    startAccount(account, cfg);
    await vi.waitFor(() => expect(startGatewayMock).toHaveBeenCalledOnce());

    expect(writeConfigMock).not.toHaveBeenCalled();
    expect(startGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ appId: "new-app", clientSecret: "" }),
      }),
    );
  });

  it("restores a backup when all live credential inputs are absent", async () => {
    loadCredentialBackupMock.mockReturnValue({
      accountId: "default",
      appId: "backup-app",
      clientSecret: "backup-secret",
    });
    const cfg = { channels: { qqbot: {} } };
    const account = makeAccount({});

    expect(qqbotPlugin.config.isConfigured?.(account, cfg as never)).toBe(true);
    expect(qqbotPlugin.config.describeAccount?.(account, cfg as never)?.configured).toBe(true);

    startAccount(account, cfg);
    await vi.waitFor(() => expect(startGatewayMock).toHaveBeenCalledOnce());

    expect(writeConfigMock).toHaveBeenCalledOnce();
    expect(startGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({
          appId: "backup-app",
          clientSecret: "backup-secret",
        }),
      }),
    );
  });
});
