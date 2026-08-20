import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  type MockOpenAiRequestSnapshot,
  startQaBusServer,
  startQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const ACTIVE_MODEL_ID = "gpt-5.6-luna";
const ACTIVE_MODEL_REF = `mock-openai/${ACTIVE_MODEL_ID}`;
const IMAGE_MODEL_ID = "gpt-5.6-luna-alt";
const IMAGE_MODEL_REF = `mock-openai/${IMAGE_MODEL_ID}`;
const SCENARIO_MARKER = "VISION_CHANNEL_OFFLOAD";
const FINAL_REPLY = "QA_VISION_CHANNEL_OFFLOAD_OK";
const PROVIDER_SUMMARY =
  "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.";
const IMAGE_PROMPT = `Image understanding check ${SCENARIO_MARKER}: describe the top and bottom colors.`;
const SPLIT_COLOR_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGP4z8DwnxLMMGrAsDCAQv2jBgwPAwAxtf4Q24P5oAAAAABJRU5ErkJggg==";
const CONVERSATION = { id: "vision-channel-offload", kind: "direct" as const };

function configureVisionOffload(config: OpenClawConfig): OpenClawConfig {
  const provider = config.models?.providers?.["mock-openai"];
  if (!provider) {
    throw new Error("mock-openai provider is missing from QA gateway config");
  }
  let foundActiveModel = false;
  const models = provider.models.map((model) => {
    if (model.id !== ACTIVE_MODEL_ID) {
      return model;
    }
    foundActiveModel = true;
    return { ...model, input: ["text" as const] };
  });
  if (!foundActiveModel) {
    throw new Error(`active QA model is missing from provider catalog: ${ACTIVE_MODEL_ID}`);
  }

  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        imageModel: { primary: IMAGE_MODEL_REF },
      },
    },
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        "mock-openai": {
          ...provider,
          models,
        },
      },
    },
    tools: {
      ...config.tools,
      media: {
        ...config.tools?.media,
        image: {
          ...config.tools?.media?.image,
          prompt: IMAGE_PROMPT,
        },
      },
    },
  };
}

async function readMockRequests(baseUrl: string, after: number) {
  const response = await fetch(`${baseUrl}/debug/requests?after=${after}`);
  if (!response.ok) {
    throw new Error(
      `mock request log failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as MockOpenAiRequestSnapshot[];
}

function compactRequestShapes(requests: MockOpenAiRequestSnapshot[]) {
  return requests.map((request) => ({
    cursor: request.cursor,
    model: request.model,
    imageInputCount: request.imageInputCount,
    inputRoles: readInputRoles(request),
    instructions: request.instructions?.slice(0, 240),
    allInputTextTail: request.allInputText.slice(-400),
  }));
}

function readInputRoles(request: MockOpenAiRequestSnapshot) {
  const input = Array.isArray(request.body.input) ? request.body.input : [];
  return input.flatMap((item) =>
    item && typeof item === "object" && typeof (item as { role?: unknown }).role === "string"
      ? [(item as { role: string }).role]
      : [],
  );
}

describe("QA-channel vision offload", () => {
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
    if (errors.length > 0) {
      throw new AggregateError(errors, "vision channel offload cleanup failed");
    }
  });

  it("summarizes an image before the text-only active model replies once", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());

    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());

    const gateway = await startQaGatewayChild({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: ACTIVE_MODEL_REF,
      alternateModel: IMAGE_MODEL_REF,
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: configureVisionOffload,
    });
    cleanups.push(() => gateway.stop());
    await transport.waitReady({ gateway });

    const cursorResponse = await fetch(`${mock.baseUrl}/debug/request-cursor`);
    const cursorBody = (await cursorResponse.json()) as { cursor?: unknown };
    expect(cursorResponse.ok).toBe(true);
    expect(typeof cursorBody.cursor).toBe("number");
    const requestCursor = cursorBody.cursor as number;

    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text: `${SCENARIO_MARKER}: use the image description and reply exactly ${FINAL_REPLY}.`,
      attachments: [
        {
          id: "split-color-image",
          kind: "image",
          mimeType: "image/png",
          fileName: "red-top-blue-bottom.png",
          contentBase64: SPLIT_COLOR_PNG_BASE64,
        },
      ],
    });

    let finalOutbound;
    try {
      finalOutbound = await transport.waitForOutbound({
        conversation: CONVERSATION,
        textIncludes: FINAL_REPLY,
        timeoutMs: 90_000,
      });
    } catch (error) {
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `bus=${JSON.stringify(state.getSnapshot())}`,
          `gateway=${gateway.logs()}`,
        ].join("\n"),
        { cause: error },
      );
    }

    const scenarioRequests = (await readMockRequests(mock.baseUrl, requestCursor)).filter(
      (request) => request.allInputText.includes(SCENARIO_MARKER),
    );
    const requestDiagnostics = `requests=${JSON.stringify(compactRequestShapes(scenarioRequests))}`;
    expect(scenarioRequests, requestDiagnostics).toHaveLength(2);

    const [imageRequest, activeModelRequest] = scenarioRequests;
    if (!imageRequest || !activeModelRequest) {
      throw new Error(requestDiagnostics);
    }
    expect(imageRequest.model, requestDiagnostics).toBe(IMAGE_MODEL_ID);
    expect(imageRequest.imageInputCount, requestDiagnostics).toBe(1);
    expect(readInputRoles(imageRequest), requestDiagnostics).toEqual(["developer", "user"]);
    expect(activeModelRequest.model, requestDiagnostics).toBe(ACTIVE_MODEL_ID);
    expect(activeModelRequest.imageInputCount, requestDiagnostics).toBe(0);
    expect(readInputRoles(activeModelRequest), requestDiagnostics).toEqual([
      "system",
      "user",
      "user",
    ]);
    expect(imageRequest.cursor, requestDiagnostics).toBeLessThan(activeModelRequest.cursor);
    expect(imageRequest.allInputText, requestDiagnostics).toContain(IMAGE_PROMPT);
    expect(activeModelRequest.allInputText, requestDiagnostics).toContain(PROVIDER_SUMMARY);

    const visibleOutbound = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" &&
          message.accountId === "default" &&
          message.conversation.id === CONVERSATION.id &&
          message.conversation.kind === CONVERSATION.kind &&
          !message.deleted,
      );
    expect(visibleOutbound).toHaveLength(1);
    expect(visibleOutbound[0]).toMatchObject({
      id: finalOutbound.id,
      text: FINAL_REPLY,
    });
  }, 180_000);
});
