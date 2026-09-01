/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function expectSameImageNodes(actual: HTMLImageElement[], expected: HTMLImageElement[]) {
  expect(actual).toHaveLength(expected.length);
  for (const [index, image] of expected.entries()) {
    expect(actual[index]).toBe(image);
  }
}

function mediaMetadataResponse(available = true, mediaTicket?: string): Response {
  return {
    ok: true,
    json: async () => ({
      available,
      reason: available ? undefined : "Attachment removed",
      retryable: false,
      ...(mediaTicket
        ? { mediaTicket, mediaTicketExpiresAt: new Date(Date.now() + 31_000).toISOString() }
        : {}),
    }),
  } as Response;
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

function createCanonicalImageTranscript(
  factIndexes = [0],
  inlineUrls = ["data:image/png;base64,aW5saW5l"],
) {
  const decodes: Array<{ image: HTMLImageElement; resolve: () => void; reject: () => void }> = [];
  vi.stubGlobal(
    "Image",
    vi.fn(function () {
      const image = document.createElement("img");
      const decoded = new Promise<void>((resolve, reject) => {
        decodes.push({ image, resolve, reject: () => reject(new Error("Image decode failed")) });
      });
      image.decode = vi.fn(() => decoded);
      return image;
    }),
  );
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
    idempotencyKey: "canonical-image-send",
    mediaImageLayout: { slots: factIndexes.map((factIndex) => ({ kind: "inline", factIndex })) },
  };
  const cached = {
    role: "user",
    timestamp: 1_000,
    content: [
      { type: "text", text: "Cached text" },
      ...inlineUrls.map((url) => ({ type: "image", url })),
    ],
    __openclaw: canonical,
  };
  const media = Array.from({ length: Math.max(...factIndexes) + 1 }, (_, index) =>
    factIndexes.includes(index)
      ? { path: `media://inbound/${crypto.randomUUID()}.png`, contentType: "image/png" }
      : null,
  );
  const props = {
    ...threadProps(`pane-${crypto.randomUUID()}`, "agent:main:main", [cached]),
    assistantAttachmentAuthToken: "test-auth-token",
    connectionEpoch: 1,
  };
  const { container, renderPane, root } = mountTranscriptPane(props);
  const images = () => [...container.querySelectorAll<HTMLImageElement>(".chat-message-image")];
  const displayed = images();
  expect(displayed).toHaveLength(inlineUrls.length);
  for (const image of displayed) {
    // jsdom has no decoder; deliver the browser's successful load boundary.
    Object.defineProperty(image, "naturalWidth", { value: 1 });
    image.dispatchEvent(new Event("load"));
  }
  const publish = (
    metadata: Record<string, unknown> = {},
    nextMedia = media,
    text = "Fresh authoritative text",
  ) => {
    props.messages = [
      {
        ...cached,
        content: [{ type: "text", text }],
        __openclaw: { ...canonical, media: nextMedia, ...metadata },
      },
    ];
    renderPane();
  };
  return {
    container,
    props,
    displayed,
    inlineUrls,
    media,
    requests,
    decodes,
    images,
    publish,
    renderPane,
    root,
  };
}

