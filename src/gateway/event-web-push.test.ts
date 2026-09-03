import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { HumanMentionWebPush } from "./event-web-push.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";

const {
  listDevicePairingMock,
  listBoundWebPushSubscriptionsMock,
  prepareWebPushNotificationSenderMock,
  preparedWebPushSendMock,
  resolveUserProfileIdMock,
  getUserPreferencesMock,
  resolveOperatorRolePolicyForProfileMock,
  canReceiveSessionEventMock,
  mentionCurrentMock,
  webPushWarnMock,
} = vi.hoisted(() => ({
  listDevicePairingMock: vi.fn(),
  listBoundWebPushSubscriptionsMock: vi.fn(),
  prepareWebPushNotificationSenderMock: vi.fn(),
  preparedWebPushSendMock: vi.fn(),
  resolveUserProfileIdMock: vi.fn(),
  getUserPreferencesMock: vi.fn(),
  resolveOperatorRolePolicyForProfileMock: vi.fn(),
  canReceiveSessionEventMock: vi.fn(),
  mentionCurrentMock: vi.fn(),
  webPushWarnMock: vi.fn(),
}));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/web-push" ? { ...logger, warn: webPushWarnMock } : logger;
    },
  };
});

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

vi.mock("../state/user-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profiles.js")>()),
  resolveUserProfileId: resolveUserProfileIdMock,
}));

vi.mock("../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-preferences.js")>()),
  getUserPreferences: getUserPreferencesMock,
}));

vi.mock("./operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-role-policy.js")>()),
  resolveOperatorRolePolicyForProfile: resolveOperatorRolePolicyForProfileMock,
}));

vi.mock("./session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing.js")>()),
  canReceiveSessionEvent: canReceiveSessionEventMock,
}));

const { createEventWebPushDelivery } = await import("./event-web-push.js");

function boundSubscription(
  deviceId: string,
  userProfileId: string | null = null,
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}`,
    endpoint: `https://push.example.test/${deviceId}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "identified",
      categories: {
        agentFinished: true,
        agentQuestion: true,
        humanMentioned: true,
        scheduledTaskFailed: true,
        backgroundTaskFailed: true,
      },
    },
  };
}

