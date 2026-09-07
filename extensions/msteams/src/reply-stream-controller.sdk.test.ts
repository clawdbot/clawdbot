import { createServer, request as requestHttp } from "node:http";
import { HttpStream } from "@microsoft/teams.apps/dist/http/http-stream.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

type TeamsLoopbackRequest = {
  scenario: string;
  type: string;
  text: string;
  status: number;
  entities?: unknown[];
};

const acknowledgedPrefix = "a".repeat(4_000);
const completeReply = `${acknowledgedPrefix}${"b".repeat(200)}`;
const replacementReply = "provider-final replacement";
const requests: TeamsLoopbackRequest[] = [];

const provider = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  request.on("end", () => {
    const activity = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      type?: string;
      text?: string;
      entities?: unknown[];
    };
    const scenario = request.url?.slice(1) ?? "";
    const priorScenarioRequests = requests.filter((entry) => entry.scenario === scenario).length;
    const rejected =
      scenario === "no-ack" ||
      ((scenario === "cancel-replacement" || scenario === "presentation-cancel") &&
        priorScenarioRequests > 0) ||
      (scenario === "presentation-close-failure" && activity.type === "message") ||
      (scenario === "presentation-timeout" && priorScenarioRequests === 2) ||
      (activity.text?.length ?? 0) > 4_000;
    const status = rejected ? 403 : 201;
    requests.push({
      scenario,
      type: activity.type ?? "",
      text: activity.text ?? "",
      status,
      ...(scenario.startsWith("presentation-") ? { entities: activity.entities } : {}),
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        rejected
          ? {
              error: {
                message:
                  scenario === "presentation-timeout"
                    ? "exceeded streaming time"
                    : scenario.startsWith("cancel") || scenario === "presentation-cancel"
                      ? "Content stream was canceled by user"
                      : "Message size too large",
              },
            }
          : { id: `stream-${scenario}` },
      ),
    );
  });
  request.on("error", (error) => response.destroy(error));
});

let providerUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const address = provider.address();
  if (!address || typeof address === "string") {
    throw new Error("Teams test provider did not expose a loopback address");
  }
  providerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    provider.close((error) => (error ? reject(error) : resolve()));
  });
});

function createLoopbackController(
  scenario: string,
  msteamsConfig?: Parameters<typeof createTeamsReplyStreamController>[0]["msteamsConfig"],
) {
  const send = async (activity: Record<string, unknown>) => {
    const result = await new Promise<{
      status: number;
      body: { id?: string; error?: { message?: string } };
    }>((resolve, reject) => {
      const outgoing = requestHttp(
        `${providerUrl}/${scenario}`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            try {
              resolve({
                status: response.statusCode ?? 500,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                  id?: string;
                  error?: { message?: string };
                },
              });
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
          response.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify(activity));
    });
    if (result.status < 200 || result.status >= 300) {
      throw Object.assign(new Error(result.body.error?.message ?? "Teams streaming failed"), {
        response: { status: result.status, data: result.body },
      });
    }
    return result.body;
  };
  const firstAcknowledgement = createDeferred<void>();
  const firstFlushFailure = createDeferred<void>();
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(() => firstFlushFailure.resolve()),
    info: vi.fn(),
    warn: vi.fn(() => {
      if (scenario.startsWith("cancel")) {
        firstFlushFailure.resolve();
      }
    }),
  };
  logger.child.mockReturnValue(logger);
  const stream = new HttpStream(
    {
      conversations: {
        createActivity: (_conversationId: string, activity: Record<string, unknown>) =>
          send(activity),
        updateActivity: (
          _conversationId: string,
          _activityId: string,
          activity: Record<string, unknown>,
        ) => send(activity),
      },
    } as never,
    {
      bot: { id: "28:loopback-bot", name: "OpenClaw" },
      conversation: { id: "loopback-conversation", conversationType: "personal" },
      activityId: "loopback-inbound",
    } as never,
    logger as never,
  );
  const acknowledgements: Array<{ id: string; text: string }> = [];
  stream.events.on("chunk", (activity) => {
    acknowledgements.push({ id: activity.id, text: activity.text ?? "" });
    firstAcknowledgement.resolve();
  });
  const controller = createTeamsReplyStreamController({
    allowProviderPreview: true,
    conversationType: "personal",
    context: { activity: { type: "message" }, stream } as never,
    feedbackLoopEnabled: false,
    msteamsConfig,
  });
  return {
    acknowledgements,
    controller,
    sendActivity: send,
    firstAcknowledgement: firstAcknowledgement.promise,
    firstFlushFailure: firstFlushFailure.promise,
    logger,
    stream,
  };
}

