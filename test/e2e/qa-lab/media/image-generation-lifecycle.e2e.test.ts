import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
  createQaGatewayChild,
  type QaGatewayChild,
  startQaMockOpenAiServer,
  TINY_PNG_BASE64,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const IMAGE_MODEL_REF = "openai/gpt-image-1";
const REQUEST_TEXT =
  "Image generation check IMAGE_TASK_LIFECYCLE: generate the QA lighthouse image.";
const CONVERSATION = { id: "image-generation-lifecycle", kind: "direct" as const };

type GatewayTask = {
  id: string;
  kind?: string;
  sourceId?: string;
  status: string;
  progressSummary?: string;
  endedAt?: string | number;
};

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startControlledImageProvider() {
  const requests: Record<string, unknown>[] = [];
  const pendingResponses = new Set<ServerResponse>();
  let released = false;

  const complete = (response: ServerResponse) => {
    pendingResponses.delete(response);
    writeJson(response, 200, {
      data: [
        {
          b64_json: TINY_PNG_BASE64,
          revised_prompt: "A QA lighthouse with a tiny protocol droid silhouette.",
        },
      ],
    });
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/images/generations") {
        writeJson(response, 404, { error: "not found" });
        return;
      }
      const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
      requests.push(body);
      if (released) {
        complete(response);
        return;
      }
      pendingResponses.add(response);
    })().catch((error: unknown) => {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const release = () => {
    released = true;
    for (const response of pendingResponses) {
      complete(response);
    }
  };

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    release,
    async stop() {
      release();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function configureImageProvider(
  config: OpenClawConfig,
  imageProviderBaseUrl: string,
): OpenClawConfig {
  const openAiProvider = config.models?.providers?.openai;
  if (!openAiProvider) {
    throw new Error("openai image provider is missing from QA gateway config");
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        mediaModels: {
          ...config.agents?.defaults?.mediaModels,
          image: { primary: IMAGE_MODEL_REF },
        },
      },
    },
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        openai: {
          ...openAiProvider,
          baseUrl: `${imageProviderBaseUrl}/v1`,
          request: {
            ...openAiProvider.request,
            allowPrivateNetwork: true,
          },
        },
      },
    },
  };
}

async function readMockRequests(baseUrl: string): Promise<MockOpenAiRequestSnapshot[]> {
  const response = await fetch(`${baseUrl}/debug/requests`);
  if (!response.ok) {
    throw new Error(`mock request log failed with HTTP ${response.status}`);
  }
  return (await response.json()) as MockOpenAiRequestSnapshot[];
}

async function waitForToolOutput(baseUrl: string, needle: string) {
  let matched: MockOpenAiRequestSnapshot | undefined;
  await vi.waitFor(
    async () => {
      matched = (await readMockRequests(baseUrl)).find(
        (request) =>
          request.allInputText.includes("IMAGE_TASK_LIFECYCLE") &&
          request.toolOutput.includes(needle),
      );
      expect(matched).toBeDefined();
    },
    { interval: 50, timeout: 30_000 },
  );
  return matched as MockOpenAiRequestSnapshot;
}

async function readImageTasks(gateway: QaGatewayChild): Promise<GatewayTask[]> {
  const payload = (await gateway.call("tasks.list", { limit: 100 })) as {
    tasks?: GatewayTask[];
  };
  return (payload.tasks ?? []).filter(
    (task) => task.kind === "image_generation" && task.sourceId === "image_generate:openai",
  );
}

