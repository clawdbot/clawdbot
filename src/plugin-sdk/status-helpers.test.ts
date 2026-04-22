import { describe, expect, it } from "vitest";
import {
  createAsyncComputedAccountStatusAdapter,
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildComputedAccountStatusSnapshot,
  buildRuntimeAccountStatusSnapshot,
  createComputedAccountStatusAdapter,
  buildWebhookChannelStatusSummary,
  buildTokenChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDependentCredentialStatusIssueCollector,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";

const defaultRuntimeState = {
  running: false,
  lastStartAt: null,
  lastStopAt: null,
  lastError: null,
};

type ExpectedAccountSnapshot = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  probe?: unknown;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
} & Record<string, unknown>;

const defaultChannelSummary = {
  configured: false,
  ...defaultRuntimeState,
};

const defaultTokenChannelSummary = {
  ...defaultChannelSummary,
  tokenSource: "none",
  mode: null,
  probe: undefined,
  lastProbeAt: null,
};

const defaultAccountSnapshot: ExpectedAccountSnapshot = {
  accountId: "default",
  name: undefined,
  enabled: undefined,
  configured: false,
  ...defaultRuntimeState,
  probe: undefined,
  lastInboundAt: null,
  lastOutboundAt: null,
};

function expectedAccountSnapshot(
  overrides: Partial<ExpectedAccountSnapshot> = {},
): ExpectedAccountSnapshot {
  return {
    ...defaultAccountSnapshot,
    ...overrides,
  };
}

const adapterAccount = {
  accountId: "default",
  enabled: true,
  profileUrl: "https://example.test",
};

const adapterRuntime = {
  accountId: "default",
  running: true,
};

const adapterProbe = { ok: true };

function expectedAdapterAccountSnapshot() {
  return {
    ...expectedAccountSnapshot({
      enabled: true,
      configured: true,
      running: true,
      probe: adapterProbe,
    }),
    profileUrl: adapterAccount.profileUrl,
    connected: true,
  };
}

function createComputedStatusAdapter() {
  return createComputedAccountStatusAdapter<
    { accountId: string; enabled: boolean; profileUrl: string },
    { ok: boolean }
  >({
    defaultRuntime: createDefaultChannelRuntimeState("default"),
    resolveAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: true,
      extra: {
        profileUrl: account.profileUrl,
        connected: runtime?.running ?? false,
        probe,
      },
    }),
  });
}

function createAsyncStatusAdapter() {
  return createAsyncComputedAccountStatusAdapter<
    { accountId: string; enabled: boolean; profileUrl: string },
    { ok: boolean }
  >({
    defaultRuntime: createDefaultChannelRuntimeState("default"),
    resolveAccountSnapshot: async ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: true,
      extra: {
        profileUrl: account.profileUrl,
        connected: runtime?.running ?? false,
        probe,
      },
    }),
  });
}

describe("createDefaultChannelRuntimeState", () => {
  it.each([
    {
      name: "builds default runtime state without extra fields",
      accountId: "default",
      extra: undefined,
      expected: {
        accountId: "default",
        ...defaultRuntimeState,
      },
    },
    {
      name: "merges extra fields into the default runtime state",
      accountId: "alerts",
      extra: {
        probeAt: 123,
        healthy: true,
      },
      expected: {
        accountId: "alerts",
        ...defaultRuntimeState,
        probeAt: 123,
        healthy: true,
      },
    },
  ])("$name", ({ accountId, extra, expected }) => {
    expect(createDefaultChannelRuntimeState(accountId, extra)).toEqual(expected);
  });
});

