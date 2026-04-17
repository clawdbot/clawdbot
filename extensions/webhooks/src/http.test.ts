import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../../../test/helpers/plugins/mock-http-response.js";
import { createRuntimeTaskFlow } from "../../../test/helpers/plugins/runtime-taskflow.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { createTaskFlowWebhookRequestHandler, type TaskFlowWebhookTarget } from "./http.js";

const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  const resolveConfiguredSecretInputStringMock = vi.fn();
  return {
    sendMessageMock,
    cancelSessionMock,
    killSubagentRunAdminMock,
    resolveConfiguredSecretInputStringMock,
  };
});

vi.mock("../../../src/tasks/task-registry-delivery-runtime.js", () => ({
  sendMessage: hoisted.sendMessageMock,
}));

vi.mock("../../../src/acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../../../src/agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  hoisted.resolveConfiguredSecretInputStringMock.mockImplementation(
    actual.resolveConfiguredSecretInputString,
  );
  return {
    ...actual,
    resolveConfiguredSecretInputString: hoisted.resolveConfiguredSecretInputStringMock,
  };
});

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
  socket: { remoteAddress: string };
};

let nextSessionId = 0;

function createJsonRequest(params: {
  path: string;
  secret?: string;
  body: unknown;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = "POST";
  req.url = params.path;
  req.headers = {
    "content-type": "application/json",
    ...(params.secret ? { "x-openclaw-webhook-secret": params.secret } : {}),
  };
  req.socket = { remoteAddress: "127.0.0.1" } as MockIncomingMessage["socket"];
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(params.body), "utf8"));
    req.emit("end");
  });

  return req;
}

function createHandler(): {
  handler: ReturnType<typeof createTaskFlowWebhookRequestHandler>;
  target: TaskFlowWebhookTarget;
  secret: string;
} {
  const runtime = createRuntimeTaskFlow();
  nextSessionId += 1;
  const secret = "shared-secret";
  const target: TaskFlowWebhookTarget = {
    routeId: "zapier",
    path: "/plugins/webhooks/zapier",
    secretInput: secret,
    secretConfigPath: "plugins.entries.webhooks.routes.zapier.secret",
    defaultControllerId: "webhooks/zapier",
    taskFlow: runtime.bindSession({
      sessionKey: `agent:main:webhook-test-${String(nextSessionId)}`,
    }),
  };
  const targetsByPath = new Map<string, TaskFlowWebhookTarget[]>([[target.path, [target]]]);
  return {
    handler: createTaskFlowWebhookRequestHandler({
      cfg: {} as OpenClawConfig,
      targetsByPath,
    }),
    target,
    secret,
  };
}

function createHandlerWithTarget(
  target: TaskFlowWebhookTarget,
  cfg: OpenClawConfig = {} as OpenClawConfig,
): ReturnType<typeof createTaskFlowWebhookRequestHandler> {
  const targetsByPath = new Map<string, TaskFlowWebhookTarget[]>([[target.path, [target]]]);
  return createTaskFlowWebhookRequestHandler({
    cfg,
    targetsByPath,
  });
}

async function dispatchJsonRequest(params: {
  handler: ReturnType<typeof createTaskFlowWebhookRequestHandler>;
  path: string;
  secret?: string;
  body: unknown;
}) {
  const req = createJsonRequest({
    path: params.path,
    secret: params.secret,
    body: params.body,
  });
  const res = createMockServerResponse();
  await params.handler(req, res);
  return res;
}