describe("image generation task lifecycle through QA-channel", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "image generation lifecycle cleanup failed");
    }
  });

  it("deduplicates requests and labels internal completion provenance", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());

    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());

    const imageProvider = await startControlledImageProvider();
    cleanups.push(() => imageProvider.stop());

    const gatewayOwner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
    const gateway = await gatewayOwner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: (config) => configureImageProvider(config, imageProvider.baseUrl),
    });
    await transport.waitReady({ gateway });

    const sendExactRequest = () =>
      transport.sendInbound({
        accountId: "default",
        conversation: CONVERSATION,
        senderId: CONVERSATION.id,
        text: REQUEST_TEXT,
      });

    await sendExactRequest();
    await vi.waitFor(() => expect(imageProvider.requests).toHaveLength(1), {
      interval: 50,
      timeout: 30_000,
    });

    let runningTasks: GatewayTask[] = [];
    await vi.waitFor(
      async () => {
        runningTasks = await readImageTasks(gateway);
        expect(runningTasks).toHaveLength(1);
        expect(runningTasks[0]).toMatchObject({
          id: expect.any(String),
          status: "running",
          progressSummary: "Generating image",
        });
      },
      { interval: 50, timeout: 30_000 },
    );
    const taskId = runningTasks[0]?.id;
    expect(taskId).toEqual(expect.any(String));

    await sendExactRequest();
    const runningDuplicate = await waitForToolOutput(mock.baseUrl, "is already running");
    expect(runningDuplicate.toolOutput).toContain(taskId);
    expect(imageProvider.requests).toHaveLength(1);
    expect(await readImageTasks(gateway)).toEqual([
      expect.objectContaining({ id: taskId, status: "running" }),
    ]);

    imageProvider.release();
    await vi.waitFor(
      () => {
        const completions = state
          .getSnapshot()
          .messages.filter(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === CONVERSATION.id &&
              message.attachments !== undefined &&
              message.attachments.some(
                (attachment) =>
                  attachment.kind === "image" &&
                  attachment.mimeType === "image/png" &&
                  attachment.contentBase64 === TINY_PNG_BASE64,
              ),
          );
        expect(completions).toHaveLength(1);
      },
      { interval: 50, timeout: 90_000 },
    );

    let completedTasks: GatewayTask[] = [];
    await vi.waitFor(
      async () => {
        completedTasks = await readImageTasks(gateway);
        expect(completedTasks).toEqual([
          expect.objectContaining({
            id: taskId,
            status: "completed",
            progressSummary: "Generated 1 image",
            endedAt: expect.anything(),
          }),
        ]);
      },
      { interval: 50, timeout: 30_000 },
    );

    const completionReentry = await vi.waitFor(
      async () => {
        const request = (await readMockRequests(mock.baseUrl)).find(
          (request) =>
            request.allInputText.includes("[Inter-session message]") &&
            request.allInputText.includes("sourceTool=image_generate"),
        );
        if (!request) {
          throw new Error("image completion did not re-enter the agent session");
        }
        return request;
      },
      { interval: 50, timeout: 30_000 },
    );
    expect(completionReentry.allInputText).toContain("sourceChannel=internal");

    await sendExactRequest();
    const completedDuplicate = await waitForToolOutput(mock.baseUrl, "recently succeeded");
    expect(completedDuplicate.toolOutput).toContain(taskId);

    const plannedCalls = (await readMockRequests(mock.baseUrl)).filter(
      (request) =>
        request.allInputText.includes("IMAGE_TASK_LIFECYCLE") &&
        request.plannedToolName === "image_generate",
    );
    expect(plannedCalls).toHaveLength(3);
    expect(plannedCalls.map((request) => request.plannedToolArgs)).toEqual([
      plannedCalls[0]?.plannedToolArgs,
      plannedCalls[0]?.plannedToolArgs,
      plannedCalls[0]?.plannedToolArgs,
    ]);
    expect(imageProvider.requests).toHaveLength(1);
    expect(await readImageTasks(gateway)).toEqual([
      expect.objectContaining({ id: taskId, status: "completed" }),
    ]);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    const completionOutcomes = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" &&
          message.conversation.id === CONVERSATION.id &&
          message.attachments !== undefined &&
          message.attachments.some((attachment) => attachment.kind === "image"),
      );
    expect(completionOutcomes).toHaveLength(1);
  }, 180_000);
});
