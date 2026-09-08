import { afterEach, beforeEach, expect, vi } from "vitest";
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  registerAgentRunDelegatedAuthorityClosedHandler,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { QuestionManager } from "../question-manager.js";
import type { GatewayBroadcastFn } from "../server-broadcast-types.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretStoreWriteService } from "./secrets.js";
import type { GatewayClient, RespondFn } from "./types.js";

export let manager: QuestionManager;
export let requesterAuthority: AgentRunDelegatedAuthority;
let unregisterAuthorityClosed: () => void;
export let adminRequestClient: GatewayClient;
export let broadcast: ReturnType<typeof vi.fn<GatewayBroadcastFn>>;
export let storeWriteService: ReturnType<typeof createSecretStoreWriteService>;
let handlers: ReturnType<typeof createQuestionHandlers>;
type SecretStoreReload = Parameters<typeof createSecretStoreWriteService>[0]["reloadSecrets"];
export let reloadSecrets: ReturnType<typeof vi.fn<SecretStoreReload>>;

export function installQuestionTestHooks() {
  beforeEach(() => {
    // Keep projection metadata alive independently of the exact admitted authority.
    registerAgentRunContext(requestParams.runId, {
      sessionKey: requestParams.sessionKey,
      agentId: requestParams.agentId,
    });
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    manager = new QuestionManager();
    requesterAuthority = claimAgentRunDelegatedAuthority({
      instanceId: "requester-instance",
      runId: requestParams.runId,
    });
    adminRequestClient = {
      connect: { scopes: ["operator.admin"] },
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: requestParams.agentId,
          sessionKey: requestParams.sessionKey,
          operationalRunInstance: requesterAuthority.operationalRunInstance,
          delegatedAuthority: { kind: "local", ...requesterAuthority },
        },
      },
    } as GatewayClient;
    unregisterAuthorityClosed = registerAgentRunDelegatedAuthorityClosedHandler(() =>
      manager.cancelClosedAuthorities(),
    );
    broadcast = vi.fn<GatewayBroadcastFn>();
    reloadSecrets = vi.fn<SecretStoreReload>().mockResolvedValue({ warningCount: 0 });
    storeWriteService = createSecretStoreWriteService({ reloadSecrets });
    handlers = createQuestionHandlers(manager, storeWriteService);
  });

  afterEach(() => {
    releaseAgentRunDelegatedAuthority(requesterAuthority);
    unregisterAuthorityClosed();
    clearAgentRunContext(requestParams.runId);
    manager.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}

export async function callQuestionRpc(
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
    context: createDirectChatContext({
      broadcast,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      getRuntimeConfig: () => options?.cfg ?? {},
    }),
  });
  const response = calls[0];
  if (!response) {
    throw new Error(`expected ${method} response`);
  }
  return response;
}

export const requestParams = {
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

export const secretRequestQuestion = {
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

export const secretRequestParams = {
  ...requestParams,
  questions: [secretRequestQuestion],
};

export async function requestSecretQuestion(
  binding: NonNullable<QuestionRequestQuestion["secretStore"]> = secretRequestQuestion.secretStore,
): Promise<string> {
  const response = await callQuestionRpc(
    "question.request",
    {
      ...secretRequestParams,
      questions: [{ ...secretRequestQuestion, secretStore: binding }],
    },
    { client: adminRequestClient },
  );
  expect(response[0]).toBe(true);
  return (response[1] as { id: string }).id;
}