function humanMention(overrides: Partial<HumanMentionWebPush> = {}): HumanMentionWebPush {
  return {
    id: "mention-1",
    recipientProfileId: "bob",
    sessionKey: "agent:research:thread.1",
    agentId: "research",
    senderLabel: "Alice",
    sessionTitle: "Review",
    isCurrent: mentionCurrentMock,
    ...overrides,
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
    resolveUserProfileIdMock.mockImplementation((profileId: string) => profileId);
    getUserPreferencesMock.mockReturnValue({});
    resolveOperatorRolePolicyForProfileMock.mockReturnValue(undefined);
    canReceiveSessionEventMock.mockReturnValue(true);
    mentionCurrentMock.mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

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

  it("does not treat injected transcript updates as agent completion", async () => {
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });

    delivery.handleEvent("chat", {
      state: "final",
      runId: "inject-message-1",
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "gateway-injected",
        content: [{ type: "text", text: "Injected transcript update" }],
      },
    });

    await Promise.resolve();
    expect(prepareWebPushNotificationSenderMock).not.toHaveBeenCalled();
    expect(preparedWebPushSendMock).not.toHaveBeenCalled();
  });

  it("sends questions with control characters escaped in durable tags", async () => {
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("browser-device", ["operator.read", "operator.questions"])],
    });
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
    delivery.handleEvent("question.requested", { id: "question\n1" });

    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ tag: "openclaw-question-question\\u{A}1" }),
      }),
    );
  });

  it("honors implied question scopes without notifying read-only devices", async () => {
    const admin = boundSubscription("admin");
    const reviewer = boundSubscription("reviewer");
    listBoundWebPushSubscriptionsMock.mockReturnValue([
      admin,
      reviewer,
      boundSubscription("reader"),
    ]);
    listDevicePairingMock.mockReturnValue({
      paired: [
        pairedOperator("admin", ["operator.admin"]),
        pairedOperator("reviewer", ["operator.read", "operator.questions"]),
        pairedOperator("reader", ["operator.read"]),
      ],
    });

    createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent("question.requested", {
      id: "question-1",
    });

    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptions: [admin, reviewer] }),
    );
  });

  it.each([
    { agentId: "agent\n\u202E", label: "agent\\u{A}\\u{202E}" },
    { agentId: "🦞".repeat(50), label: "🦞".repeat(40) },
  ])(
    "bounds event display labels while preserving the raw agent filter: $agentId",
    async ({ agentId, label }) => {
      const subscription = boundSubscription("browser-device");
      listBoundWebPushSubscriptionsMock.mockReturnValue([
        {
          ...subscription,
          devicePreferences: { ...subscription.devicePreferences, agentIds: [agentId] },
        },
      ]);

      createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent("chat", {
        state: "final",
        runId: "run-1",
        agentId,
      });

      await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
      expect(preparedWebPushSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ body: `${label}: An agent completed its response.` }),
        }),
      );
    },
  );

  it("sends only failed task and cron terminal events", async () => {
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
    delivery.handleEvent("task", {
      action: "upserted",
      task: { id: "task-1", title: "Build\u202E", status: "failed" },
    });
    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ body: "Build\\u{202E} needs attention." }),
      }),
    );

    preparedWebPushSendMock.mockClear();
    delivery.handleEvent("cron", { action: "finished", jobId: "cron-1", status: "ok" });
    expect(preparedWebPushSendMock).not.toHaveBeenCalled();

    delivery.handleEvent("cron", {
      action: "finished",
      jobId: "cron-1",
      status: "error",
      job: { name: "Nightly\u2028run" },
    });
    await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ body: "Nightly\\u{2028}run needs attention." }),
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

  describe("human mention delivery", () => {
    beforeEach(() => {
      listBoundWebPushSubscriptionsMock.mockReturnValue([
        boundSubscription("browser-device", "bob"),
      ]);
    });

    it("targets the recipient's canonical subscriptions, not other readers of the session", async () => {
      const bob = boundSubscription("bob-browser", "bob");
      const mergedBob = boundSubscription("bob-phone", "bob-old");
      const subscriptions = [
        boundSubscription("alice-browser", "alice"),
        bob,
        mergedBob,
        boundSubscription("carol-browser", "carol"),
        boundSubscription("anonymous-browser"),
      ];
      listBoundWebPushSubscriptionsMock.mockReturnValue(subscriptions);
      listDevicePairingMock.mockReturnValue({
        paired: subscriptions.map((subscription) => pairedOperator(subscription.deviceId)),
      });
      resolveUserProfileIdMock.mockImplementation((id: string) => (id === "bob-old" ? "bob" : id));
      const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });

      delivery.handleEvent("mentions.changed", humanMention());
      expect(prepareWebPushNotificationSenderMock).not.toHaveBeenCalled();
      delivery.deliverMention(humanMention({ recipientProfileId: "bob-old" }));

      await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
      expect(preparedWebPushSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptions: [bob, mergedBob],
          payload: expect.objectContaining({ url: "chat/research/thread%2E1" }),
        }),
      );
    });

    it("records one safe default-logger warning for partial delivery failures across copy groups", async () => {
      const browser = boundSubscription("bob-browser", "bob");
      const phone = boundSubscription("bob-phone", "bob");
      phone.devicePreferences.detailLevel = "private";
      listBoundWebPushSubscriptionsMock.mockReturnValue([browser, phone]);
      listDevicePairingMock.mockReturnValue({
        paired: [pairedOperator("bob-browser"), pairedOperator("bob-phone")],
      });
      preparedWebPushSendMock.mockImplementation(
        async ({ subscriptions }: { subscriptions: BoundWebPushSubscription[] }) =>
          subscriptions.map((subscription) => ({
            ok: subscription.subscriptionId === browser.subscriptionId,
            subscriptionId: subscription.subscriptionId,
            error: "private transport endpoint details",
          })),
      );

      createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).deliverMention(humanMention());

      await vi.waitFor(() => expect(webPushWarnMock).toHaveBeenCalledOnce());
      expect(webPushWarnMock.mock.calls).toEqual([
        [
          "event Web Push delivery failed",
          { category: "human-mentioned", attempted: 2, failed: 1 },
        ],
      ]);
      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(2);
    });

    it.each(["preparation", "send"] as const)(
      "omits sensitive details from an unexpected %s error",
      async (phase) => {
        const failure = new Error("https://push.example.test/private-endpoint?secret=do-not-log");
        if (phase === "preparation") {
          prepareWebPushNotificationSenderMock.mockRejectedValueOnce(failure);
        } else {
          preparedWebPushSendMock.mockRejectedValueOnce(failure);
        }
        createEventWebPushDelivery({
          getRuntimeConfig: () => ({}),
          log: { warn: webPushWarnMock },
        }).deliverMention(humanMention());

        await vi.waitFor(() => expect(webPushWarnMock).toHaveBeenCalledOnce());
        expect(webPushWarnMock.mock.calls).toEqual([
          ["event Web Push delivery could not complete", { category: "human-mentioned" }],
        ]);
      },
    );

    it.each([
      "eligible admin",
      "device downgrade",
      "profile downgrade",
      "missing role policy",
      "generic event",
    ] as const)(
      "applies real draft-session visibility after sender preparation: %s",
      async (scenario) => {
        const [profiles, roles, sharing] = await Promise.all([
          vi.importActual<typeof import("../state/user-profiles.js")>("../state/user-profiles.js"),
          vi.importActual<typeof import("./operator-role-policy.js")>("./operator-role-policy.js"),
          vi.importActual<typeof import("./session-sharing.js")>("./session-sharing.js"),
        ]);
        resolveUserProfileIdMock.mockImplementation(profiles.resolveUserProfileId);
        resolveOperatorRolePolicyForProfileMock.mockImplementation(
          roles.resolveOperatorRolePolicyForProfile,
        );
        canReceiveSessionEventMock.mockImplementation(sharing.canReceiveSessionEvent);
        await withOpenClawTestState({ scenario: "minimal" }, async () => {
          const owner = ensureProfileForEmail("draft-owner@example.test");
          const recipient = ensureProfileForEmail("draft-admin@example.test");
          setUserProfileRole(recipient.id, "admin");
          let cfg: OpenClawConfig = {
            gateway: {
              roles: {
                default: "reader",
                definitions: {
                  admin: { scopes: ["operator.admin"], sessions: { others: "write" }, agents: "*" },
                  reader: { scopes: ["operator.read"], sessions: { others: "view" }, agents: "*" },
                },
              },
            },
          };
          const sessionKey = "agent:main:foreign-draft";
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId: "foreign-draft",
              updatedAt: 1,
              visibility: "draft",
              createdActor: { type: "human", source: "profile", id: owner.id },
            },
          );
          const subscription = boundSubscription("admin-browser", recipient.id);
          listBoundWebPushSubscriptionsMock.mockReturnValue([subscription]);
          listDevicePairingMock.mockReturnValue({
            paired: [pairedOperator("admin-browser", ["operator.admin"])],
          });
          const preparation = createDeferred<typeof preparedWebPushSendMock>();
          prepareWebPushNotificationSenderMock.mockReturnValue(preparation.promise);
          const getRuntimeConfig = vi.fn(() => cfg);
          const delivery = createEventWebPushDelivery({ getRuntimeConfig });
          if (scenario === "generic event") {
            delivery.handleEvent(
              "chat",
              { state: "final", runId: "draft-run", agentId: "main" },
              { sessionKeys: [sessionKey], agentId: "main" },
            );
          } else {
            delivery.deliverMention(
              humanMention({ recipientProfileId: recipient.id, sessionKey, agentId: "main" }),
            );
          }
          expect(getRuntimeConfig).not.toHaveBeenCalled();
          if (scenario === "device downgrade") {
            listDevicePairingMock.mockReturnValue({ paired: [pairedOperator("admin-browser")] });
          } else if (scenario === "profile downgrade") {
            setUserProfileRole(recipient.id, "reader");
            invalidateOperatorRolePolicy(recipient.id);
          } else if (scenario === "missing role policy") {
            cfg = {};
          }
          preparation.resolve(preparedWebPushSendMock);
          await vi.waitFor(() => expect(canReceiveSessionEventMock).toHaveBeenCalledOnce());
          if (scenario === "eligible admin") {
            expect(preparedWebPushSendMock).toHaveBeenCalledWith(
              expect.objectContaining({ subscriptions: [subscription] }),
            );
          } else {
            expect(preparedWebPushSendMock).not.toHaveBeenCalled();
          }
        });
      },
    );

    it.each(["private", "identified", "detailed"] as const)(
      "keeps %s lock-screen copy label-only and routes through the receiving PWA",
      async (detailLevel) => {
        const subscription = boundSubscription("browser-device", "bob");
        subscription.devicePreferences.detailLevel = detailLevel;
        listBoundWebPushSubscriptionsMock.mockReturnValue([subscription]);
        createEventWebPushDelivery({
          getRuntimeConfig: () => ({
            gateway: {
              publicOrigin: "https://gateway.example.test",
              controlUi: { basePath: "/operator" },
            },
          }),
        }).deliverMention(humanMention({ senderLabel: "Al\nice", sessionTitle: "Review\u202E" }));

        await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
        expect(preparedWebPushSendMock).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: {
              title: "OpenClaw mention",
              body:
                detailLevel === "private"
                  ? "Someone mentioned you in a conversation."
                  : "Al\\u{A}ice mentioned you in Review\\u{202E}.",
              tag: expect.stringMatching(/^openclaw-mention-[\w-]{43}$/u),
              renotify: false,
              url: "chat/research/thread%2E1#gatewayUrl=wss%3A%2F%2Fgateway.example.test%2Foperator",
            },
          }),
        );
      },
    );

    it.each([
      {
        name: "subscription removal",
        revoke: () => listBoundWebPushSubscriptionsMock.mockReturnValue([]),
      },
      {
        name: "device unpairing",
        revoke: () => listDevicePairingMock.mockReturnValue({ paired: [] }),
      },
      {
        name: "token revocation",
        revoke: () => {
          const device = pairedOperator("browser-device");
          listDevicePairingMock.mockReturnValue({
            paired: [
              { ...device, tokens: { operator: { ...device.tokens.operator, revokedAtMs: 1 } } },
            ],
          });
        },
      },
      {
        name: "profile role downgrade",
        revoke: () => resolveOperatorRolePolicyForProfileMock.mockReturnValue({ scopes: [] }),
      },
      {
        name: "profile removal",
        revoke: () => resolveUserProfileIdMock.mockReturnValue(undefined),
      },
      {
        name: "browser account switch",
        revoke: () =>
          listBoundWebPushSubscriptionsMock.mockReturnValue([
            boundSubscription("browser-device", "carol"),
          ]),
      },
      {
        name: "session access loss",
        revoke: () => canReceiveSessionEventMock.mockReturnValue(false),
      },
      {
        name: "mention expiry or dismissal",
        revoke: () => mentionCurrentMock.mockReturnValue(false),
      },
    ])("rechecks $name after awaited sender preparation", async ({ revoke }) => {
      const preparation = createDeferred<typeof preparedWebPushSendMock>();
      prepareWebPushNotificationSenderMock.mockReturnValue(preparation.promise);
      const getRuntimeConfig = vi.fn(() => ({}));
      createEventWebPushDelivery({ getRuntimeConfig }).deliverMention(humanMention());
      expect(prepareWebPushNotificationSenderMock).toHaveBeenCalledOnce();
      expect(getRuntimeConfig).not.toHaveBeenCalled();

      revoke();
      preparation.resolve(preparedWebPushSendMock);

      await vi.waitFor(() => expect(getRuntimeConfig).toHaveBeenCalledOnce());
      expect(preparedWebPushSendMock).not.toHaveBeenCalled();
    });

    it.each([
      { name: "default category", preferences: { categories: {} } },
      { name: "disabled category", preferences: { categories: { humanMentioned: false } } },
      { name: "disabled browser", preferences: { enabled: false } },
      { name: "agent filter", preferences: { agentIds: ["other"] } },
      {
        name: "quiet hours",
        preferences: {
          quietHours: { enabled: true, startMinute: 0, endMinute: 1439, timeZone: "UTC" },
        },
      },
    ])(
      "suppresses the current $name independently of owner eligibility",
      async ({ preferences }) => {
        vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-01T12:00:00Z"));
        const preparation = createDeferred<typeof preparedWebPushSendMock>();
        prepareWebPushNotificationSenderMock.mockReturnValue(preparation.promise);
        const getRuntimeConfig = vi.fn(() => ({}));
        createEventWebPushDelivery({ getRuntimeConfig }).deliverMention(humanMention());
        const subscription = boundSubscription("browser-device", "bob");
        subscription.devicePreferences = { ...subscription.devicePreferences, ...preferences };
        listBoundWebPushSubscriptionsMock.mockReturnValue([subscription]);
        preparation.resolve(preparedWebPushSendMock);

        await vi.waitFor(() => expect(getRuntimeConfig).toHaveBeenCalledOnce());
        expect(preparedWebPushSendMock).not.toHaveBeenCalled();
        expect(mentionCurrentMock).toHaveReturnedWith(true);
      },
    );

    it("coalesces retries by mention identity without collapsing distinct mentions", async () => {
      const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
      delivery.deliverMention(humanMention());
      delivery.deliverMention(humanMention());
      delivery.deliverMention(humanMention({ id: "mention-2" }));

      await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledTimes(3));
      const identities = preparedWebPushSendMock.mock.calls.map(([params]) => ({
        tag: params.payload.tag,
        topic: params.deliveryOptions.topic,
      }));
      expect(identities[0]).toEqual(identities[1]);
      expect(identities[0]).not.toEqual(identities[2]);
    });

    it("runs the mention's final owner fence without yielding before network I/O", async () => {
      const order: string[] = [];
      mentionCurrentMock.mockImplementation(() => {
        order.push("current");
        queueMicrotask(() => order.push("next-microtask"));
        return true;
      });
      preparedWebPushSendMock.mockImplementation(async () => {
        order.push("send");
        return [];
      });
      createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).deliverMention(humanMention());

      await vi.waitFor(() => expect(preparedWebPushSendMock).toHaveBeenCalledOnce());
      expect(order).toEqual(["current", "send", "next-microtask"]);
    });
  });
});
