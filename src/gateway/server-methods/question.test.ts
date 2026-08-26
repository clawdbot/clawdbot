import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import * as secretsRuntimeState from "../../secrets/runtime-state.js";
import { listSecretStoreEntries, writeSecretStoreEntry } from "../../secrets/store/secret-store.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { QuestionManager } from "../question-manager.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { canReceiveSessionEvent } from "../session-sharing.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretStoreWriteService } from "./secrets.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

let manager: QuestionManager;
let broadcast: ReturnType<typeof vi.fn>;
let handlers: ReturnType<typeof createQuestionHandlers>;
type SecretStoreReload = Parameters<typeof createSecretStoreWriteService>[0]["reloadSecrets"];
let reloadSecrets: ReturnType<typeof vi.fn<SecretStoreReload>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  manager = new QuestionManager();
  broadcast = vi.fn();
  reloadSecrets = vi.fn<SecretStoreReload>().mockResolvedValue({ warningCount: 0 });
  handlers = createQuestionHandlers(manager, createSecretStoreWriteService({ reloadSecrets }));
});

afterEach(() => {
  manager.reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function call(
  method: string,
  params: Record<string, unknown>,
  options?: { client?: GatewayClient; cfg?: OpenClawConfig },
) {
  const calls: Parameters<RespondFn>[] = [];
  const respond: RespondFn = (...args) => calls.push(args);
  await handlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    respond,
    client: options?.client ?? null,
    isWebchatConnect: () => false,
    context: {
      broadcast,
      getRuntimeConfig: () => options?.cfg ?? {},
    } as unknown as GatewayRequestHandlerOptions["context"],
  });
  const response = calls[0];
  if (!response) {
    throw new Error(`expected ${method} response`);
  }
  return response;
}

const requestParams = {
  questions: [
    {
      questionId: "destination",
      header: "Destination",
      question: "Where next?",
      options: [],
      multiSelect: false,
      isOther: true,
      isSecret: false,
    },
  ],
  agentId: "main",
  sessionKey: "agent:main:main",
  runId: "run-main",
  timeoutMs: 100,
};

const secretRequestQuestion = {
  questionId: "secret_value",
  header: "API key",
  question: "Provide SERVICE_API_KEY",
  options: [],
  isSecret: true,
  secretStore: {
    name: "SERVICE_API_KEY",
    kind: "secret" as const,
    allowedHosts: ["api.example.test"],
  },
};

const secretRequestParams = {
  ...requestParams,
  questions: [secretRequestQuestion],
};

// Store-bound questions may only be minted by admin-scoped clients; every
// store-bound request below presents one so validation errors stay specific.
const adminRequestClient = {
  connect: { scopes: ["operator.admin"] },
} as GatewayClient;

