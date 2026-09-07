/* @vitest-environment jsdom */

import { Buffer } from "node:buffer";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createChatSubmissions } from "../../../app/chat-submissions.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "../attachment-payload-store.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { admitChatSubmission, reduceChatSessionProjection } from "../history-merge.ts";
import { buildInitialChatSubmission, buildLocalUserMessage } from "../user-message-content.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

const ownedAttachments: ChatAttachment[] = [];
const previewBlobs = new Map<string, Blob>();

function expectSameImageNodes(actual: HTMLImageElement[], expected: HTMLImageElement[]) {
  expect(actual).toHaveLength(expected.length);
  for (const [index, image] of expected.entries()) {
    expect(actual[index]).toBe(image);
  }
}

function mediaMetadataResponse(
  available = true,
  mediaTicket?: string,
  retryable = false,
): Response {
  return Response.json({
    available,
    reason: available ? undefined : "Attachment removed",
    retryable,
    ...(mediaTicket
      ? { mediaTicket, mediaTicketExpiresAt: new Date(Date.now() + 31_000).toISOString() }
      : {}),
  });
}

function unreadableMetadataResponse(status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("Connection closed while reading metadata"));
      },
    }),
    { status },
  );
}

function mountTranscriptPane(props: Parameters<typeof renderChatThread>[0]) {
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  let root!: ReturnType<typeof render>;
  const renderPane = () => {
    root = render(
      renderChatThread({ ...props, onRequestUpdate: renderPane }, transcript),
      container,
    );
    transcript.hostUpdated();
  };
  onTestFinished(() => {
    render(null, container);
    releaseChatMediaResourceSubscriber(renderPane);
    transcript.hostDisconnected();
  });
  renderPane();
  transcript.hostConnected();
  return { container, renderPane, root: () => root };
}

async function createCanonicalImageTranscript(
  factIndexes = [0],
  inlineUrls = ["data:image/png;base64,aW5saW5l"],
  origin: "canonical" | "queued" | "submitted" | "initial receipt" = "canonical",
) {
  const requests: Array<{ resolve: (response: Response) => void; signal?: AbortSignal | null }> =
    [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_source: string, init?: RequestInit) => {
      return new Promise<Response>((resolve) => {
        requests.push({ resolve, signal: init?.signal });
      });
    }),
  );
  const canonical = {
    id: crypto.randomUUID(),
    seq: 1,
    idempotencyKey: "canonical-image-send:user",
    mediaImageLayout: { slots: factIndexes.map((factIndex) => ({ kind: "inline", factIndex })) },
  };
  const input = {
    text: "Cached text",
    createdAt: 1_000,
    runId: "canonical-image-send",
    attachments: inlineUrls.map((dataUrl) => ({
      id: crypto.randomUUID(),
      mimeType: "image/png",
      dataUrl,
    })),
  };
  ownedAttachments.push(...input.attachments);
  const local = expectDefined(buildLocalUserMessage(input), "submitted image message");
  const cached = origin === "canonical" ? { ...local, __openclaw: canonical } : local;
  const owner = {
    sessionKey: "agent:main:main",
    client: {},
    chatSubmissions: createChatSubmissions(),
    chatMessages: [] as unknown[],
  };
  if (origin === "initial receipt") {
    owner.chatSubmissions.retain(
      buildInitialChatSubmission(owner.sessionKey, input, owner.client, input.runId),
    );
    admitChatSubmission(owner);
  } else if (origin === "submitted") {
    reduceChatSessionProjection(owner, { type: "sendPending", runId: input.runId, message: local });
  }
  const media = Array.from({ length: Math.max(...factIndexes) + 1 }, (_, index) =>
    factIndexes.includes(index)
      ? { path: `media://inbound/${crypto.randomUUID()}.png`, contentType: "image/png" }
      : null,
  );
  const props = {
    ...threadProps(
      `pane-${crypto.randomUUID()}`,
      owner.sessionKey,
      origin === "canonical" ? [cached] : owner.chatMessages,
    ),
    assistantAttachmentAuthToken: "test-auth-token",
    connectionEpoch: 1,
  };
  if (origin === "queued") {
    props.queue = [
      { ...input, id: input.runId, sendRunId: input.runId, sendState: "sending", sendAttempts: 1 },
    ];
  }
  const { container, renderPane, root } = mountTranscriptPane(props);
  const images = () => [...container.querySelectorAll<HTMLImageElement>(".chat-message-image")];
  const displayed = images();
  expect(displayed).toHaveLength(inlineUrls.length);
  const previewUrls = displayed.map((image) =>
    expectDefined(image.getAttribute("src"), "displayed preview URL"),
  );
  const previewBytes = await Promise.all(
    previewUrls.map(async (url) =>
      url.startsWith("data:")
        ? Buffer.from(url.split(",")[1]!, "base64")
        : Buffer.from(
            await expectDefined(previewBlobs.get(url), "owned preview Blob").arrayBuffer(),
          ),
    ),
  );
  expect(previewBytes).toEqual(inlineUrls.map((url) => Buffer.from(url.split(",")[1]!, "base64")));
  if (origin === "initial receipt") {
    expect(previewUrls).toEqual(inlineUrls);
  } else {
    expect(new Set(previewUrls).size).toBe(previewUrls.length);
  }
  for (const image of displayed) {
    // jsdom has no decoder; deliver the browser's successful load boundary.
    Object.defineProperty(image, "naturalWidth", { value: 1 });
    image.dispatchEvent(new Event("load"));
  }
  const publish = (
    metadata: Record<string, unknown> = {},
    nextMedia = media,
    text = "Fresh authoritative text",
    content: unknown[] = [],
  ) => {
    const messages = [
      {
        ...cached,
        content: [{ type: "text", text }, ...content],
        __openclaw: { ...canonical, media: nextMedia, ...metadata },
      },
    ];
    if (origin === "canonical") {
      props.messages = messages;
    } else {
      reduceChatSessionProjection(
        owner,
        { type: "snapshotLoaded", messages },
        { runActive: false },
      );
      props.messages = owner.chatMessages;
    }
    renderPane();
  };
  return {
    container,
    props,
    displayed,
    previewUrls,
    media,
    requests,
    images,
    publish,
    renderPane,
    root,
  };
}

