import fs from "node:fs/promises";
import path from "node:path";
import {
  detectAndLoadAgentHarnessPromptImages,
  queueAgentHarnessMessage,
  resolveActiveEmbeddedRunSessionId,
  runAgentHarnessGatewayQuestion,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { CodexUserInput } from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  bindProductionHarnessHostCapabilitiesForTest,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

type QueueOptions = NonNullable<Parameters<typeof queueAgentHarnessMessage>[2]>;
type Recorder = NonNullable<QueueOptions["userTurnTranscriptRecorder"]>;
type UserMessage = NonNullable<Recorder["message"]>;
type Scenario = "offloaded" | "mixed" | "message" | "resolved";
type SteerRequest = {
  threadId: string;
  expectedTurnId: string;
  clientUserMessageId: string;
  input: CodexUserInput[];
};

setupRunAttemptTestHooks();

async function createMediaFixture(scenario: Scenario) {
  const root = await fs.realpath(tempDir);
  const params = createParams(path.join(root, "session.jsonl"), path.join(root, "workspace"));
  params.modelId = "gpt-5.6-luna";
  params.model = {
    ...params.model,
    id: params.modelId,
    name: params.modelId,
    input: ["text", "image"],
  };
  params.toolAuthorityFingerprint = "steering-media-authority";
  await fs.mkdir(params.workspaceDir, { recursive: true });
  const blueBytes = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
  const greenBytes = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
  const redBytes = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
  const blue = { path: path.join(params.workspaceDir, "blue.png"), contentType: "image/png" };
  const green = { path: path.join(params.workspaceDir, "green.png"), contentType: "image/png" };
  const document = {
    path: path.join(params.workspaceDir, "document.png"),
    kind: "document" as const,
  };
  const described = {
    path: path.join(params.workspaceDir, "described.png"),
    contentType: "image/png",
  };
  await Promise.all([
    fs.writeFile(blue.path, blueBytes),
    fs.writeFile(green.path, greenBytes),
    fs.writeFile(document.path, redBytes),
    fs.writeFile(described.path, redBytes),
  ]);
  const inline = {
    type: "image" as const,
    data: redBytes.toString("base64"),
    mimeType: "image/png",
  };
  const mixed = scenario !== "offloaded";
  const canonical = scenario === "message" || scenario === "resolved";
  const media: NonNullable<QueueOptions["media"]> = canonical
    ? [document, described, blue, { kind: "image" }, green]
    : mixed
      ? [blue, { kind: "image" }, green]
      : [blue, green];
  const message: UserMessage & { content: string } = {
    role: "user",
    content: "compare these attachments",
    timestamp: 1_750_000_000_000,
    __openclaw: {
      media,
      ...(canonical
        ? {
            mediaImageLayout: {
              slots: [
                { kind: "offloaded", factIndex: 2 },
                { kind: "inline", factIndex: 3 },
                { kind: "offloaded", factIndex: 4 },
              ],
              suppressedFactIndexes: [1],
            },
          }
        : {}),
    },
  };
  const target = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey!,
    storePath: path.join(root, "sessions.sqlite"),
  };
  params.sessionTarget = target;
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: params.sessionId, sessionFile: params.sessionFile, updatedAt: Date.now() },
  });
  let persisted = false;
  const recorder = {
    message:
      scenario === "resolved"
        ? { ...message, __openclaw: { media: [green, { kind: "image" }, blue] } }
        : message,
    resolveMessage: vi.fn(async (): Promise<UserMessage> => message),
    getAdmissionReceipt: () => undefined,
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(),
    markBlocked: vi.fn(),
    hasPersisted: () => persisted,
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistApproved: vi.fn(async () => {
      if (!persisted) {
        const result = await appendSessionTranscriptMessageByIdentity({
          ...target,
          message,
          cwd: params.workspaceDir,
        });
        persisted = Boolean(result);
      }
      return undefined;
    }),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
  } satisfies Recorder;
  const options: QueueOptions = {
    debounceMs: 0,
    isInboundUserMessage: true,
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    waitForTranscriptCommit: true,
    images: mixed ? [inline] : [],
    // Deliberately disagree with the recorder's canonical facts and layout.
    media: canonical ? [green, { kind: "image" }, blue] : media,
    imageOrder: canonical
      ? ["inline", "offloaded", "offloaded"]
      : mixed
        ? ["offloaded", "inline", "offloaded"]
        : ["offloaded", "offloaded"],
    ...(canonical ? { userTurnTranscriptRecorder: recorder } : {}),
  };
  const expectedImages = [
    { type: "image", url: `data:image/png;base64,${blueBytes.toString("base64")}` },
    ...(mixed ? [{ type: "image", url: `data:image/png;base64,${inline.data}` }] : []),
    { type: "image", url: `data:image/png;base64,${greenBytes.toString("base64")}` },
  ];
  const readSteeredMessages = async () =>
    (await readVisibleSessionTranscriptMessageEntries(target))
      .map((entry) => entry.message)
      .filter((entry) => entry.role === "user" && entry.timestamp === message.timestamp);
  return { params, options, message, recorder, expectedImages, readSteeredMessages };
}

