import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";

const listDevicePairingMock = vi.fn();
const listBoundWebPushSubscriptionsMock = vi.fn();
const prepareWebPushNotificationSenderMock = vi.fn();
const preparedWebPushSendMock = vi.fn();
const prepareWebPushApprovalDeliveriesMock = vi.fn();
const listWebPushApprovalDeliveryTargetsMock = vi.fn();
const deleteWebPushApprovalDeliveryTargetsMock = vi.fn();
const listTerminalWebPushApprovalDeliveryIdsMock = vi.fn();
const resolveUserProfileIdMock = vi.fn();
const resolveOperatorRolePolicyForProfileMock = vi.fn();
const isApprovalRecordVisibleToClientMock = vi.fn();
const getOperatorApprovalDetailedMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-pairing.js")>(
    "../infra/device-pairing.js",
  );
  return actual;
});

vi.mock("../infra/device-pairing-store-readonly.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-pairing-store-readonly.js")>(
    "../infra/device-pairing-store-readonly.js",
  );
  return { ...actual, listPairedDevicesReadOnly: () => listDevicePairingMock().paired };
});

vi.mock("../infra/push-web.js", () => ({
  deleteWebPushApprovalDeliveryTargets: deleteWebPushApprovalDeliveryTargetsMock,
  listBoundWebPushSubscriptions: listBoundWebPushSubscriptionsMock,
  listTerminalWebPushApprovalDeliveryIds: listTerminalWebPushApprovalDeliveryIdsMock,
  listWebPushApprovalDeliveryTargets: listWebPushApprovalDeliveryTargetsMock,
  prepareWebPushApprovalDeliveries: prepareWebPushApprovalDeliveriesMock,
  prepareWebPushNotificationSender: prepareWebPushNotificationSenderMock,
}));

vi.mock("../state/user-profiles.js", () => ({
  resolveUserProfileId: resolveUserProfileIdMock,
}));

vi.mock("./operator-role-policy.js", async () => {
  const actual = await vi.importActual<typeof import("./operator-role-policy.js")>(
    "./operator-role-policy.js",
  );
  return {
    ...actual,
    resolveOperatorRolePolicyForProfile: resolveOperatorRolePolicyForProfileMock,
  };
});

vi.mock("./server-methods/approval-record-lookup.js", () => ({
  canAccessApprovalSession: () => true,
  isApprovalRecordVisibleToClient: isApprovalRecordVisibleToClientMock,
}));

vi.mock("./operator-approval-store.js", async () => {
  const actual = await vi.importActual<typeof import("./operator-approval-store.js")>(
    "./operator-approval-store.js",
  );
  return { ...actual, getOperatorApprovalDetailed: getOperatorApprovalDetailedMock };
});

function pairedOperator(deviceId: string, scopes: string[]) {
  return {
    deviceId,
    publicKey: `public-${deviceId}`,
    role: "operator",
    roles: ["operator"],
    approvedScopes: scopes,
    createdAtMs: 1,
    approvedAtMs: 1,
    tokens: {
      operator: {
        token: `token-${deviceId}`,
        role: "operator",
        scopes,
        createdAtMs: 1,
      },
    },
  };
}

function boundSubscription(
  deviceId: string,
  userProfileId: string | null,
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}-${userProfileId ?? "owner"}`,
    endpoint: `https://push.example.test/${deviceId}/${userProfileId ?? "owner"}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId,
    devicePreferences: { enabled: true, label: "" },
  };
}

