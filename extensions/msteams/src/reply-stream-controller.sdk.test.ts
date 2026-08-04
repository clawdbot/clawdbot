import { createServer, request as requestHttp } from "node:http";
import { HttpStream } from "@microsoft/teams.apps/dist/http/http-stream.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

type TeamsLoopbackRequest = {
  scenario: string;
  type: string;
  text: string;
  status: number;
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
    };
    const scenario = request.url?.slice(1) ?? "";
    const priorScenarioRequests = requests.filter((entry) => entry.scenario === scenario).length;
    const rejected =
      scenario === "no-ack" ||
      (scenario === "cancel-replacement" && priorScenarioRequests > 0) ||
      (activity.text?.length ?? 0) > 4_000;
    const status = rejected ? 403 : 201;
    requests.push({
      scenario,
      type: activity.type ?? "",
      text: activity.text ?? "",
      status,
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        rejected
          ? {
              error: {
                message: scenario.startsWith("cancel")
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

function createLoopbackController(scenario: string) {
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
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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
  });
  const controller = createTeamsReplyStreamController({
    allowProviderPreview: true,
    conversationType: "personal",
    context: { activity: { type: "message" }, stream } as never,
    feedbackLoopEnabled: false,
  });
  return { acknowledgements, controller, logger, stream };
}

describe("Microsoft Teams SDK acknowledged stream fallback", () => {
  it("redelivers only text not acknowledged by the real Teams SDK and HTTP provider", async () => {
    const { acknowledgements, controller, logger } = createLoopbackController("size-limit");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await vi.waitFor(() => {
      expect(logger.error).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([{ id: "stream-size-limit", text: acknowledgedPrefix }]);
    });

    controller.onPartialReply({ text: completeReply });
    await vi.waitFor(() => {
      expect(
        requests.filter(
          (request) =>
            request.scenario === "size-limit" &&
            request.type === "typing" &&
            request.status === 403,
        ),
      ).toHaveLength(1);
    });
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
    const { acknowledgements, controller, logger } = createLoopbackController("no-ack");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalled();
      expect(requests.filter((request) => request.scenario === "no-ack")).toHaveLength(1);
    });

    expect(acknowledgements).toEqual([]);
    expect(requests.find((request) => request.scenario === "no-ack")?.status).toBe(403);
  });

  it("honors a real Teams HTTP cancellation without redelivering the remaining text", async () => {
    const { acknowledgements, controller, logger, stream } = createLoopbackController("cancel");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await vi.waitFor(() => {
      expect(logger.error).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([{ id: "stream-cancel", text: acknowledgedPrefix }]);
    });
    controller.onPartialReply({ text: completeReply });
    await vi.waitFor(() => {
      expect(stream.canceled).toBe(true);
    });

    expect(controller.preparePayload({ text: completeReply })).toBeUndefined();
    await expect(controller.finalize()).resolves.toEqual({
      visibleReplySent: true,
      content: acknowledgedPrefix,
      messageId: "stream-cancel",
    });
    expect(requests.filter((request) => request.scenario === "cancel")).toHaveLength(2);
  });

  it("replaces a divergent preview through the same real Teams stream", async () => {
    const { acknowledgements, controller, logger } = createLoopbackController("replacement");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await vi.waitFor(() => {
      expect(logger.error).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([{ id: "stream-replacement", text: acknowledgedPrefix }]);
    });

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
    const { acknowledgements, controller, logger, stream } =
      createLoopbackController("cancel-replacement");

    controller.onPartialReply({ text: acknowledgedPrefix });
    await vi.waitFor(() => {
      expect(logger.error).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([
        { id: "stream-cancel-replacement", text: acknowledgedPrefix },
      ]);
    });

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