describe("Microsoft Teams SDK acknowledged stream fallback", () => {
  it.each([
    { label: "default", progress: {}, expectedLabel: "Working" },
    { label: "custom", progress: { label: "Custom progress" }, expectedLabel: "Custom progress" },
  ])(
    "clears and recreates a plan with the $label label before the final reply",
    async ({ label, progress, expectedLabel }) => {
      const scenario = `plan-clear-${label}`;
      const { acknowledgements, controller } = createLoopbackController(scenario, {
        streaming: { mode: "progress", progress },
      });
      const plan = [{ step: "Inspect", status: "in_progress" as const }];

      try {
        await controller.pushPlanProgress(plan);
        await expect
          .poll(() => acknowledgements.at(-1)?.text)
          .toBe(`${expectedLabel}\n\n▸ Inspect`);

        await controller.pushPlanProgress([]);
        await expect.poll(() => acknowledgements.at(-1)?.text).toBe(expectedLabel);

        await controller.pushPlanProgress(plan);
        await expect
          .poll(() => acknowledgements.at(-1)?.text)
          .toBe(`${expectedLabel}\n\n▸ Inspect`);
      } finally {
        expect(controller.preparePayload({ text: "Done" })).toBeUndefined();
        await expect(controller.finalize()).resolves.toEqual({
          visibleReplySent: true,
          content: "Done",
          messageId: `stream-${scenario}`,
        });
      }
      expect(requests.findLast((request) => request.scenario === scenario)).toEqual({
        scenario,
        type: "message",
        text: "Done",
        status: 201,
      });
    },
  );

  it("redelivers only text not acknowledged by the real Teams SDK and HTTP provider", async () => {
    const { acknowledgements, controller, firstAcknowledgement, firstFlushFailure, logger } =
      createLoopbackController("size-limit");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await firstAcknowledgement;
    expect(logger.error).not.toHaveBeenCalled();
    expect(acknowledgements).toEqual([{ id: "stream-size-limit", text: acknowledgedPrefix }]);

    controller.onPartialReply({ text: completeReply });
    await firstFlushFailure;
    expect(
      requests.filter(
        (request) =>
          request.scenario === "size-limit" && request.type === "typing" && request.status === 403,
      ),
    ).toHaveLength(1);
    expect(acknowledgements).toEqual([{ id: "stream-size-limit", text: acknowledgedPrefix }]);
    expect(controller.preparePayload({ text: completeReply })).toBeUndefined();

    await expect(controller.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: acknowledgedPrefix,
      messageId: "stream-size-limit",
      fallbackPayload: { text: "b".repeat(200) },
    });
    // Finalization queues its own metadata activity; this is a second
    // provider operation, not a retry of the rejected streaming chunk.
    expect(
      requests.filter(
        (request) =>
          request.scenario === "size-limit" && request.type === "typing" && request.status === 403,
      ),
    ).toHaveLength(2);
  });

  it("never acknowledges a Teams HTTP request rejected before delivery", async () => {
    const { acknowledgements, controller, firstFlushFailure } = createLoopbackController("no-ack");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await firstFlushFailure;

    expect(acknowledgements).toEqual([]);
    expect(requests.find((request) => request.scenario === "no-ack")?.status).toBe(403);
  });

  it("honors a real Teams HTTP cancellation without redelivering the remaining text", async () => {
    const {
      acknowledgements,
      controller,
      firstAcknowledgement,
      firstFlushFailure,
      logger,
      stream,
    } = createLoopbackController("cancel");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await firstAcknowledgement;
    expect(logger.error).not.toHaveBeenCalled();
    expect(acknowledgements).toEqual([{ id: "stream-cancel", text: acknowledgedPrefix }]);
    controller.onPartialReply({ text: completeReply });
    await firstFlushFailure;
    await stream.close();
    expect(stream.canceled).toBe(true);

    expect(controller.preparePayload({ text: completeReply })).toBeUndefined();
    await expect(controller.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: acknowledgedPrefix,
      messageId: "stream-cancel",
    });
    expect(requests.filter((request) => request.scenario === "cancel")).toHaveLength(2);
  });

  it("replaces a divergent preview through the same real Teams stream", async () => {
    const { acknowledgements, controller, firstAcknowledgement, logger } =
      createLoopbackController("replacement");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await firstAcknowledgement;
    expect(logger.error).not.toHaveBeenCalled();
    expect(acknowledgements).toEqual([{ id: "stream-replacement", text: acknowledgedPrefix }]);

    controller.onPartialReply({ text: replacementReply });
    expect(
      controller.preparePayload({
        text: replacementReply,
        mediaUrl: "https://example.test/replacement.png",
      }),
    ).toBeUndefined();
    await expect(controller.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: replacementReply,
      logicalContent: replacementReply,
      messageId: "stream-replacement",
      postNativePayloads: [
        {
          text: undefined,
          mediaUrl: "https://example.test/replacement.png",
        },
      ],
    });
    expect(acknowledgements).toEqual([
      { id: "stream-replacement", text: acknowledgedPrefix },
      { id: "stream-replacement", text: replacementReply },
    ]);
    expect(requests.filter((request) => request.scenario === "replacement")).toHaveLength(3);
  });

  it("detects Stop while replacing a divergent preview and suppresses the final", async () => {
    const { acknowledgements, controller, firstAcknowledgement, logger, stream } =
      createLoopbackController("cancel-replacement");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await firstAcknowledgement;
    expect(logger.error).not.toHaveBeenCalled();
    expect(acknowledgements).toEqual([
      { id: "stream-cancel-replacement", text: acknowledgedPrefix },
    ]);

    controller.onPartialReply({ text: replacementReply });
    expect(
      controller.preparePayload({
        text: replacementReply,
        mediaUrl: "https://example.test/must-not-send.png",
      }),
    ).toBeUndefined();
    await expect(controller.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: acknowledgedPrefix,
      messageId: "stream-cancel-replacement",
    });
    expect(stream.canceled).toBe(true);
    expect(acknowledgements).toEqual([
      { id: "stream-cancel-replacement", text: acknowledgedPrefix },
    ]);
    expect(requests.filter((request) => request.scenario === "cancel-replacement")).toHaveLength(2);
  });
});