describe("approval Web Push delivery", () => {
  const approvalDeliveryTargets = new Map<
    string,
    Map<string, ReturnType<typeof boundSubscription>>
  >();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    listDevicePairingMock.mockReturnValue({ pending: [], paired: [] });
    listBoundWebPushSubscriptionsMock.mockReturnValue([]);
    prepareWebPushNotificationSenderMock.mockResolvedValue(preparedWebPushSendMock);
    preparedWebPushSendMock.mockResolvedValue([]);
    approvalDeliveryTargets.clear();
    prepareWebPushApprovalDeliveriesMock.mockImplementation(({ approvalId, subscriptions }) => {
      approvalDeliveryTargets.set(
        approvalId,
        new Map(
          (subscriptions as ReturnType<typeof boundSubscription>[]).map((subscription) => [
            subscription.subscriptionId,
            subscription,
          ]),
        ),
      );
      return true;
    });
    listWebPushApprovalDeliveryTargetsMock.mockImplementation(({ approvalId }) => [
      ...(approvalDeliveryTargets.get(approvalId)?.values() ?? []),
    ]);
    deleteWebPushApprovalDeliveryTargetsMock.mockImplementation(
      ({ approvalId, subscriptionIds }) => {
        const targets = approvalDeliveryTargets.get(approvalId);
        for (const subscriptionId of subscriptionIds as string[]) {
          targets?.delete(subscriptionId);
        }
      },
    );
    listTerminalWebPushApprovalDeliveryIdsMock.mockReturnValue({
      approvalIds: [],
      nextAfterApprovalId: null,
      throughApprovalId: null,
    });
    resolveUserProfileIdMock.mockImplementation((profileId: string) => profileId);
    resolveOperatorRolePolicyForProfileMock.mockReturnValue(undefined);
    isApprovalRecordVisibleToClientMock.mockImplementation(
      ({ record, client }) =>
        !record.requestedByDeviceId || record.requestedByDeviceId === client?.connect?.device?.id,
    );
    getOperatorApprovalDetailedMock.mockReturnValue({
      outcome: "found",
      record: {
        reviewerDeviceIds: [],
        source: { agentId: null, sessionKey: null },
      },
    });
  });

  it("sends a generic approval link only to currently authorized visible bindings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "sensitive command" }, 60_000, "exec:approval.1");
    record.requestedByDeviceId = "allowed-device";
    const allowed = boundSubscription("allowed-device", "profile-allowed");
    const wrongDevice = boundSubscription("wrong-device", "profile-allowed");
    const missingScope = boundSubscription("missing-scope", "profile-allowed");
    const staleScope = boundSubscription("stale-scope", "profile-allowed");
    const staleScopeDevice = pairedOperator("stale-scope", ["operator.approvals", "operator.read"]);
    staleScopeDevice.approvedScopes = ["operator.read"];
    listBoundWebPushSubscriptionsMock.mockReturnValue([
      allowed,
      wrongDevice,
      missingScope,
      staleScope,
    ]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [
        pairedOperator("allowed-device", ["operator.approvals", "operator.read"]),
        pairedOperator("wrong-device", ["operator.approvals", "operator.read"]),
        pairedOperator("missing-scope", ["operator.read"]),
        staleScopeDevice,
      ],
    });
    preparedWebPushSendMock.mockResolvedValue([
      { ok: true, subscriptionId: allowed.subscriptionId, statusCode: 201 },
    ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({
      getRuntimeConfig: () => ({
        gateway: {
          publicOrigin: "https://gateway.example.test",
          controlUi: { basePath: "/operator" },
        },
      }),
    });
    const delivered = delivery.handleRequested(record);

    await expect(delivered).resolves.toBe(true);
    expect(preparedWebPushSendMock).toHaveBeenCalledWith({
      subscriptions: [allowed],
      payload: {
        title: "OpenClaw approval requested",
        body: "Open OpenClaw to review this request.",
        renotify: false,
        tag: "openclaw-approval-exec:approval.1",
        url: "approve/exec%3Aapproval.1#gatewayUrl=wss%3A%2F%2Fgateway.example.test%2Foperator",
      },
      deliveryOptions: {
        TTL: 60,
        urgency: "high",
        timeout: 10_000,
        topic: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
      },
    });
    expect(JSON.stringify(preparedWebPushSendMock.mock.calls)).not.toContain("sensitive command");
  });

  it("rechecks the profile role and excludes unbound role-based subscriptions", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:role-check");
    const current = boundSubscription("current-device", "profile-current");
    const downgraded = boundSubscription("downgraded-device", "profile-downgraded");
    const missingPolicy = boundSubscription("missing-policy-device", "profile-missing");
    const unboundProfile = boundSubscription("unbound-profile-device", null);
    listBoundWebPushSubscriptionsMock.mockReturnValue([
      current,
      downgraded,
      missingPolicy,
      unboundProfile,
    ]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [
        pairedOperator("current-device", ["operator.approvals", "operator.read"]),
        pairedOperator("downgraded-device", ["operator.approvals", "operator.read"]),
        pairedOperator("missing-policy-device", ["operator.approvals", "operator.read"]),
        pairedOperator("unbound-profile-device", ["operator.approvals", "operator.read"]),
      ],
    });
    resolveOperatorRolePolicyForProfileMock.mockImplementation((profileId: string) =>
      profileId === "profile-missing"
        ? undefined
        : {
            sessions: { others: "none" },
            agents: [],
            scopes:
              profileId === "profile-current"
                ? ["operator.approvals", "operator.read"]
                : ["operator.read"],
          },
    );
    isApprovalRecordVisibleToClientMock.mockImplementation(
      ({ client }) =>
        client?.authenticatedUserProfile?.profileId === "profile-current" ||
        client?.authenticatedUserProfile?.profileId === "profile-missing",
    );
    preparedWebPushSendMock.mockResolvedValue([
      { ok: true, subscriptionId: current.subscriptionId, statusCode: 201 },
    ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({
      getRuntimeConfig: () => ({
        gateway: {
          roles: {
            definitions: {},
          },
        },
      }),
    });
    await expect(delivery.handleRequested(record)).resolves.toBe(true);

    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptions: [current] }),
    );
  });

  it("prepares the transport before rereading current approval authority", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:authority-race");
    const stale = boundSubscription("stale-device", "profile-stale");
    const current = boundSubscription("current-device", "profile-current");
    listBoundWebPushSubscriptionsMock.mockReturnValueOnce([stale]).mockReturnValueOnce([current]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("current-device", ["operator.approvals", "operator.read"])],
    });
    preparedWebPushSendMock.mockResolvedValue([
      { ok: true, subscriptionId: current.subscriptionId, statusCode: 201 },
    ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
    await expect(delivery.handleRequested(record)).resolves.toBe(true);

    expect(prepareWebPushNotificationSenderMock).toHaveBeenCalledOnce();
    expect(
      expectDefined(
        prepareWebPushNotificationSenderMock.mock.invocationCallOrder[0],
        "transport preparation call order",
      ),
    ).toBeLessThan(
      expectDefined(listDevicePairingMock.mock.invocationCallOrder[0], "pairing read call order"),
    );
    expect(listBoundWebPushSubscriptionsMock).toHaveBeenCalledTimes(2);
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptions: [current] }),
    );
  });

  it("reads runtime role policy after transport preparation", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:config-race");
    const current = boundSubscription("current-device", "profile-current");
    const preparation = createDeferred<typeof preparedWebPushSendMock>();
    prepareWebPushNotificationSenderMock.mockReturnValue(preparation.promise);
    listBoundWebPushSubscriptionsMock.mockReturnValue([current]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("current-device", ["operator.approvals", "operator.read"])],
    });
    const tightenedConfig = { gateway: { roles: { definitions: {} } } };
    let runtimeConfig: typeof tightenedConfig | Record<string, never> = {};
    const getRuntimeConfig = vi.fn(() => runtimeConfig);
    resolveOperatorRolePolicyForProfileMock.mockImplementation(
      (_profileId: string, cfg: typeof tightenedConfig | Record<string, never>) =>
        "gateway" in cfg
          ? { sessions: { others: "none" }, agents: [], scopes: ["operator.read"] }
          : undefined,
    );
    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({ getRuntimeConfig });

    const requested = delivery.handleRequested(record);
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    runtimeConfig = tightenedConfig;
    preparation.resolve(preparedWebPushSendMock);

    await expect(requested).resolves.toBe(false);
    expect(getRuntimeConfig).toHaveBeenCalledOnce();
    expect(preparedWebPushSendMock).not.toHaveBeenCalled();
  });

  it.each(["resolved", "expired"] as const)(
    "does not send after the approval becomes %s during transport preparation",
    async (terminalState) => {
      const manager = new ExecApprovalManager();
      const record = manager.create(
        { command: "echo ok" },
        60_000,
        `exec:${terminalState}-during-preparation`,
      );
      const current = boundSubscription("current-device", "profile-current");
      listBoundWebPushSubscriptionsMock.mockReturnValue([current]);
      listDevicePairingMock.mockReturnValue({
        pending: [],
        paired: [pairedOperator("current-device", ["operator.approvals", "operator.read"])],
      });
      let finishPreparation: ((sender: typeof preparedWebPushSendMock) => void) | undefined;
      prepareWebPushNotificationSenderMock.mockReturnValueOnce(
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
      );

      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
      const webPushDelivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
      const delivery = webPushDelivery.handleRequested(record);
      expect(prepareWebPushNotificationSenderMock).toHaveBeenCalledOnce();
      if (terminalState === "resolved") {
        record.resolvedAtMs = Date.now();
        record.status = "denied";
      } else {
        record.expiresAtMs = Date.now() - 1;
      }
      expectDefined(finishPreparation, "transport preparation resolver")(preparedWebPushSendMock);

      await expect(delivery).resolves.toBe(false);
      expect(preparedWebPushSendMock).not.toHaveBeenCalled();
    },
  );

  it("recomputes the remaining TTL after transport preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:ttl-after-preparation");
    const current = boundSubscription("current-device", "profile-current");
    listBoundWebPushSubscriptionsMock.mockReturnValue([current]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("current-device", ["operator.approvals", "operator.read"])],
    });
    preparedWebPushSendMock.mockResolvedValue([
      { ok: true, subscriptionId: current.subscriptionId, statusCode: 201 },
    ]);
    let finishPreparation: ((sender: typeof preparedWebPushSendMock) => void) | undefined;
    prepareWebPushNotificationSenderMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPreparation = resolve;
      }),
    );

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const webPushDelivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
    const delivery = webPushDelivery.handleRequested(record);
    expect(prepareWebPushNotificationSenderMock).toHaveBeenCalledOnce();
    vi.setSystemTime(31_000);
    expectDefined(finishPreparation, "transport preparation resolver")(preparedWebPushSendMock);

    await expect(delivery).resolves.toBe(true);
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          url: "approve/exec%3Attl-after-preparation",
        }),
        deliveryOptions: {
          TTL: 30,
          urgency: "high",
          timeout: 10_000,
          topic: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
        },
      }),
    );
  });

  it("retains ambiguous request targets for terminal replacement and prunes definite failures", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:ambiguous-request");
    const ambiguous = boundSubscription("ambiguous-device", "profile-ambiguous");
    const gone = boundSubscription("gone-device", "profile-gone");
    const rejected = boundSubscription("rejected-device", "profile-rejected");
    listBoundWebPushSubscriptionsMock.mockReturnValue([ambiguous, gone, rejected]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [
        pairedOperator("ambiguous-device", ["operator.approvals", "operator.read"]),
        pairedOperator("gone-device", ["operator.approvals", "operator.read"]),
        pairedOperator("rejected-device", ["operator.approvals", "operator.read"]),
      ],
    });
    preparedWebPushSendMock
      .mockResolvedValueOnce([
        { ok: false, subscriptionId: ambiguous.subscriptionId, error: "timeout" },
        { ok: false, subscriptionId: gone.subscriptionId, statusCode: 410, error: "gone" },
        { ok: false, subscriptionId: rejected.subscriptionId, statusCode: 503, error: "busy" },
      ])
      .mockResolvedValueOnce([
        { ok: true, subscriptionId: ambiguous.subscriptionId, statusCode: 201 },
      ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });

    await expect(delivery.handleRequested(record)).resolves.toBe(true);
    await delivery.handleResolved({ id: record.id });

    expect(preparedWebPushSendMock).toHaveBeenCalledTimes(2);
    expect(preparedWebPushSendMock.mock.calls[1]?.[0]).toMatchObject({
      subscriptions: [ambiguous],
      payload: { title: "OpenClaw approval updated" },
    });
    expect(deleteWebPushApprovalDeliveryTargetsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: record.id,
        subscriptionIds: [gone.subscriptionId, rejected.subscriptionId],
      }),
    );
  });

  it.each(["resolved", "expired"] as const)(
    "replaces successful request alerts after the approval becomes %s",
    async (terminalState) => {
      const manager = new ExecApprovalManager();
      const record = manager.create(
        { command: "sensitive command" },
        60_000,
        `exec:terminal-${terminalState}`,
      );
      const delivered = boundSubscription("delivered-device", "profile-delivered");
      const failed = boundSubscription("failed-device", "profile-failed");
      listBoundWebPushSubscriptionsMock.mockReturnValue([delivered, failed]);
      listDevicePairingMock.mockReturnValue({
        pending: [],
        paired: [
          pairedOperator("delivered-device", ["operator.approvals", "operator.read"]),
          pairedOperator("failed-device", ["operator.approvals", "operator.read"]),
        ],
      });
      preparedWebPushSendMock
        .mockResolvedValueOnce([
          { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
          { ok: false, subscriptionId: failed.subscriptionId, statusCode: 410 },
        ])
        .mockResolvedValueOnce([
          { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
        ]);

      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
      const delivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
      await expect(delivery.handleRequested(record)).resolves.toBe(true);
      const requestOptions = preparedWebPushSendMock.mock.calls[0]?.[0]?.deliveryOptions;

      delivered.devicePreferences = {
        enabled: false,
        label: "",
        quietHours: {
          enabled: true,
          startMinute: 0,
          endMinute: 1439,
          timeZone: "UTC",
        },
      };

      if (terminalState === "resolved") {
        await delivery.handleResolved({ id: record.id });
      } else {
        await delivery.handleExpired({ id: record.id });
      }

      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(2);
      expect(preparedWebPushSendMock).toHaveBeenNthCalledWith(2, {
        subscriptions: [delivered],
        payload: {
          title: "OpenClaw approval updated",
          body: "This approval is no longer pending.",
          renotify: false,
          tag: `openclaw-approval-${record.id}`,
          url: `approve/${encodeURIComponent(record.id)}`,
        },
        deliveryOptions: {
          TTL: 300,
          urgency: "high",
          timeout: 10_000,
          topic: requestOptions?.topic,
        },
      });
      expect(JSON.stringify(preparedWebPushSendMock.mock.calls[1])).not.toContain(
        "sensitive command",
      );
    },
  );

  it("drains terminal recovery beyond the first 1,024 approvals", async () => {
    const firstPage = Array.from(
      { length: 1_024 },
      (_, index) => `exec:terminal-${String(index).padStart(4, "0")}`,
    );
    const finalApprovalId = "exec:terminal-1024";
    listTerminalWebPushApprovalDeliveryIdsMock
      .mockReturnValueOnce({
        approvalIds: firstPage,
        nextAfterApprovalId: firstPage.at(-1),
        throughApprovalId: finalApprovalId,
      })
      .mockReturnValueOnce({
        approvalIds: [finalApprovalId],
        nextAfterApprovalId: null,
        throughApprovalId: finalApprovalId,
      });

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    await createApprovalWebPushDelivery({
      getRuntimeConfig: () => ({}),
    }).recoverTerminalDeliveries();

    expect(listTerminalWebPushApprovalDeliveryIdsMock).toHaveBeenNthCalledWith(1, {});
    expect(listTerminalWebPushApprovalDeliveryIdsMock).toHaveBeenNthCalledWith(2, {
      afterApprovalId: firstPage.at(-1),
      throughApprovalId: finalApprovalId,
    });
    expect(listWebPushApprovalDeliveryTargetsMock).toHaveBeenCalledTimes(1_025);
  });

  it("recovers a terminal replacement from durable targets after process restart", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      { command: "sensitive command" },
      60_000,
      "exec:restart-terminal",
    );
    const delivered = boundSubscription("delivered-device", "profile-delivered");
    listBoundWebPushSubscriptionsMock.mockReturnValue([delivered]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("delivered-device", ["operator.approvals", "operator.read"])],
    });
    preparedWebPushSendMock
      .mockResolvedValueOnce([
        { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
      ])
      .mockResolvedValueOnce([
        { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
      ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const firstProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
    await expect(firstProcess.handleRequested(record)).resolves.toBe(true);

    listTerminalWebPushApprovalDeliveryIdsMock.mockReturnValue({
      approvalIds: [record.id],
      nextAfterApprovalId: null,
      throughApprovalId: record.id,
    });
    const restartedProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
    await restartedProcess.recoverTerminalDeliveries();

    expect(preparedWebPushSendMock).toHaveBeenCalledTimes(2);
    expect(preparedWebPushSendMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        subscriptions: [delivered],
        payload: expect.objectContaining({
          title: "OpenClaw approval updated",
          tag: "openclaw-approval-" + record.id,
        }),
      }),
    );
    expect(approvalDeliveryTargets.get(record.id)?.size).toBe(0);
  });

  it.each(["same-process", "restart"] as const)(
    "does not send a terminal approval link to a rebound subscription after %s resolution",
    async (mode) => {
      const manager = new ExecApprovalManager();
      const record = manager.create(
        { command: "sensitive command" },
        60_000,
        `exec:rebound-terminal-${mode}`,
      );
      const original = boundSubscription("original-device", "profile-original");
      listBoundWebPushSubscriptionsMock.mockReturnValue([original]);
      listDevicePairingMock.mockReturnValue({
        pending: [],
        paired: [pairedOperator("original-device", ["operator.approvals", "operator.read"])],
      });
      preparedWebPushSendMock.mockResolvedValueOnce([
        { ok: true, subscriptionId: original.subscriptionId, statusCode: 201 },
      ]);

      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
      const firstProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
      await expect(firstProcess.handleRequested(record)).resolves.toBe(true);

      // The durable store retains the original binding but the mutable
      // subscription row now belongs to someone else, so it returns no target.
      listWebPushApprovalDeliveryTargetsMock.mockReturnValue([]);
      if (mode === "restart") {
        listTerminalWebPushApprovalDeliveryIdsMock.mockReturnValue({
          approvalIds: [record.id],
          nextAfterApprovalId: null,
          throughApprovalId: record.id,
        });
        const restartedProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
        await restartedProcess.recoverTerminalDeliveries();
      } else {
        await firstProcess.handleResolved({ id: record.id });
      }

      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["same-process", "restart"] as const)(
    "does not send a terminal approval link after device authority is revoked in %s delivery",
    async (mode) => {
      const manager = new ExecApprovalManager();
      const record = manager.create(
        { command: "sensitive command" },
        60_000,
        `exec:revoked-terminal-${mode}`,
      );
      const delivered = boundSubscription("revoked-device", "profile-revoked");
      const active = pairedOperator("revoked-device", ["operator.approvals", "operator.read"]);
      const revoked = {
        ...active,
        tokens: {
          operator: { ...active.tokens.operator, revokedAtMs: Date.now() },
        },
      };
      listBoundWebPushSubscriptionsMock.mockReturnValue([delivered]);
      listDevicePairingMock
        .mockReturnValueOnce({
          pending: [],
          paired: [pairedOperator("revoked-device", ["operator.approvals", "operator.read"])],
        })
        .mockReturnValue({ pending: [], paired: [revoked] });
      preparedWebPushSendMock.mockResolvedValueOnce([
        { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
      ]);

      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
      const firstProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
      await expect(firstProcess.handleRequested(record)).resolves.toBe(true);

      if (mode === "restart") {
        listTerminalWebPushApprovalDeliveryIdsMock.mockReturnValue({
          approvalIds: [record.id],
          nextAfterApprovalId: null,
          throughApprovalId: record.id,
        });
        const restartedProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
        await restartedProcess.recoverTerminalDeliveries();
      } else {
        await firstProcess.handleResolved({ id: record.id });
      }

      expect(listDevicePairingMock).toHaveBeenCalledTimes(2);
      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not send a terminal approval link after profile policy is tightened", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      { command: "sensitive command" },
      60_000,
      "exec:tightened-terminal-policy",
    );
    const delivered = boundSubscription("policy-device", "profile-policy");
    listBoundWebPushSubscriptionsMock.mockReturnValue([delivered]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("policy-device", ["operator.approvals", "operator.read"])],
    });
    resolveOperatorRolePolicyForProfileMock
      .mockReturnValueOnce(undefined)
      .mockReturnValue({ sessions: { others: "none" }, agents: [], scopes: ["operator.read"] });
    preparedWebPushSendMock.mockResolvedValueOnce([
      { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
    ]);
    const initialConfig = {};
    const tightenedConfig = { gateway: { roles: { definitions: {} } } };
    const getRuntimeConfig = vi
      .fn()
      .mockReturnValueOnce(initialConfig)
      .mockReturnValue(tightenedConfig);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({ getRuntimeConfig });
    await expect(delivery.handleRequested(record)).resolves.toBe(true);
    await delivery.handleResolved({ id: record.id });

    expect(getRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(resolveOperatorRolePolicyForProfileMock).toHaveBeenLastCalledWith(
      "profile-policy",
      tightenedConfig,
    );
    expect(preparedWebPushSendMock).toHaveBeenCalledTimes(1);
  });
});