describe("buildBaseChannelStatusSummary", () => {
  it.each([
    {
      name: "defaults missing values",
      input: {},
      expected: defaultChannelSummary,
    },
    {
      name: "keeps explicit values",
      input: {
        configured: true,
        running: true,
        lastStartAt: 1,
        lastStopAt: 2,
        lastError: "boom",
      },
      expected: {
        ...defaultChannelSummary,
        configured: true,
        running: true,
        lastStartAt: 1,
        lastStopAt: 2,
        lastError: "boom",
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(buildBaseChannelStatusSummary(input)).toEqual(expected);
  });

  it("merges extra fields into the normalized channel summary", () => {
    expect(
      buildBaseChannelStatusSummary(
        {
          configured: true,
        },
        {
          mode: "webhook",
          secretSource: "env",
        },
      ),
    ).toEqual({
      ...defaultChannelSummary,
      configured: true,
      mode: "webhook",
      secretSource: "env",
    });
  });
});

describe("buildBaseAccountStatusSnapshot", () => {
  it.each([
    {
      name: "builds account status with runtime defaults",
      input: {
        account: { accountId: "default", enabled: true, configured: true },
      },
      extra: undefined,
      expected: expectedAccountSnapshot({ enabled: true, configured: true }),
    },
    {
      name: "merges extra snapshot fields after the shared account shape",
      input: {
        account: { accountId: "default", configured: true },
      },
      extra: {
        connected: true,
        mode: "polling",
      },
      expected: {
        ...expectedAccountSnapshot({ configured: true }),
        connected: true,
        mode: "polling",
      },
    },
  ])("$name", ({ input, extra, expected }) => {
    expect(buildBaseAccountStatusSnapshot(input, extra)).toEqual(expected);
  });
});

describe("buildComputedAccountStatusSnapshot", () => {
  it("builds account status when configured is computed outside resolver", () => {
    expect(
      buildComputedAccountStatusSnapshot({
        accountId: "default",
        enabled: true,
        configured: false,
      }),
    ).toEqual(expectedAccountSnapshot({ enabled: true }));
  });

  it("merges computed extras after the shared fields", () => {
    expect(
      buildComputedAccountStatusSnapshot(
        {
          accountId: "default",
          configured: true,
        },
        {
          connected: true,
        },
      ),
    ).toEqual({
      ...expectedAccountSnapshot({ configured: true }),
      connected: true,
    });
  });
});

describe("computed account status adapters", () => {
  it.each([
    {
      name: "sync",
      createStatus: createComputedStatusAdapter,
    },
    {
      name: "async",
      createStatus: createAsyncStatusAdapter,
    },
  ])(
    "builds account snapshots from $name computed account metadata and extras",
    async ({ createStatus }) => {
      const status = createStatus();
      await expect(
        Promise.resolve(
          status.buildAccountSnapshot?.({
            account: adapterAccount,
            cfg: {} as never,
            runtime: adapterRuntime,
            probe: adapterProbe,
          }),
        ),
      ).resolves.toEqual(expectedAdapterAccountSnapshot());
    },
  );
});

describe("buildRuntimeAccountStatusSnapshot", () => {
  it.each([
    {
      name: "builds runtime lifecycle fields with defaults",
      input: {},
      extra: undefined,
      expected: {
        ...defaultRuntimeState,
        probe: undefined,
      },
    },
    {
      name: "merges extra fields into runtime snapshots",
      input: {},
      extra: { port: 3978 },
      expected: {
        ...defaultRuntimeState,
        probe: undefined,
        port: 3978,
      },
    },
    {
      name: "preserves runtime connectivity metadata",
      input: {
        runtime: {
          connected: true,
          restartPending: true,
          reconnectAttempts: 3,
          lastConnectedAt: 11,
          lastDisconnect: { at: 12, error: "boom" },
          lastEventAt: 13,
          lastTransportActivityAt: 14,
          healthState: "healthy",
          running: true,
        },
      },
      extra: undefined,
      expected: {
        ...defaultRuntimeState,
        running: true,
        connected: true,
        restartPending: true,
        reconnectAttempts: 3,
        lastConnectedAt: 11,
        lastDisconnect: { at: 12, error: "boom" },
        lastEventAt: 13,
        lastTransportActivityAt: 14,
        healthState: "healthy",
        probe: undefined,
      },
    },
  ])("$name", ({ input, extra, expected }) => {
    expect(buildRuntimeAccountStatusSnapshot(input, extra)).toEqual(expected);
  });
});

describe("buildTokenChannelStatusSummary", () => {
  it.each([
    {
      name: "includes token/probe fields with mode by default",
      input: {},
      options: undefined,
      expected: defaultTokenChannelSummary,
    },
    {
      name: "can omit mode for channels without a mode state",
      input: {
        configured: true,
        tokenSource: "env",
        running: true,
        lastStartAt: 1,
        lastStopAt: 2,
        lastError: "boom",
        probe: { ok: true },
        lastProbeAt: 3,
      },
      options: { includeMode: false },
      expected: {
        configured: true,
        tokenSource: "env",
        running: true,
        lastStartAt: 1,
        lastStopAt: 2,
        lastError: "boom",
        probe: { ok: true },
        lastProbeAt: 3,
      },
    },
  ])("$name", ({ input, options, expected }) => {
    expect(buildTokenChannelStatusSummary(input, options)).toEqual(expected);
  });
});

describe("buildWebhookChannelStatusSummary", () => {
  it("defaults mode to webhook and keeps supplied extras", () => {
    expect(
      buildWebhookChannelStatusSummary(
        {
          configured: true,
          running: true,
        },
        {
          secretSource: "env",
        },
      ),
    ).toEqual({
      configured: true,
      running: true,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      mode: "webhook",
      secretSource: "env",
    });
  });
});

describe("createDependentCredentialStatusIssueCollector", () => {
  it("uses source metadata from sanitized snapshots to pick the missing field", () => {
    const collect = createDependentCredentialStatusIssueCollector({
      channel: "line",
      dependencySourceKey: "tokenSource",
      missingPrimaryMessage: "LINE channel access token not configured",
      missingDependentMessage: "LINE channel secret not configured",
    });

    expect(
      collect([
        { accountId: "default", configured: false, tokenSource: "none" },
        { accountId: "work", configured: false, tokenSource: "env" },
        { accountId: "ok", configured: true, tokenSource: "env" },
      ]),
    ).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel access token not configured",
      },
      {
        channel: "line",
        accountId: "work",
        kind: "config",
        message: "LINE channel secret not configured",
      },
    ]);
  });
});

describe("collectStatusIssuesFromLastError", () => {
  it("returns runtime issues only for non-empty string lastError values", () => {
    expect(
      collectStatusIssuesFromLastError("demo-channel", [
        { accountId: "default", lastError: " timeout " },
        { accountId: "silent", lastError: "   " },
        { accountId: "typed", lastError: { message: "boom" } },
      ]),
    ).toEqual([
      {
        channel: "demo-channel",
        accountId: "default",
        kind: "runtime",
        message: "Channel error: timeout",
      },
    ]);
  });
});