describe("question gateway methods", () => {
  it("conceals foreign session questions for role-none readers while preserving global prompts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("owner@example.test");
      const guest = ensureProfileForEmail("guest@example.test");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: requestParams.sessionKey },
        {
          sessionId: "question-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", id: owner.id },
        },
      );
      manager.request({ ...requestParams, id: "foreign-question" });
      manager.request({
        questions: requestParams.questions,
        id: "global-question",
        timeoutMs: 100,
      });
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.questions"],
              },
            },
          },
        },
      };
      const client = {
        connect: { scopes: ["operator.questions"] },
        authenticatedUserProfile: {
          profileId: guest.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: guest.updatedAt,
        },
      } as GatewayClient;

      expect((await call("question.list", {}, { client, cfg }))[1]).toMatchObject({
        questions: [{ id: "global-question" }],
      });
      for (const method of ["question.get", "question.waitAnswer"] as const) {
        expect(await call(method, { id: "foreign-question" }, { client, cfg })).toMatchObject([
          false,
          undefined,
          { details: { reason: "QUESTION_NOT_FOUND" } },
        ]);
      }
      expect(
        await call("question.resolve", { id: "foreign-question", cancel: true }, { client, cfg }),
      ).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
      expect(manager.get("foreign-question")?.status).toBe("pending");
    });
  });

  it.each(["view", "suggest"] as const)(
    "prevents a %s-capped guest from resolving a shared question until explicitly added",
    async (others) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const owner = ensureProfileForEmail("owner@example.test");
        const guest = ensureProfileForEmail("guest@example.test");
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: requestParams.sessionKey },
          {
            sessionId: "question-session",
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", id: owner.id },
          },
        );
        manager.request({ ...requestParams, id: "foreign-question" });
        const cfg: OpenClawConfig = {
          gateway: {
            roles: {
              default: "guest",
              definitions: {
                guest: { sessions: { others }, agents: "*", scopes: ["operator.questions"] },
              },
            },
          },
        };
        const client = {
          connect: { scopes: ["operator.questions"] },
          authenticatedUserProfile: {
            profileId: guest.id,
            displayName: null,
            hasAvatar: false,
            updatedAt: guest.updatedAt,
          },
        } as GatewayClient;

        expect((await call("question.get", { id: "foreign-question" }, { client, cfg }))[0]).toBe(
          true,
        );
        expect(
          await call("question.resolve", { id: "foreign-question", cancel: true }, { client, cfg }),
        ).toMatchObject([
          false,
          undefined,
          { details: { code: "SESSION_PARTICIPATION_REQUIRED" } },
        ]);
        addSessionMember(
          { agentId: "main", sessionKey: requestParams.sessionKey },
          { identityId: guest.id, addedBy: owner.id, expectedSessionId: "question-session" },
        );
        expect(
          await call("question.resolve", { id: "foreign-question", cancel: true }, { client, cfg }),
        ).toEqual([true, { status: "cancelled" }, undefined]);
      });
    },
  );

  it("scopes requested and resolved questions to operators allowed to see their session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("question-owner@example.test");
      const viewer = ensureProfileForEmail("question-viewer@example.test");
      const guest = ensureProfileForEmail("question-guest@example.test");
      setUserProfileRole(viewer.id, "viewer");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: requestParams.sessionKey },
        {
          sessionId: "question-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", id: owner.id },
        },
      );
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.questions"],
              },
              viewer: {
                sessions: { others: "view" },
                agents: "*",
                scopes: ["operator.questions"],
              },
            },
          },
        },
      };
      const makeQuestionClient = (
        profile: ReturnType<typeof ensureProfileForEmail>,
        connId: string,
      ) => {
        const socket = { bufferedAmount: 0, close: vi.fn(), readyState: 1, send: vi.fn() };
        const client: GatewayWsClient = {
          socket: socket as unknown as GatewayWsClient["socket"],
          connect: {
            role: "operator",
            scopes: ["operator.questions"],
          } as GatewayWsClient["connect"],
          connId,
          usesSharedGatewayAuth: false,
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: profile.displayName,
            avatarRevision: "",
            hasAvatar: false,
            updatedAt: profile.updatedAt,
          },
        };
        return { client, socket };
      };
      const ownerClient = makeQuestionClient(owner, "question-owner");
      const viewerClient = makeQuestionClient(viewer, "question-viewer");
      const guestClient = makeQuestionClient(guest, "question-guest");
      const gatewayBroadcaster = createGatewayBroadcaster({
        clients: new Set([ownerClient.client, viewerClient.client, guestClient.client]),
        canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
          canReceiveSessionEvent({ cfg, client, sessionKeys, agentId, event, payload }),
      });
      broadcast.mockImplementation(gatewayBroadcaster.broadcast);

      const request = await call("question.request", requestParams, {
        cfg,
        client: ownerClient.client,
      });
      const id = (request[1] as { id: string }).id;
      const answers = { answers: { destination: ["Home"] } };
      const sessionScope = { sessionKeys: [requestParams.sessionKey], agentId: "main" };

      expect(ownerClient.socket.send).toHaveBeenCalledTimes(1);
      expect(viewerClient.socket.send).toHaveBeenCalledTimes(1);
      expect(guestClient.socket.send).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledWith(
        "question.requested",
        expect.objectContaining({ id, sessionKey: requestParams.sessionKey }),
        sessionScope,
      );

      await call("question.resolve", { id, answers }, { cfg, client: ownerClient.client });

      expect(broadcast).toHaveBeenCalledWith(
        "question.resolved",
        { id, status: "answered", answers },
        sessionScope,
      );
      expect(ownerClient.socket.send).toHaveBeenCalledTimes(2);
      expect(viewerClient.socket.send).toHaveBeenCalledTimes(2);
      expect(guestClient.socket.send).not.toHaveBeenCalled();
    });
  });

  it("requests questions, then gets and lists them", async () => {
    const requested = await call("question.request", {
      ...requestParams,
      id: "client-question-id",
    });
    expect(requested[0]).toBe(true);
    const id = (requested[1] as { id: string }).id;
    expect(id).toBe("client-question-id");
    expect(broadcast).toHaveBeenCalledWith(
      "question.requested",
      expect.objectContaining({
        id,
        runId: "run-main",
        questions: [expect.objectContaining({ header: "Destination" })],
        status: "pending",
      }),
    );

    expect(await call("question.get", { id })).toEqual([
      true,
      { question: expect.objectContaining({ id, runId: "run-main", status: "pending" }) },
      undefined,
    ]);
    expect(await call("question.list", {})).toEqual([
      true,
      { questions: [expect.objectContaining({ id, runId: "run-main" })] },
      undefined,
    ]);
  });

  it("broadcasts answered and expired terminal states", async () => {
    const requested = await call("question.request", requestParams);
    const id = (requested[1] as { id: string }).id;
    const answers = { answers: { destination: ["Home"] } };

    expect(await call("question.resolve", { id, answers, resolvedBy: "control-ui" })).toEqual([
      true,
      { status: "answered", answers },
      undefined,
    ]);
    expect(broadcast).toHaveBeenCalledWith("question.resolved", {
      id,
      status: "answered",
      answers,
    });

    const expiring = await call("question.request", { ...requestParams, timeoutMs: 10 });
    const expiringId = (expiring[1] as { id: string }).id;
    await vi.advanceTimersByTimeAsync(10);
    expect(broadcast).toHaveBeenCalledWith("question.resolved", {
      id: expiringId,
      status: "expired",
    });
  });

  it("rejects duplicate ids and one-option questions at the request boundary", async () => {
    const duplicate = await call("question.request", {
      questions: [requestParams.questions[0], requestParams.questions[0]],
    });
    expect(duplicate[0]).toBe(false);
    expect((duplicate[2] as { message: string }).message).toContain("duplicate question id");

    const oneOption = await call("question.request", {
      questions: [{ ...requestParams.questions[0], options: [{ label: "Only" }] }],
    });
    expect(oneOption[0]).toBe(false);
    expect((oneOption[2] as { message: string }).message).toContain("2 to 4 options");

    const clientId = "duplicate-client-id";
    expect((await call("question.request", { ...requestParams, id: clientId }))[0]).toBe(true);
    const reusedId = await call("question.request", { ...requestParams, id: clientId });
    expect(reusedId[0]).toBe(false);
    expect(reusedId[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "QUESTION_ID_IN_USE" },
    });
  });

  it("rejects secret questions and duplicate normalized option labels", async () => {
    const secret = await call("question.request", {
      ...requestParams,
      questions: [{ ...requestParams.questions[0], isSecret: true }],
    });
    expect(secret[0]).toBe(false);
    expect((secret[2] as { message: string }).message).toContain(
      "question 'destination': secret questions are not supported yet",
    );

    const duplicateLabels = await call("question.request", {
      ...requestParams,
      questions: [
        {
          ...requestParams.questions[0],
          options: [{ label: " Deploy " }, { label: "deploy" }],
        },
      ],
    });
    expect(duplicateLabels[0]).toBe(false);
    expect((duplicateLabels[2] as { message: string }).message).toContain(
      "question 'destination' has duplicate option label",
    );
  });

  it.each([
    {
      behavior: "bindings without the secret-input marker",
      questions: [{ ...secretRequestParams.questions[0], isSecret: false }],
    },
    {
      behavior: "secret requests mixed with another question",
      questions: [secretRequestParams.questions[0], requestParams.questions[0]],
    },
    {
      behavior: "secret requests with answer options",
      questions: [
        {
          ...secretRequestParams.questions[0],
          options: [{ label: "First" }, { label: "Second" }],
        },
      ],
    },
    {
      behavior: "secret requests allowing multiple selections",
      questions: [{ ...secretRequestParams.questions[0], multiSelect: true }],
    },
    {
      behavior: "invalid secret store entry names",
      questions: [
        {
          ...secretRequestParams.questions[0],
          secretStore: { ...secretRequestQuestion.secretStore, name: "lowercase" },
        },
      ],
    },
    {
      behavior: "invalid secret store entry kinds",
      questions: [
        {
          ...secretRequestParams.questions[0],
          secretStore: { ...secretRequestQuestion.secretStore, kind: "password" },
        },
      ],
    },
    {
      behavior: "more than 128 proposed allowed hosts",
      questions: [
        {
          ...secretRequestParams.questions[0],
          secretStore: {
            ...secretRequestQuestion.secretStore,
            allowedHosts: Array.from({ length: 129 }, (_, index) => `${index}.example.test`),
          },
        },
      ],
    },
    {
      behavior: "allowed hosts proposed for environment entries",
      questions: [
        {
          ...secretRequestParams.questions[0],
          secretStore: { ...secretRequestQuestion.secretStore, kind: "env" },
        },
      ],
    },
  ])("rejects $behavior before opening a pending secret question", async ({ questions }) => {
    const response = await call(
      "question.request",
      { ...requestParams, questions },
      { client: adminRequestClient },
    );

    expect(response).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
    expect(manager.list()).toEqual([]);
  });

  it.each([
    { behavior: "a connect-less client", client: null },
    {
      behavior: "a questions-scoped client",
      client: {
        connect: { scopes: ["operator.questions"] },
      } as GatewayClient,
    },
  ])(
    "refuses to mint store-bound questions for $behavior so questions scope cannot reach store writes",
    async ({ client }) => {
      const response = await call(
        "question.request",
        secretRequestParams,
        client ? { client } : undefined,
      );

      expect(response).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST", message: expect.stringContaining("operator.admin") },
      ]);
      expect(manager.list()).toEqual([]);
    },
  );

  it("annotates a store-bound question with replacement metadata without exposing the old value", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const oldValue = "test-secret-value-existing-123";
      writeSecretStoreEntry({
        scope: { kind: "team" },
        name: "SERVICE_API_KEY",
        value: oldValue,
        kind: "secret",
        updatedBy: "Previous Operator",
      });

      const response = await call("question.request", secretRequestParams, {
        client: adminRequestClient,
      });
      const id = (response[1] as { id: string }).id;
      const record = manager.get(id);

      expect(record?.questions[0]).toMatchObject({
        secretStore: secretRequestQuestion.secretStore,
        secretStoreExisting: { updatedAtMs: 1_000, updatedBy: "Previous Operator" },
      });
      expect(JSON.stringify(record)).not.toContain(oldValue);
    });
  });

  it("diverts operator-entered credentials into the store and exposes only a stored marker", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const response = await call("question.request", secretRequestParams, {
        client: adminRequestClient,
      });
      const id = (response[1] as { id: string }).id;
      const value = "test-secret-value-gateway-diversion-123";
      const client = {
        connect: { client: { displayName: "Trusted Operator" } },
      } as GatewayClient;

      const resolved = await call(
        "question.resolve",
        { id, answers: { answers: { secret_value: [value] } }, resolvedBy: "control-ui" },
        { client },
      );
      const safeAnswers = { answers: { secret_value: ["stored"] } };

      expect(resolved).toEqual([true, { status: "answered", answers: safeAnswers }, undefined]);
      expect(listSecretStoreEntries({ scope: { kind: "team" } })).toMatchObject([
        {
          name: "SERVICE_API_KEY",
          kind: "secret",
          allowedHosts: ["api.example.test"],
          updatedBy: "Trusted Operator",
        },
      ]);
      expect(manager.get(id)).toMatchObject({ status: "answered", answers: safeAnswers });
      expect(await call("question.waitAnswer", { id })).toEqual([
        true,
        { status: "answered", answers: safeAnswers },
        undefined,
      ]);
      expect(broadcast).toHaveBeenCalledWith("question.resolved", {
        id,
        status: "answered",
        answers: safeAnswers,
      });
      expect(JSON.stringify([resolved, manager.get(id), broadcast.mock.calls])).not.toContain(
        value,
      );
      expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
    });
  });

  it("uses operator-edited hosts and keeps invalid store submissions pending for retry", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const requested = await call("question.request", secretRequestParams, {
        client: adminRequestClient,
      });
      const id = (requested[1] as { id: string }).id;
      const value = "test-secret-value-retry-123";
      const answers = { answers: { secret_value: [value] } };

      const invalid = await call("question.resolve", {
        id,
        answers,
        secretStoreAllowedHosts: ["*.example.test"],
      });
      expect(invalid).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST", message: expect.stringContaining("wildcard") },
      ]);
      expect(manager.get(id)?.status).toBe("pending");
      expect(isSecretValueRegisteredForRedaction(value)).toBe(true);

      const retried = await call("question.resolve", {
        id,
        answers,
        secretStoreAllowedHosts: ["replacement.example.test"],
      });
      expect(retried[0]).toBe(true);
      expect(listSecretStoreEntries({ scope: { kind: "team" } })[0]).toMatchObject({
        allowedHosts: ["replacement.example.test"],
      });
    });
  });

  it.each([
    { behavior: "no submitted value", answers: { secret_value: [] } },
    {
      behavior: "multiple submitted values",
      answers: { secret_value: ["test-secret-value-first", "test-secret-value-second"] },
    },
    {
      behavior: "an unrelated submitted answer",
      answers: { secret_value: ["test-secret-value-only"], destination: ["Home"] },
    },
  ])("keeps a secret question pending when there is $behavior", async ({ answers }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const requested = await call("question.request", secretRequestParams, {
        client: adminRequestClient,
      });
      const id = (requested[1] as { id: string }).id;

      expect(await call("question.resolve", { id, answers: { answers } })).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST" },
      ]);
      expect(manager.get(id)?.status).toBe("pending");
      expect(listSecretStoreEntries({ scope: { kind: "team" } })).toEqual([]);
    });
  });

  it("rejects host overrides on env entries and ordinary questions without settling them", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const envQuestion = {
        ...secretRequestParams.questions[0],
        secretStore: { name: "SERVICE_URL", kind: "env" as const },
      };
      const envResponse = await call(
        "question.request",
        { ...secretRequestParams, questions: [envQuestion] },
        { client: adminRequestClient },
      );
      const envId = (envResponse[1] as { id: string }).id;

      expect(
        await call("question.resolve", {
          id: envId,
          answers: { answers: { secret_value: ["https://example.test"] } },
          secretStoreAllowedHosts: ["example.test"],
        }),
      ).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
      expect(manager.get(envId)?.status).toBe("pending");

      const ordinaryResponse = await call("question.request", requestParams);
      const ordinaryId = (ordinaryResponse[1] as { id: string }).id;
      expect(
        await call("question.resolve", {
          id: ordinaryId,
          answers: { answers: { destination: ["Home"] } },
          secretStoreAllowedHosts: ["example.test"],
        }),
      ).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
      expect(manager.get(ordinaryId)?.status).toBe("pending");
    });
  });

  it("stores environment entries without host policy and preserves secret-question cancellation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const envQuestion = {
        ...secretRequestParams.questions[0],
        secretStore: { name: "SERVICE_URL", kind: "env" as const },
      };
      const envResponse = await call(
        "question.request",
        { ...secretRequestParams, questions: [envQuestion] },
        { client: adminRequestClient },
      );
      const envId = (envResponse[1] as { id: string }).id;
      expect(
        (
          await call("question.resolve", {
            id: envId,
            answers: { answers: { secret_value: ["https://example.test"] } },
          })
        )[0],
      ).toBe(true);
      expect(listSecretStoreEntries({ scope: { kind: "team" } })[0]).toMatchObject({
        name: "SERVICE_URL",
        kind: "env",
        valuePreview: "https://example.test",
      });

      const cancelledResponse = await call("question.request", secretRequestParams, {
        client: adminRequestClient,
      });
      const cancelledId = (cancelledResponse[1] as { id: string }).id;
      expect(await call("question.resolve", { id: cancelledId, cancel: true })).toEqual([
        true,
        { status: "cancelled" },
        undefined,
      ]);
      expect(manager.get(cancelledId)?.status).toBe("cancelled");
    });
  });

  it("cold-refreshes configured SecretRefs after a store-bound question is answered", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.spyOn(secretsRuntimeState, "getActiveSecretsRuntimeSnapshotState").mockReturnValue({
        sourceConfig: {
          models: {
            providers: {
              test: {
                baseUrl: "https://provider.example.test",
                models: [],
                apiKey: { source: "store", provider: "default", id: "SERVICE_API_KEY" },
              },
            },
          },
        },
        config: {},
        authStores: [],
        authStoreCredentialsRevision: 0,
        warnings: [],
        webTools: {
          search: { providerSource: "none", diagnostics: [] },
          fetch: { providerSource: "none", diagnostics: [] },
          diagnostics: [],
        },
      });
      const requested = await call("question.request", secretRequestParams, {
        client: adminRequestClient,
      });
      const id = (requested[1] as { id: string }).id;

      expect(
        (
          await call("question.resolve", {
            id,
            answers: { answers: { secret_value: ["test-secret-value-cold-refresh-123"] } },
          })
        )[0],
      ).toBe(true);
      expect(reloadSecrets).toHaveBeenCalledWith({
        forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]),
        joinInFlight: false,
      });
    });
  });

  it("keeps store-bound questions pending when the write service is unavailable", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const service = createSecretStoreWriteService({ reloadSecrets });
      handlers = createQuestionHandlers(manager, {
        ...service,
        write: vi.fn().mockRejectedValue(new Error("database unavailable")),
      });
      const requested = await call("question.request", secretRequestParams, {
        client: adminRequestClient,
      });
      const id = (requested[1] as { id: string }).id;

      expect(
        await call("question.resolve", {
          id,
          answers: { answers: { secret_value: ["test-secret-value-unavailable-123"] } },
        }),
      ).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
      expect(manager.get(id)?.status).toBe("pending");
    });
  });

  it("returns INVALID_REQUEST for answers that violate the stored question", async () => {
    const requested = await call("question.request", {
      ...requestParams,
      questions: [
        {
          ...requestParams.questions[0],
          options: [{ label: "Home" }, { label: "Office" }],
          isOther: false,
        },
      ],
    });
    const id = (requested[1] as { id: string }).id;

    const resolved = await call("question.resolve", {
      id,
      answers: { answers: { destination: ["Somewhere else"] } },
    });

    expect(resolved[0]).toBe(false);
    expect(resolved[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("question 'destination'"),
      details: { reason: "QUESTION_INVALID_ANSWER" },
    });
    expect(manager.get(id)?.status).toBe("pending");
  });
});