describe("canonical image presentation handoff", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("keeps the displayed canonical inline image while fresh history text and media metadata arrive", async () => {
    const fixture = createCanonicalImageTranscript();
    const displayed = expectDefined(fixture.displayed[0], "displayed inline image");
    fixture.publish();

    expect(fixture.container.textContent).toContain("Fresh authoritative text");
    expect(fixture.container.textContent).not.toContain("Cached text");
    expectSameImageNodes(fixture.images(), [displayed]);
    expect(displayed.getAttribute("src")).toBe(fixture.inlineUrls[0]);

    fixture.requests[0]?.resolve(mediaMetadataResponse());
    await flushDeferredRowPrune();
    expectSameImageNodes(fixture.images(), [displayed]);
    expect(displayed.getAttribute("src")).toBe(fixture.inlineUrls[0]);
    const prepared = expectDefined(fixture.decodes[0], "canonical decode request");
    expect(prepared.image.getAttribute("src")).toContain(
      encodeURIComponent(expectDefined(fixture.media[0], "canonical media fact").path),
    );
    fixture.renderPane();
    expect(fixture.decodes).toHaveLength(1);
    prepared.resolve();
    await flushDeferredRowPrune();
    expectSameImageNodes(fixture.images(), [displayed]);
    expect(displayed.getAttribute("src")).toContain(
      encodeURIComponent(expectDefined(fixture.media[0], "canonical media fact").path),
    );
    expect(prepared.image.getAttribute("src")).not.toBeNull();
    displayed.dispatchEvent(new Event("load"));
    expect(prepared.image.getAttribute("src")).toBeNull();
  });

  it.each([
    {
      name: "different canonical ID with identical text and send key",
      metadata: { id: "different-native-id" },
    },
    { name: "different canonical sequence", metadata: { seq: 2 } },
    { name: "missing persisted ID", metadata: { id: undefined } },
    { name: "imported message identity", metadata: { importedFrom: "external" } },
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
  ])("does not borrow an inline preview for $name", ({ metadata }) => {
    const fixture = createCanonicalImageTranscript();
    fixture.publish(metadata, fixture.media, "Cached text");
    expect(fixture.images()).toHaveLength(0);
    expect(fixture.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it.each([
    { name: "missing inline block", factIndexes: [0, 2] },
    { name: "duplicate fact index", factIndexes: [0, 0] },
  ])("does not guess cached correspondence with $name", ({ factIndexes }) => {
    const fixture = createCanonicalImageTranscript(factIndexes);
    fixture.publish();
    expect(fixture.images()).toHaveLength(0);
  });

  it("does not lend a displayed inline image to another pane of the same canonical message", () => {
    const fixture = createCanonicalImageTranscript();
    fixture.publish();
    const { container } = mountTranscriptPane({ ...fixture.props, paneId: "other-image-pane" });
    expectSameImageNodes(fixture.images(), fixture.displayed);
    expect(container.querySelector(".chat-message-image")).toBeNull();
    expect(fixture.requests).toHaveLength(1);
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
      const fixture = createCanonicalImageTranscript(factIndexes, inlineUrls);
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
        order.map(({ index }) => inlineUrls[index]),
      );

      for (const request of fixture.requests.toReversed()) {
        request.resolve(mediaMetadataResponse());
        await flushDeferredRowPrune();
        expectSameImageNodes(fixture.images(), expected);
      }
      for (const prepared of fixture.decodes.toReversed()) {
        prepared.resolve();
        await flushDeferredRowPrune();
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
      const fixture = createCanonicalImageTranscript();
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
      const fixture = createCanonicalImageTranscript();
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
    "discards a pending decode on %s and ignores its late completion",
    async (change) => {
      const fixture = createCanonicalImageTranscript();
      fixture.publish();
      fixture.requests[0]?.resolve(mediaMetadataResponse());
      await flushDeferredRowPrune();
      const prepared = expectDefined(fixture.decodes[0], "pending decode");
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
      expect(prepared.image.getAttribute("src")).toBeNull();
      prepared.resolve();
      await flushDeferredRowPrune();
      expect(fixture.displayed[0]?.getAttribute("src")).toBe(fixture.inlineUrls[0]);
      if (change === "disconnect") {
        fixture.root().setConnected(true);
      }
      expect(fixture.images()).toHaveLength(0);
    },
  );

  it.each(["renewal", "denial"] as const)(
    "discards the old decode after metadata ticket %s",
    async (change) => {
      vi.useFakeTimers();
      try {
        const fixture = createCanonicalImageTranscript();
        fixture.publish();
        fixture.requests[0]?.resolve(mediaMetadataResponse(true, "before-refresh"));
        await vi.advanceTimersByTimeAsync(0);
        const old = expectDefined(fixture.decodes[0], "old ticket decode");
        await vi.advanceTimersByTimeAsync(1_000);
        fixture.requests[1]?.resolve(mediaMetadataResponse(change === "renewal", "after-refresh"));
        await vi.advanceTimersByTimeAsync(0);
        expect(old.image.getAttribute("src")).toBeNull();
        old.reject();
        await vi.advanceTimersByTimeAsync(0);
        if (change === "denial") {
          expect(fixture.images()).toHaveLength(0);
          expect(fixture.container.textContent).toContain("Attachment removed");
        } else {
          expectSameImageNodes(fixture.images(), fixture.displayed);
          expect(fixture.displayed[0]?.getAttribute("src")).toBe(fixture.inlineUrls[0]);
          const current = expectDefined(fixture.decodes[1], "renewed ticket decode");
          current.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expectSameImageNodes(fixture.images(), fixture.displayed);
          expect(fixture.displayed[0]?.getAttribute("src")).toContain("mediaTicket=after-refresh");
        }
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(["decode rejection", "decode deadline", "display load deadline"] as const)(
    "ends the retained handoff visibly on %s without retrying or resurrecting it",
    async (failure) => {
      vi.useFakeTimers();
      try {
        const fixture = createCanonicalImageTranscript();
        fixture.publish();
        fixture.requests[0]?.resolve(mediaMetadataResponse());
        await vi.advanceTimersByTimeAsync(0);
        const prepared = expectDefined(fixture.decodes[0], "pending decode");
        if (failure === "decode rejection") {
          prepared.reject();
          await vi.advanceTimersByTimeAsync(0);
        } else {
          if (failure === "display load deadline") {
            prepared.resolve();
            await vi.advanceTimersByTimeAsync(0);
          }
          await vi.advanceTimersByTimeAsync(29_999);
          expectSameImageNodes(fixture.images(), fixture.displayed);
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(prepared.image.getAttribute("src")).toBeNull();
        expect(fixture.images()).toHaveLength(0);
        expect(
          fixture.container.querySelector(".chat-assistant-attachment-card--definitive"),
        ).not.toBeNull();
        prepared.resolve();
        fixture.renderPane();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.images()).toHaveLength(0);
        expect(fixture.decodes).toHaveLength(1);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );
});