describe("Teams native final text preparation", () => {
  it("preserves all progress final payloads at the wire boundary", async () => {
    const scenario = "progress-multiple-final";
    const { controller, sendActivity } = createLoopbackController(scenario, {
      streaming: { mode: "progress" },
    });
    const texts = ["First distinct result.\n\n", "# Second distinct result"];
    const prepared = texts.map((text) => controller.preparePayload({ text }));
    const result = await controller.finalize();
    for (const payload of [
      ...prepared,
      result.fallbackPayload,
      ...(result.postNativePayloads ?? []),
    ]) {
      if (payload?.text) {
        await sendActivity({ type: "message", text: payload.text });
      }
    }
    const wire = requests.filter(
      (request) => request.scenario === scenario && request.type === "message",
    );
    const deliveredText = wire
      .filter((request) => request.status >= 200 && request.status < 300)
      .map((request) => request.text)
      .join("\n");
    expect(deliveredText.split("First distinct result.").length - 1).toBe(1);
    expect(deliveredText.split("Second distinct result").length - 1).toBe(1);
  });

  it("preserves required AI metadata when the SDK completes a timed-out stream by update", async () => {
    const { controller, firstAcknowledgement } = createLoopbackController("presentation-timeout");
    const text = "# Status";
    controller.onPartialReply({ text });
    await firstAcknowledgement;
    controller.preparePayload({ text });
    await expect(controller.finalize()).resolves.toMatchObject({ visibleReplySent: true });
    const final = requests.findLast((request) => request.scenario === "presentation-timeout");
    expect(final?.text).toBe("**Status**");
    expect(final?.entities).toEqual(
      expect.arrayContaining([
        {
          type: "https://schema.org/Message",
          "@type": "Message",
          "@context": "https://schema.org",
          "@id": "",
          additionalType: ["AIGeneratedContent"],
        },
      ]),
    );
    expect(
      requests
        .filter((request) => request.scenario === "presentation-timeout")
        .map((request) => request.status),
    ).toEqual([201, 201, 403, 201]);
  });

  it.each(["partial", "progress"] as const)("renders the final %s activity", async (mode) => {
    const scenario = `presentation-${mode}`;
    const text = "# Deployment status\n\n@[Alex](11111111-2222-3333-4444-555555555555)";
    const { controller, firstAcknowledgement } = createLoopbackController(scenario, {
      streaming: { mode },
    });
    if (mode === "partial") {
      controller.onPartialReply({ text });
      await firstAcknowledgement;
    }
    expect(controller.preparePayload({ text })).toBeUndefined();
    const result = await controller.finalize();
    expect(result.visibleReplySent).toBe(true);
    const final = requests.findLast(
      (request) => request.scenario === scenario && request.type === "message",
    );
    expect.soft(final?.text).toBe("**Deployment status**\n\n<at>Alex</at>");
    expect.soft(final?.entities).toEqual(
      expect.arrayContaining([
        {
          type: "mention",
          text: "<at>Alex</at>",
          mentioned: { id: "11111111-2222-3333-4444-555555555555", name: "Alex" },
        },
        {
          type: "https://schema.org/Message",
          "@type": "Message",
          "@context": "https://schema.org",
          "@id": "",
          additionalType: ["AIGeneratedContent"],
        },
      ]),
    );
  });

  it("does not redeliver logical text already acknowledged after final rendering", async () => {
    const text = "# Deployment status\n\n@[Alex](11111111-2222-3333-4444-555555555555)";
    const { controller, firstAcknowledgement } = createLoopbackController(
      "presentation-close-failure",
    );
    controller.onPartialReply({ text });
    await firstAcknowledgement;
    controller.preparePayload({ text });
    await expect(controller.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: "**Deployment status**\n\n<at>Alex</at>",
      logicalContent: text,
      messageId: "stream-presentation-close-failure",
    });
    expect(
      requests
        .filter((request) => request.scenario === "presentation-close-failure")
        .map((request) => request.status),
    ).toEqual([201, 201, 403]);
  });

  it("retains the acknowledged preview when final rendering discovers Stop", async () => {
    const text = "# Deployment status";
    const { controller, firstAcknowledgement } = createLoopbackController("presentation-cancel");
    controller.onPartialReply({ text });
    await firstAcknowledgement;
    controller.preparePayload({ text });
    await expect(controller.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: text,
      messageId: "stream-presentation-cancel",
    });
    expect(
      requests
        .filter((request) => request.scenario === "presentation-cancel")
        .map((request) => request.status),
    ).toEqual([201, 403]);
  });
});