describe("canonical image presentation handoff", () => {
  beforeEach(() => {
    installTranscriptDomMocks();
    // jsdom has no native Blob URL store; retain its actual Blob for byte checks.
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      if (!(blob instanceof Blob)) {
        throw new Error("Attachment preview must allocate a Blob URL");
      }
      const url = `blob:${crypto.randomUUID()}`;
      previewBlobs.set(url, blob);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      expect(previewBlobs.delete(url)).toBe(true);
    });
  });
  afterEach(() => {
    try {
      releaseChatAttachmentPayloads(ownedAttachments);
      expect(previewBlobs.size).toBe(0);
    } finally {
      ownedAttachments.length = 0;
      previewBlobs.clear();
      resetTranscriptTestDom();
    }
  });

  it.each(["canonical", "submitted", "initial receipt"] as const)(
    "keeps the displayed %s image while fresh history text and media metadata arrive",
    async (origin) => {
      const fixture = await createCanonicalImageTranscript(undefined, undefined, origin);
      const displayed = expectDefined(fixture.displayed[0], "displayed inline image");
      if (origin === "initial receipt") {
        fixture.publish();
        expectSameImageNodes(fixture.images(), [displayed]);
      }
      fixture.publish();

      expect(fixture.container.textContent).toContain("Fresh authoritative text");
      expect(fixture.container.textContent).not.toContain("Cached text");
      expectSameImageNodes(fixture.images(), [displayed]);
      expect(displayed.getAttribute("src")).toBe(fixture.previewUrls[0]);

      fixture.requests[0]?.resolve(mediaMetadataResponse());
      await flushDeferredRowPrune();
      expectSameImageNodes(fixture.images(), [displayed]);
      expect(displayed.getAttribute("src")).toContain(
        encodeURIComponent(expectDefined(fixture.media[0], "canonical media fact").path),
      );
      fixture.renderPane();
      expectSameImageNodes(fixture.images(), [displayed]);
      displayed.dispatchEvent(new Event("load"));
      expectSameImageNodes(fixture.images(), [displayed]);
    },
  );

  it.each(["inline", "metadata", "loaded"] as const)(
    "keeps the displayed %s upload when the session workspace arrives",
    async (stage) => {
      const fixture = await createCanonicalImageTranscript(undefined, undefined, "initial receipt");
      if (stage !== "inline") {
        fixture.publish();
      }
      if (stage === "loaded") {
        fixture.requests[0]?.resolve(mediaMetadataResponse(true, "before-workspace"));
        await flushDeferredRowPrune();
        fixture.displayed[0]?.dispatchEvent(new Event("load"));
      }

      fixture.props.selectedSession = {
        key: fixture.props.sessionKey,
        kind: "direct",
        permissionMode: "workspace",
        sessionRoot: "/worktrees/image-upload",
        spawnedCwd: "/worktrees/image-upload",
      };
      fixture.renderPane();
      expectSameImageNodes(fixture.images(), fixture.displayed);
      expect(fixture.container.querySelector('[aria-busy="true"]')).toBeNull();

      if (stage === "inline") {
        fixture.publish();
        expectSameImageNodes(fixture.images(), fixture.displayed);
      } else {
        expect(fixture.requests).toHaveLength(2);
      }
      // The retained pixels do not suppress the new policy's access check.
      fixture.requests.at(-1)?.resolve(mediaMetadataResponse(false));
      await flushDeferredRowPrune();
      expect(fixture.images()).toHaveLength(0);
      expect(fixture.container.textContent).toContain("Attachment removed");
    },
  );

  it.each([
    {
      name: "different canonical ID with identical text and send key",
      metadata: { id: "different-native-id" },
    },
    { name: "different canonical sequence", metadata: { seq: 2 } },
    { name: "missing persisted ID", metadata: { id: undefined } },
    { name: "imported message identity", metadata: { importedFrom: "external" } },
    {
      name: "imported message replacing a queued send",
      metadata: {
        importedFrom: "external",
        cliSessionId: "imported-session",
        externalId: "imported-image",
      },
      origin: "queued" as const,
    },
    { name: "pending message identity", metadata: { id: "pending:input" } },
    { name: "missing layout", metadata: { mediaImageLayout: undefined } },
    {
      name: "ambiguous duplicate slots",
      metadata: {
        mediaImageLayout: {
          slots: [
            { kind: "inline", factIndex: 0 },
            { kind: "inline", factIndex: 0 },
          ],
        },
      },
    },
  ])("does not borrow an inline preview for $name", async ({ metadata, origin }) => {
    const fixture = await createCanonicalImageTranscript(undefined, undefined, origin);
    fixture.publish(metadata, fixture.media, "Cached text");
    expect(fixture.images()).toHaveLength(0);
    expect(fixture.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it.each([
    { name: "missing inline block", factIndexes: [0, 2] },
    { name: "duplicate fact index", factIndexes: [0, 0] },
  ])("does not guess cached correspondence with $name", async ({ factIndexes }) => {
    const fixture = await createCanonicalImageTranscript(factIndexes);
    fixture.publish();
    expect(fixture.images()).toHaveLength(0);
  });

  it("does not lend a displayed inline image to another pane of the same canonical message", async () => {
    const fixture = await createCanonicalImageTranscript();
    fixture.publish();
    const { container } = mountTranscriptPane({ ...fixture.props, paneId: "other-image-pane" });
    expectSameImageNodes(fixture.images(), fixture.displayed);
    expect(container.querySelector(".chat-message-image")).toBeNull();
    expect(fixture.requests).toHaveLength(1);
  });

  it.each(["complete", "partial"] as const)(
    "handles a %s receipt for duplicate submitted attachments",
    async (receipt) => {
      const fixture = await createCanonicalImageTranscript(
        [0, 1, 2],
        ["data:image/png;base64,YQ==", "data:image/png;base64,YQ==", "data:image/png;base64,Yg=="],
        "submitted",
      );
      fixture.media[1] = fixture.media[0] ?? null;
      const media = receipt === "partial" ? fixture.media.slice(0, 2) : fixture.media;
      fixture.publish(
        {
          mediaImageLayout: { slots: media.map((_, factIndex) => ({ kind: "inline", factIndex })) },
        },
        media,
      );
      expectSameImageNodes(fixture.images(), receipt === "complete" ? fixture.displayed : []);
    },
  );

  it("binds local previews by fact position when inline blocks reorder mixed image receipts", async () => {
    const fixture = await createCanonicalImageTranscript(
      [0, 1],
      ["data:image/png;base64,aW1hZ2VB", "data:image/png;base64,aW1hZ2VC"],
      "queued",
    );
    fixture.publish(
      {
        mediaImageLayout: {
          slots: [
            { kind: "offloaded", factIndex: 0 },
            { kind: "inline", factIndex: 1 },
          ],
        },
      },
      fixture.media,
      "Fresh authoritative text",
      [{ type: "image", url: expectDefined(fixture.media[1], "inline image fact").path }],
    );

    expectSameImageNodes(fixture.images(), fixture.displayed.toReversed());
    expect(fixture.images().map((image) => image.getAttribute("src"))).toEqual(
      fixture.previewUrls.toReversed(),
    );
  });

  it("adopts submitted images across interleaved non-image fact slots", async () => {
    const fixture = await createCanonicalImageTranscript(
      [1, 3],
      ["data:image/png;base64,YQ==", "data:image/png;base64,Yg=="],
      "submitted",
    );
    fixture.publish();
    expectSameImageNodes(fixture.images(), fixture.displayed);
  });

  it.each([
    {
      name: "ordered images",
      factIndexes: [0, 1],
      inlineUrls: ["data:image/png;base64,YQ==", "data:image/png;base64,Yg=="],
    },
    {
      name: "sparse reordered facts with duplicate previews and references",
      factIndexes: [2, 0, 3],
      inlineUrls: [
        "data:image/png;base64,YQ==",
        "data:image/png;base64,Yg==",
        "data:image/png;base64,YQ==",
      ],
    },
  ])(
    "retains exact slots for $name through reversed completion and removal",
    async ({ factIndexes, inlineUrls }) => {
      const fixture = await createCanonicalImageTranscript(factIndexes, inlineUrls);
      const firstIndexByUrl = new Map<string, number>();
      for (const [index, url] of inlineUrls.entries()) {
        const factIndex = expectDefined(factIndexes[index], "image fact index");
        const firstIndex = firstIndexByUrl.get(url);
        if (firstIndex === undefined) {
          firstIndexByUrl.set(url, factIndex);
        } else {
          fixture.media[factIndex] = fixture.media[firstIndex] ?? null;
        }
      }
      fixture.publish();
      const order = factIndexes
        .map((factIndex, index) => ({ factIndex, index }))
        .toSorted((a, b) => a.factIndex - b.factIndex);
      const expected = order.map(({ index }) =>
        expectDefined(fixture.displayed[index], "displayed slot"),
      );
      expectSameImageNodes(fixture.images(), expected);
      expect(fixture.images().map((image) => image.getAttribute("src"))).toEqual(
        order.map(({ index }) => fixture.previewUrls[index]),
      );

      for (const request of fixture.requests.toReversed()) {
        request.resolve(mediaMetadataResponse());
        await flushDeferredRowPrune();
        expectSameImageNodes(fixture.images(), expected);
      }
      for (const image of expected.toReversed()) {
        image.dispatchEvent(new Event("load"));
        expectSameImageNodes(fixture.images(), expected);
      }
      for (const [index, { factIndex }] of order.entries()) {
        expect(fixture.images()[index]?.getAttribute("src")).toContain(
          encodeURIComponent(expectDefined(fixture.media[factIndex], "canonical media fact").path),
        );
      }
      fixture.publish(
        {},
        fixture.media.map((fact, index) => (index === order[0]?.factIndex ? null : fact)),
      );
      expectSameImageNodes(fixture.images(), expected.slice(1));
    },
  );

  it.each(["auth", "connection epoch", "session"] as const)(
    "clears retained inline presentation on %s change and ignores old metadata",
    async (change) => {
      const fixture = await createCanonicalImageTranscript();
      fixture.publish();
      expectSameImageNodes(fixture.images(), fixture.displayed);
      const old = expectDefined(fixture.requests[0], "pending metadata");
      if (change === "auth") {
        fixture.props.assistantAttachmentAuthToken = "rotated-token";
      } else if (change === "connection epoch") {
        fixture.props.connectionEpoch = 2;
      } else {
        fixture.props.sessionKey = "agent:main:other";
      }
      fixture.renderPane();
      expect(fixture.images()).toHaveLength(0);
      expect(old.signal?.aborted).toBe(true);
      old.resolve(mediaMetadataResponse());
      await flushDeferredRowPrune();
      expect(fixture.images()).toHaveLength(0);
      fixture.requests.at(-1)?.resolve(mediaMetadataResponse());
      await flushDeferredRowPrune();
      expect(fixture.images()).toHaveLength(1);
      expect(fixture.images()[0]).not.toBe(fixture.displayed[0]);
    },
  );

  it.each(["removal", "replacement", "disconnect", "denial"] as const)(
    "clears an exact image handoff on %s without resurrection",
    async (change) => {
      const fixture = await createCanonicalImageTranscript();
      fixture.publish();
      expectSameImageNodes(fixture.images(), fixture.displayed);
      const old = expectDefined(fixture.requests[0], "pending metadata");
      if (change === "removal") {
        fixture.publish({}, []);
      } else if (change === "replacement") {
        fixture.publish({}, [
          { path: `media://inbound/${crypto.randomUUID()}.png`, contentType: "image/png" },
        ]);
      } else if (change === "disconnect") {
        fixture.root().setConnected(false);
        fixture.root().setConnected(true);
      }
      if (change !== "denial") {
        expect(old.signal?.aborted).toBe(true);
        expect(fixture.images()).toHaveLength(0);
      }
      old.resolve(mediaMetadataResponse(change !== "denial"));
      await flushDeferredRowPrune();
      expect(fixture.images()).toHaveLength(0);
      if (change === "denial") {
        expect(fixture.container.textContent).toContain("Attachment removed");
      }
    },
  );

  it.each(["removal", "auth", "replacement", "disconnect"] as const)(
    "retires a pending native image on %s and ignores its late load and error",
    async (change) => {
      const fixture = await createCanonicalImageTranscript();
      fixture.publish();
      fixture.requests[0]?.resolve(mediaMetadataResponse());
      await flushDeferredRowPrune();
      const displayed = expectDefined(fixture.displayed[0], "pending native image");
      expectSameImageNodes(fixture.images(), fixture.displayed);
      if (change === "removal") {
        fixture.publish({}, []);
      } else if (change === "auth") {
        fixture.props.assistantAttachmentAuthToken = "rotated-token";
        fixture.renderPane();
      } else if (change === "replacement") {
        fixture.publish({}, [
          { path: `media://inbound/${crypto.randomUUID()}.png`, contentType: "image/png" },
        ]);
      } else {
        fixture.root().setConnected(false);
      }
      displayed.dispatchEvent(new Event("load"));
      displayed.dispatchEvent(new Event("error"));
      await flushDeferredRowPrune();
      if (change === "disconnect") {
        fixture.root().setConnected(true);
      }
      expect(fixture.images()).toHaveLength(0);
    },
  );

  it.each([
    {
      name: "renewal",
      response: () => mediaMetadataResponse(true, "after-refresh"),
      reason: undefined,
    },
    {
      name: "denial",
      response: () => mediaMetadataResponse(false),
      reason: "Attachment removed",
    },
    {
      name: "retryable denial",
      response: () => mediaMetadataResponse(false, undefined, true),
      reason: "Attachment removed",
    },
    ...[401, 403].map((status) => ({
      name: `HTTP ${status} with an unreadable body`,
      response: () => unreadableMetadataResponse(status),
      reason: "Unavailable",
    })),
  ])(
    "updates native image presentation after metadata ticket $name",
    async ({ response, reason }) => {
      vi.useFakeTimers();
      try {
        const fixture = await createCanonicalImageTranscript();
        fixture.publish();
        fixture.requests[0]?.resolve(mediaMetadataResponse(true, "before-refresh"));
        await vi.advanceTimersByTimeAsync(0);
        const displayed = expectDefined(fixture.displayed[0], "displayed image");
        displayed.dispatchEvent(new Event("load"));
        await vi.advanceTimersByTimeAsync(1_000);
        fixture.requests[1]?.resolve(response());
        await vi.advanceTimersByTimeAsync(0);
        if (reason) {
          displayed.dispatchEvent(new Event("load"));
          expect(fixture.images()).toHaveLength(0);
          expect(fixture.container.textContent).toContain(reason);
          await vi.advanceTimersByTimeAsync(5_000);
          expect(fixture.images()).toHaveLength(0);
        } else {
          expectSameImageNodes(fixture.images(), fixture.displayed);
          expect(displayed.getAttribute("src")).toContain("mediaTicket=after-refresh");
          displayed.dispatchEvent(new Event("load"));
        }
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { presentation: "canonical", failure: "network rejection", responseStatus: null },
    { presentation: "inline-handoff", failure: "network rejection", responseStatus: null },
    { presentation: "canonical", failure: "body read rejection", responseStatus: 200 },
    { presentation: "canonical", failure: "HTTP 408 non-JSON", responseStatus: 408 },
    { presentation: "canonical", failure: "HTTP 429 non-JSON", responseStatus: 429 },
    { presentation: "canonical", failure: "HTTP 503 non-JSON", responseStatus: 503 },
  ])(
    "keeps a loaded $presentation image through $failure renewal and expiry",
    async ({ presentation, responseStatus }) => {
      vi.useFakeTimers();
      try {
        const fixture = await createCanonicalImageTranscript(
          undefined,
          presentation === "canonical" ? [] : undefined,
        );
        fixture.publish();
        fixture.requests[0]?.resolve(mediaMetadataResponse(true, "before-offline"));
        await vi.advanceTimersByTimeAsync(0);
        const displayed = expectDefined(fixture.images()[0], "loaded canonical image");
        expect(displayed.getAttribute("src")).toContain("mediaTicket=before-offline");
        Object.defineProperty(displayed, "naturalWidth", { value: 1 });
        displayed.dispatchEvent(new Event("load"));
        vi.mocked(fetch).mockImplementation(async () => {
          if (responseStatus === null) {
            throw new TypeError("Gateway offline");
          }
          if (responseStatus === 200) {
            return unreadableMetadataResponse();
          }
          return new Response("Service temporarily unavailable", { status: responseStatus });
        });

        // Exhaust renewals before the 31-second fixture ticket expires.
        await vi.advanceTimersByTimeAsync(11_000);
        expectSameImageNodes(fixture.images(), [displayed]);
        expect(fixture.container.querySelector(".chat-assistant-attachment-card")).toBeNull();

        await vi.advanceTimersByTimeAsync(20_001);
        expectSameImageNodes(fixture.images(), [displayed]);
        expect(fixture.container.querySelector(".chat-assistant-attachment-card")).toBeNull();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["native load error", "display load deadline"] as const)(
    "ends the retained handoff visibly on %s without retrying or resurrecting it",
    async (failure) => {
      vi.useFakeTimers();
      try {
        const fixture = await createCanonicalImageTranscript();
        fixture.publish();
        fixture.requests[0]?.resolve(mediaMetadataResponse());
        await vi.advanceTimersByTimeAsync(0);
        const displayed = expectDefined(fixture.displayed[0], "pending native image");
        if (failure === "native load error") {
          displayed.dispatchEvent(new Event("error"));
          await vi.advanceTimersByTimeAsync(0);
        } else {
          await vi.advanceTimersByTimeAsync(29_999);
          expectSameImageNodes(fixture.images(), fixture.displayed);
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(fixture.images()).toHaveLength(0);
        expect(
          fixture.container.querySelector(".chat-assistant-attachment-card--definitive"),
        ).not.toBeNull();
        displayed.dispatchEvent(new Event("load"));
        fixture.renderPane();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.images()).toHaveLength(0);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("keeps a successfully loaded native image after the handoff deadline", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createCanonicalImageTranscript();
      fixture.publish();
      fixture.requests[0]?.resolve(mediaMetadataResponse());
      await vi.advanceTimersByTimeAsync(0);
      const displayed = expectDefined(fixture.displayed[0], "pending native image");
      displayed.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(30_000);
      expectSameImageNodes(fixture.images(), [displayed]);
      expect(fixture.container.querySelector('[aria-busy="true"]')).toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