type MediaFixture = Awaited<ReturnType<typeof createMediaFixture>>;
type StartedHarness = ReturnType<typeof createStartedThreadHarness>;

async function withActiveMediaTurn(
  fixture: MediaFixture,
  harness: StartedHarness,
  exercise: (controller: AbortController) => Promise<void>,
) {
  // Drive media/closure ordering without charging filesystem setup to the run budget.
  vi.useFakeTimers();
  const controller = new AbortController();
  const started = createDeferred<void>();
  const run = runCodexAppServerAttempt({
    ...fixture.params,
    abortSignal: controller.signal,
    onAgentEvent: (event) => {
      if (event.stream === "lifecycle" && event.data.phase === "start") {
        started.resolve();
      }
      return fixture.params.onAgentEvent?.(event);
    },
  });
  try {
    // Polling waitFor advances fake time while cold runtime preparation is still loading.
    await started.promise;
    expect(harness.requests.some((entry) => entry.method === "turn/start")).toBe(true);
    expect(resolveActiveEmbeddedRunSessionId(fixture.params.sessionKey!)).toBe(
      fixture.params.sessionId,
    );
    await exercise(controller);
  } finally {
    // Assertions may fail while a steer awaits consumption; always retire its owner.
    controller.abort();
    await run;
  }
}

async function notifyConsumed(harness: StartedHarness, clientId: string, turnId = "turn-1") {
  await harness.notify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId,
      item: { id: `user-${clientId}`, type: "userMessage", clientId },
    },
  });
}

