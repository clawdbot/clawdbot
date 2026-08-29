import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const listDevicePairingMock = vi.fn();
const listBoundWebPushSubscriptionsMock = vi.fn();
const prepareWebPushNotificationSenderMock = vi.fn();
const preparedWebPushSendMock = vi.fn();

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
  listBoundWebPushSubscriptions: listBoundWebPushSubscriptionsMock,
  prepareWebPushNotificationSender: prepareWebPushNotificationSenderMock,
}));

vi.mock("../state/user-profiles.js", () => ({
  resolveUserProfileId: (profileId: string) => profileId,
}));

const { createEventWebPushDelivery } = await import("./event-web-push.js");

function boundSubscription(deviceId: string) {
  return {
    subscriptionId: `subscription-${deviceId}`,
    endpoint: `https://push.example.test/${deviceId}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId: null,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "identified",
      categories: {
        agentFinished: true,
        agentQuestion: true,
        scheduledTaskFailed: true,
        backgroundTaskFailed: true,
      },
    },
  };
}

function pairedOperator(deviceId: string, scopes = ["operator.read"]) {
  return {
    deviceId,
    roles: ["operator"],
    role: "operator",
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: { token: `token-${deviceId}`, role: "operator", scopes },
    },
  };
}

describe("event Web Push classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listBoundWebPushSubscriptionsMock.mockReturnValue([boundSubscription("browser-device")]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("browser-device")],
    });
    prepareWebPushNotificationSenderMock.mockResolvedValue(preparedWebPushSendMock);
    preparedWebPushSendMock.mockResolvedValue([]);
  });

  it("sends only final chat events as agent completion", async () => {
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
    delivery.handleEvent("chat", { state: "final", runId: "run-1" });
    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ tag: "openclaw-agent-finished-run-1" }),
      }),
    );

    preparedWebPushSendMock.mockClear();
    delivery.handleEvent("chat", { state: "delta", runId: "run-1" });
    expect(preparedWebPushSendMock).not.toHaveBeenCalled();
  });

  it("sanitizes and bounds agent labels in identified event payloads", async () => {
    const rawAgentId = `agent\u202e\n${"x".repeat(100)}`;
    const displayAgentId = `agent ${"x".repeat(74)}`;
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
    delivery.handleEvent("chat", { state: "final", runId: "run-1", agentId: rawAgentId });

    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          body: `${displayAgentId}: An agent completed its response.`,
        }),
      }),
    );
    expect(JSON.stringify(preparedWebPushSendMock.mock.calls)).not.toContain("\u202e");
  });

  it("sends questions with control characters removed from durable tags", async () => {
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("browser-device", ["operator.read", "operator.questions"])],
    });
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
    delivery.handleEvent("question.requested", { id: "question\n1" });

    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ tag: "openclaw-question-question 1" }),
      }),
    );
  });

  it("sends only failed task and cron terminal events", async () => {
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
    delivery.handleEvent("task", {
      action: "upserted",
      task: { id: "task-1", title: "Build", status: "failed" },
    });
    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ body: "Build needs attention." }),
      }),
    );

    preparedWebPushSendMock.mockClear();
    delivery.handleEvent("cron", { action: "finished", jobId: "cron-1", status: "ok" });
    expect(preparedWebPushSendMock).not.toHaveBeenCalled();

    delivery.handleEvent("cron", {
      action: "finished",
      jobId: "cron-1",
      status: "error",
      job: { name: "Nightly" },
    });
    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ body: "Nightly needs attention." }),
      }),
    );
  });

  it("rereads subscriptions after transport preparation before sending", async () => {
    const stale = boundSubscription("stale-device");
    const preparation = createDeferred<typeof preparedWebPushSendMock>();
    prepareWebPushNotificationSenderMock.mockReturnValue(preparation.promise);
    listBoundWebPushSubscriptionsMock.mockReturnValue([stale]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("stale-device")],
    });
    const getRuntimeConfig = vi.fn(() => ({}));
    const delivery = createEventWebPushDelivery({ getRuntimeConfig });

    delivery.handleEvent("chat", { state: "final", runId: "run-1" });

    await vi.waitFor(() => expect(prepareWebPushNotificationSenderMock).toHaveBeenCalledOnce());
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(listBoundWebPushSubscriptionsMock).toHaveBeenCalledOnce();
    listBoundWebPushSubscriptionsMock.mockReturnValue([]);
    preparation.resolve(preparedWebPushSendMock);
    await vi.waitFor(() => expect(listBoundWebPushSubscriptionsMock).toHaveBeenCalledTimes(2));
    expect(getRuntimeConfig).toHaveBeenCalledOnce();
    expect(preparedWebPushSendMock).not.toHaveBeenCalled();
  });

  it("skips transport preparation when no subscriptions exist", async () => {
    listBoundWebPushSubscriptionsMock.mockReturnValue([]);
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });

    delivery.handleEvent("chat", { state: "final", runId: "run-1" });

    await vi.waitFor(() => expect(listBoundWebPushSubscriptionsMock).toHaveBeenCalledOnce());
    expect(prepareWebPushNotificationSenderMock).not.toHaveBeenCalled();
    expect(preparedWebPushSendMock).not.toHaveBeenCalled();
  });

  it("invokes the sender in the same turn as the final authority read", async () => {
    const order: string[] = [];
    listDevicePairingMock.mockImplementation(() => {
      order.push("authority");
      queueMicrotask(() => order.push("next-microtask"));
      return {
        pending: [],
        paired: [pairedOperator("browser-device")],
      };
    });
    preparedWebPushSendMock.mockImplementation(async () => {
      order.push("send");
      return [];
    });
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });

    delivery.handleEvent("chat", { state: "final", runId: "run-1" });

    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(order).toEqual(["authority", "send", "next-microtask"]);
  });
});