function parseJsonBody(res: { body?: string | Buffer | null }) {
  return JSON.parse(String(res.body ?? ""));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createTaskFlowWebhookRequestHandler", () => {
  it("rejects requests with the wrong secret", async () => {
    const { handler, target } = createHandler();
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret: "wrong-secret",
      body: {
        action: "list_flows",
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("unauthorized");
    expect(target.taskFlow.list()).toEqual([]);
  });

  it("caches SecretRef resolution across requests for the same route", async () => {
    const runtime = createRuntimeTaskFlow();
    const target: TaskFlowWebhookTarget = {
      routeId: "cached",
      path: "/plugins/webhooks/cached",
      secretInput: {
        source: "env",
        provider: "default",
        id: "OPENCLAW_WEBHOOK_SECRET",
      },
      secretConfigPath: "plugins.entries.webhooks.routes.cached.secret",
      defaultControllerId: "webhooks/cached",
      taskFlow: runtime.bindSession({
        sessionKey: "agent:main:webhook-cached",
      }),
    };
    hoisted.resolveConfiguredSecretInputStringMock.mockResolvedValue({ value: "shared-secret" });
    const handler = createHandlerWithTarget(target);

    const first = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret: "shared-secret",
      body: {
        action: "list_flows",
      },
    });
    const second = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret: "shared-secret",
      body: {
        action: "list_flows",
      },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(hoisted.resolveConfiguredSecretInputStringMock).toHaveBeenCalledTimes(1);
  });

  it("creates flows through the bound session and scrubs owner metadata from responses", async () => {
    const { handler, target, secret } = createHandler();
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "create_flow",
        goal: "Review inbound queue",
      },
    });

    expect(res.statusCode).toBe(200);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.flow).toMatchObject({
      syncMode: "managed",
      controllerId: "webhooks/zapier",
      goal: "Review inbound queue",
    });
    expect(parsed.result.flow.ownerKey).toBeUndefined();
    expect(parsed.result.flow.requesterOrigin).toBeUndefined();
    expect(target.taskFlow.get(parsed.result.flow.flowId)?.flowId).toBe(parsed.result.flow.flowId);
  });

  it("runs child tasks and scrubs task ownership fields from responses", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Triage inbox",
    });
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:main:subagent:child",
        task: "Inspect the next message batch",
        status: "running",
        startedAt: 10,
        lastEventAt: 10,
      },
    });

    expect(res.statusCode).toBe(200);
    const parsed = parseJsonBody(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.created).toBe(true);
    expect(parsed.result.task).toMatchObject({
      parentFlowId: flow.flowId,
      childSessionKey: "agent:main:subagent:child",
      runtime: "acp",
    });
    expect(parsed.result.task.ownerKey).toBeUndefined();
    expect(parsed.result.task.requesterSessionKey).toBeUndefined();
  });

  it("returns 404 for missing flow mutations", async () => {
    const { handler, target, secret } = createHandler();
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "set_waiting",
        flowId: "flow-missing",
        expectedRevision: 0,
      },
    });

    expect(res.statusCode).toBe(404);
    const parsed = parseJsonBody(res);
    expect(parsed).toMatchObject({
      ok: false,
      code: "not_found",
      error: "TaskFlow not found.",
      result: {
        applied: false,
        code: "not_found",
      },
    });
  });

  it("returns 409 for revision conflicts", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Review inbox",
    });
    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "set_waiting",
        flowId: flow.flowId,
        expectedRevision: flow.revision + 1,
      },
    });

    expect(res.statusCode).toBe(409);
    const parsed = parseJsonBody(res);
    expect(parsed).toMatchObject({
      ok: false,
      code: "revision_conflict",
      result: {
        applied: false,
        code: "revision_conflict",
        current: {
          flowId: flow.flowId,
          revision: flow.revision,
        },
      },
    });
  });

  it("rejects internal runtimes and running-only metadata from external callers", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Review inbox",
    });

    const runtimeRes = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "cli",
        task: "Inspect queue",
      },
    });
    expect(runtimeRes.statusCode).toBe(400);
    expect(parseJsonBody(runtimeRes)).toMatchObject({
      ok: false,
      code: "invalid_request",
    });

    const queuedMetadataRes = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "acp",
        task: "Inspect queue",
        startedAt: 10,
      },
    });
    expect(queuedMetadataRes.statusCode).toBe(400);
    expect(parseJsonBody(queuedMetadataRes)).toMatchObject({
      ok: false,
      code: "invalid_request",
      error:
        "status: status must be running when startedAt, lastEventAt, or progressSummary is provided",
    });
  });

  it("reuses the same task record when retried with the same runId", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Triage inbox",
    });

    const first = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:main:subagent:child",
        runId: "retry-me",
        task: "Inspect the next message batch",
      },
    });
    const second = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "run_task",
        flowId: flow.flowId,
        runtime: "acp",
        childSessionKey: "agent:main:subagent:child",
        runId: "retry-me",
        task: "Inspect the next message batch",
      },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstParsed = parseJsonBody(first);
    const secondParsed = parseJsonBody(second);
    expect(firstParsed.result.task.taskId).toBe(secondParsed.result.task.taskId);
    expect(target.taskFlow.getTaskSummary(flow.flowId)?.total).toBe(1);
  });

  it("returns 409 when cancellation targets a terminal flow", async () => {
    const { handler, target, secret } = createHandler();
    const flow = target.taskFlow.createManaged({
      controllerId: "webhooks/zapier",
      goal: "Review inbox",
    });
    const finished = target.taskFlow.finish({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
    });
    expect(finished.applied).toBe(true);

    const res = await dispatchJsonRequest({
      handler,
      path: target.path,
      secret,
      body: {
        action: "cancel_flow",
        flowId: flow.flowId,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(parseJsonBody(res)).toMatchObject({
      ok: false,
      code: "terminal",
      error: "Flow is already succeeded.",
      result: {
        found: true,
        cancelled: false,
        reason: "Flow is already succeeded.",
      },
    });
  });
});