describe("Codex active-run steering media", () => {
  it("keeps consumed question answers accepted when their host closes during the response", async () => {
    const fixture = await createMediaFixture("offloaded");
    const onAttemptTimeout = vi.fn();
    fixture.params.onAttemptTimeout = onAttemptTimeout;
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(fixture.params);
    const harness = createStartedThreadHarness();
    await withActiveMediaTurn(fixture, harness, async (controller) => {
      const result = { status: "answered" as const, answers: { answers: { choice: ["yes"] } } };
      const answer = createDeferred<typeof result>();
      const onBlockReply = vi.fn();
      const questionId = "ask_0123456789abcdef0123456789abcdef";
      const gatewayCall = vi.fn(async (method: string) => {
        if (method === "question.request") {
          return { id: questionId };
        }
        if (method === "question.waitAnswer") {
          return await answer.promise;
        }
        if (method === "question.resolve") {
          answer.resolve(result);
          closeHost();
          return {};
        }
        throw new Error(`unexpected question method: ${method}`);
      });
      const question = runAgentHarnessGatewayQuestion({
        questionId,
        questions: [{ id: "choice", header: "Choice", question: "Continue?", options: [] }],
        sessionKey: fixture.params.sessionKey!,
        timeoutMs: 60_000,
        gatewayCall,
        delivery: { onBlockReply },
        signal: controller.signal,
      });
      try {
        await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledOnce(), fastWait);
        expect(onAttemptTimeout).not.toHaveBeenCalled();
        const accepted = vi.fn();
        expect(
          queueAgentHarnessMessage(fixture.params.sessionId, "yes", {
            debounceMs: 0,
            isInboundUserMessage: true,
            toolAuthorityFingerprint: fixture.params.toolAuthorityFingerprint,
            onQueueAccepted: accepted,
          }),
        ).toBe(true);
        await expect(question).resolves.toEqual(result);
        await vi.waitFor(() => expect(accepted).toHaveBeenCalledExactlyOnceWith(true), fastWait);
        expect(onAttemptTimeout).not.toHaveBeenCalled();
        expect(harness.requests.filter((entry) => entry.method === "turn/steer")).toEqual([]);
      } finally {
        closeHost();
        answer.resolve(result);
        await question;
      }
    });
  });

  it.each(["missing", "outside-workspace"] as const)(
    "rejects a %s structured image before dispatch or persistence",
    async (failure) => {
      const fixture = await createMediaFixture("offloaded");
      fixture.params.config = { ...fixture.params.config, tools: { fs: { workspaceOnly: true } } };
      const imagePath = path.join(
        failure === "missing" ? fixture.params.workspaceDir : await fs.realpath(tempDir),
        "unavailable.png",
      );
      if (failure === "outside-workspace") {
        await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 }));
      }
      fixture.options.media = [{ path: imagePath, contentType: "image/png" }];
      fixture.options.imageOrder = ["offloaded"];
      fixture.message["__openclaw"] = { media: fixture.options.media };
      fixture.options.userTurnTranscriptRecorder = fixture.recorder;
      const harness = createStartedThreadHarness();
      await withActiveMediaTurn(fixture, harness, async () => {
        const accepted = vi.fn();
        expect(
          queueAgentHarnessMessage(fixture.params.sessionId, "inspect this", {
            ...fixture.options,
            onQueueAccepted: accepted,
          }),
        ).toBe(true);
        await vi.waitFor(() => expect(accepted).toHaveBeenCalledExactlyOnceWith(false), fastWait);
        expect(harness.requests.filter((entry) => entry.method === "turn/steer")).toEqual([]);
        expect(fixture.recorder.persistApproved).not.toHaveBeenCalled();
        expect(await fixture.readSteeredMessages()).toEqual([]);
      });
    },
  );

  it("rejects hydrated media after its captured host authority closes", async () => {
    const fixture = await createMediaFixture("resolved");
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(fixture.params);
    const prepared = createDeferred<UserMessage>();
    fixture.recorder.resolveMessage.mockImplementation(() => prepared.promise);
    const harness = createStartedThreadHarness();
    await withActiveMediaTurn(fixture, harness, async () => {
      const accepted = vi.fn();
      try {
        expect(
          queueAgentHarnessMessage(fixture.params.sessionId, "delayed image", {
            ...fixture.options,
            onQueueAccepted: accepted,
          }),
        ).toBe(true);
        await vi.waitFor(
          () => expect(fixture.recorder.resolveMessage).toHaveBeenCalledOnce(),
          fastWait,
        );
        expect(accepted).not.toHaveBeenCalled();
        closeHost();
        prepared.resolve(fixture.message);
        // Host closure does not settle the queue itself: rejection here comes
        // from the authority check after the real hydrator returns.
        await vi.waitFor(() => expect(accepted).toHaveBeenCalledExactlyOnceWith(false), fastWait);
        expect(harness.requests.filter((entry) => entry.method === "turn/steer")).toEqual([]);
        expect(fixture.recorder.persistApproved).not.toHaveBeenCalled();
        expect(await fixture.readSteeredMessages()).toEqual([]);
      } finally {
        closeHost();
        prepared.resolve(fixture.message);
      }
    });
  });

  it.each(["offloaded", "fact-summary", "layout-summary"] as const)(
    "honors a text-only active model for %s input",
    async (kind) => {
      const fixture = await createMediaFixture("offloaded");
      fixture.params.modelId = "test-text-only";
      fixture.params.model = {
        ...fixture.params.model,
        id: fixture.params.modelId,
        name: fixture.params.modelId,
        input: ["text"],
      };
      const canSteer = kind !== "offloaded";
      fixture.options.userTurnTranscriptRecorder = fixture.recorder;
      if (canSteer) {
        fixture.message.content = "description already present";
        fixture.options.imageOrder = undefined;
        if (kind === "fact-summary") {
          fixture.options.media = fixture.options.media?.map((fact) => ({
            ...fact,
            hydrationSuppressed: true,
          }));
          fixture.message["__openclaw"] = { media: fixture.options.media };
        } else {
          fixture.message["__openclaw"] = {
            media: fixture.options.media,
            mediaImageLayout: { slots: [], suppressedFactIndexes: [0, 1] },
          };
          fixture.options.media = undefined;
        }
      }
      const harness = createStartedThreadHarness();
      await withActiveMediaTurn(fixture, harness, async () => {
        const accepted = vi.fn();
        expect(
          queueAgentHarnessMessage(fixture.params.sessionId, fixture.message.content, {
            ...fixture.options,
            onQueueAccepted: accepted,
          }),
        ).toBe(canSteer);
        if (!canSteer) {
          expect(accepted).not.toHaveBeenCalled();
          expect(harness.requests.filter((entry) => entry.method === "turn/steer")).toEqual([]);
          expect(fixture.recorder.persistApproved).not.toHaveBeenCalled();
          expect(await fixture.readSteeredMessages()).toEqual([]);
          return;
        }
        await vi.waitFor(() => expect(accepted).toHaveBeenCalledExactlyOnceWith(true), fastWait);
        const steer = harness.requests.find((entry) => entry.method === "turn/steer")
          ?.params as SteerRequest;
        expect(steer.input).toEqual([
          { type: "text", text: fixture.message.content, text_elements: [] },
        ]);
        expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
        expect(await fixture.readSteeredMessages()).toEqual([fixture.message]);
        await notifyConsumed(harness, steer.clientUserMessageId);
        expect(await fixture.readSteeredMessages()).toEqual([fixture.message]);
      });
    },
  );

  it("keeps later text behind the reserved image preparation slot", async () => {
    const fixture = await createMediaFixture("resolved");
    const prepared = createDeferred<UserMessage>();
    fixture.recorder.resolveMessage.mockImplementation(() => prepared.promise);
    const harness = createStartedThreadHarness();
    await withActiveMediaTurn(fixture, harness, async () => {
      const firstAccepted = vi.fn();
      const secondAccepted = vi.fn();
      try {
        expect(
          queueAgentHarnessMessage(fixture.params.sessionId, "first image", {
            ...fixture.options,
            onQueueAccepted: firstAccepted,
          }),
        ).toBe(true);
        await vi.waitFor(
          () => expect(fixture.recorder.resolveMessage).toHaveBeenCalledOnce(),
          fastWait,
        );
        expect(
          queueAgentHarnessMessage(fixture.params.sessionId, "later text", {
            debounceMs: 0,
            onQueueAccepted: secondAccepted,
          }),
        ).toBe(true);
        expect(harness.requests.filter((entry) => entry.method === "turn/steer")).toEqual([]);
        prepared.resolve(fixture.message);
        await vi.waitFor(
          () => expect(secondAccepted).toHaveBeenCalledExactlyOnceWith(true),
          fastWait,
        );
        expect(firstAccepted).toHaveBeenCalledExactlyOnceWith(true);
        const steers = harness.requests
          .filter((entry) => entry.method === "turn/steer")
          .map((entry) => entry.params as SteerRequest);
        expect(steers.map((entry) => entry.input)).toEqual([
          [{ type: "text", text: "first image", text_elements: [] }, ...fixture.expectedImages],
          [{ type: "text", text: "later text", text_elements: [] }],
        ]);
        expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
        for (const steer of steers) {
          await notifyConsumed(harness, steer.clientUserMessageId);
        }
        expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
      } finally {
        prepared.resolve(fixture.message);
      }
    });
  });

  it.each([
    { scenario: "offloaded", name: "offloaded-only ingress images" },
    { scenario: "mixed", name: "mixed offloaded/inline ingress order" },
    { scenario: "message", name: "recorder.message facts and layout over ingress hints" },
    { scenario: "resolved", name: "recorder.resolveMessage facts and layout over stale metadata" },
  ] as const)("persists source custody before delivering $name", async ({ scenario }) => {
    const fixture = await createMediaFixture(scenario);
    const harness = createStartedThreadHarness();
    await withActiveMediaTurn(fixture, harness, async () => {
      const accepted = vi.fn();
      expect(
        queueAgentHarnessMessage(fixture.params.sessionId, fixture.message.content as string, {
          ...fixture.options,
          onQueueAccepted: accepted,
        }),
      ).toBe(true);
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledExactlyOnceWith(true), fastWait);
      const steer = harness.requests.find((entry) => entry.method === "turn/steer")
        ?.params as SteerRequest;
      expect(steer).toMatchObject({
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        clientUserMessageId: expect.any(String),
      });
      const clientId = steer.clientUserMessageId;
      const expectedMessages = fixture.options.userTurnTranscriptRecorder ? [fixture.message] : [];
      expect(fixture.recorder.persistApproved).toHaveBeenCalledTimes(expectedMessages.length);
      expect(await fixture.readSteeredMessages()).toEqual(expectedMessages);
      await notifyConsumed(harness, "unrelated-client");
      await notifyConsumed(harness, clientId, "other-turn");
      expect(fixture.recorder.persistApproved).toHaveBeenCalledTimes(expectedMessages.length);
      expect(await fixture.readSteeredMessages()).toEqual(expectedMessages);
      await notifyConsumed(harness, clientId);
      await notifyConsumed(harness, clientId);
      if (fixture.options.userTurnTranscriptRecorder) {
        expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
        expect(await fixture.readSteeredMessages()).toEqual([fixture.message]);
      }
      // Keep the intended red assertion after acceptance and consumption ownership checks.
      expect(steer.input).toEqual([
        { type: "text", text: fixture.message.content, text_elements: [] },
        ...fixture.expectedImages,
      ]);
    });
  });

  it("leaves rejected steering intact for a caller-owned fallback consumer", async () => {
    const fixture = await createMediaFixture("mixed");
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/steer") {
        throw new Error("no active turn to steer");
      }
    });
    await withActiveMediaTurn(fixture, harness, async () => {
      const originalText = "  preserve this caption\n";
      const originalOptions = { ...fixture.options, userTurnTranscriptRecorder: fixture.recorder };
      const expectedPayload = {
        text: originalText,
        images: structuredClone(originalOptions.images),
        imageOrder: structuredClone(originalOptions.imageOrder),
        media: structuredClone(originalOptions.media),
      };
      // The SDK exposes eligibility plus acceptance, not the Gateway fallback dispatcher.
      // Consume the actual retained inputs after rejection; do not compare an object to itself.
      const fallback = vi.fn(async (text: string, options: QueueOptions) => ({
        payload: structuredClone({
          text,
          images: options.images,
          imageOrder: options.imageOrder,
          media: options.media,
        }),
        recorder: options.userTurnTranscriptRecorder,
        hydrated: await detectAndLoadAgentHarnessPromptImages({
          prompt: text,
          existingImages: options.images,
          imageOrder: options.imageOrder,
          media: options.media,
          workspaceDir: fixture.params.workspaceDir,
          model: fixture.params.model,
          workspaceOnly: true,
        }),
      }));
      let fallbackResult: ReturnType<typeof fallback> | undefined;
      const accepted = vi.fn((value: boolean) => {
        if (!value) {
          fallbackResult = fallback(originalText, originalOptions);
        }
      });
      expect(
        queueAgentHarnessMessage(fixture.params.sessionId, originalText, {
          ...originalOptions,
          onQueueAccepted: accepted,
        }),
      ).toBe(true);
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledExactlyOnceWith(false), fastWait);
      const result = await fallbackResult;
      expect(result?.payload).toEqual(expectedPayload);
      expect(result?.recorder).toBe(fixture.recorder);
      expect(
        result?.hydrated.images.map((image) => ({
          type: image.type,
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ).toEqual(fixture.expectedImages);
      expect(result?.hydrated.loadedCount).toBe(2);
      expect(fallback).toHaveBeenCalledOnce();
      const steer = harness.requests.find((entry) => entry.method === "turn/steer")
        ?.params as SteerRequest;
      await notifyConsumed(harness, steer.clientUserMessageId);
      expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
      expect(await fixture.readSteeredMessages()).toEqual([fixture.message]);
      await result?.recorder?.persistApproved();
      expect(await fixture.readSteeredMessages()).toEqual([fixture.message]);
    });
  });

  it("does not consume an offloaded image caption as a pending text-only answer", async () => {
    const fixture = await createMediaFixture("offloaded");
    fixture.params.onBlockReply = vi.fn();
    const harness = createStartedThreadHarness();
    await withActiveMediaTurn(fixture, harness, async () => {
      const response = harness.handleServerRequest({
        id: "request-image-answer",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "ask-image-answer",
          isBlocking: true,
          questions: [
            {
              id: "answer",
              header: "Answer",
              question: "Enter an answer",
              isSecret: true,
              isOther: false,
              options: null,
            },
          ],
        },
      });
      await vi.waitFor(() => expect(fixture.params.onBlockReply).toHaveBeenCalledOnce(), fastWait);
      const accepted = vi.fn();
      expect(
        queueAgentHarnessMessage(fixture.params.sessionId, "image caption", {
          ...fixture.options,
          onQueueAccepted: accepted,
        }),
      ).toBe(true);
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledExactlyOnceWith(true), fastWait);
      await expect(response).resolves.toEqual({ answers: {} });
      const steer = harness.requests.find((entry) => entry.method === "turn/steer")
        ?.params as SteerRequest;
      expect(steer?.input).toEqual([
        { type: "text", text: "image caption", text_elements: [] },
        ...fixture.expectedImages,
      ]);
      await notifyConsumed(harness, steer.clientUserMessageId);
    });
  });
});
