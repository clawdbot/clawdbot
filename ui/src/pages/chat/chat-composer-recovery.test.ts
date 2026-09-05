/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { ChatPaneComposerHandoff } from "./chat-pane-attachment-handoff.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import { retryQueuedChatMessage } from "./chat-send-actions.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

const disposals: Array<() => void> = [];
const attachments: ChatAttachment[] = [];

function mount(
  transport: ReturnType<typeof makeChatHost>,
  context = { ...createInitializationContext(), sessions: transport.sessions },
  sessionKey = "agent:main:source",
) {
  const controller = new ChatStateController<ChatPageHost>({
    addController: () => undefined,
    removeController: () => undefined,
    requestUpdate: () => undefined,
    updateComplete: Promise.resolve(true),
  });
  controller.hostConnected();
  const state = createPageState(
    context,
    controller.createRenderLifecycle(),
    document.createElement("div"),
  );
  Object.assign(state, {
    client: transport.client,
    connected: true,
    connectionEpoch: 0,
    hello: transport.hello,
    settings: transport.settings,
    sessionKey,
    assistantAgentId: "main",
  });
  controller.attach(state);
  controller.restoreComposer();
  controller.startComposerPersistence();
  disposals.push(() => controller.hostDisconnected());
  return { state, controller, context };
}

function stageCommand(state: ChatPageHost) {
  const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
  const attachment = registerChatAttachmentPayload({
    attachment: {
      id: "command-document",
      mimeType: file.type,
      fileName: file.name,
      sizeBytes: file.size,
    },
    dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
    file,
  });
  attachments.push(attachment);
  state.chatAttachments = [attachment];
  state.handleChatDraftChange("/status", []);
  return attachment;
}

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  for (const dispose of disposals.splice(0).toReversed()) {
    dispose();
  }
  releaseChatAttachmentPayloads(attachments);
  attachments.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pending send composer ownership", () => {
  it.each([
    ["retained", "error"],
    ["retained", "rejection"],
    ["evicted", "error"],
    ["evicted", "rejection"],
    ["replaced", "error"],
    ["replaced", "rejection"],
    ["handoff", "error"],
    ["handoff", "rejection"],
  ] as const)("recovers a %s composer's command after %s", async (lifecycle, response) => {
    const acknowledgment = createDeferred<{ runId: string; status: "error" }>();
    let attempts = 0;
    const transport = makeChatHost({
      requestHandlers: {
        "chat.send": () => (++attempts === 1 ? acknowledgment.promise : { status: "ok" }),
      },
    });
    const source = mount(transport, undefined, lifecycle === "handoff" ? "global" : undefined);
    const document = stageCommand(source.state);
    let presented = true;
    const present = (pane: typeof source, region: "page" | "dock", visible: () => boolean) => {
      const handoff = new ChatPaneComposerHandoff(source.context, {
        state: () => pane.state,
        owner: () => transport.client,
        region: () => region,
        presented: visible,
        pause: () => pane.controller.pauseComposerPersistence(),
        resume: (restore) => {
          if (restore) {
            pane.controller.restoreComposer();
          }
          pane.controller.startComposerPersistence();
        },
      });
      handoff.claim();
      disposals.push(() => handoff.dispose());
    };
    if (lifecycle === "handoff") {
      present(source, "page", () => presented);
    }
    const send = source.state.handleSendChat();
    await vi.waitFor(() => expect(attempts).toBe(1));
    const original = findChatSendPayload(transport);
    const pending = source.state.chatQueue[0]!;
    const reopen = () => mount(transport, source.context, source.state.sessionKey);
    if (lifecycle === "evicted" || lifecycle === "replaced") {
      source.controller.persistComposerForEviction();
      source.controller.hostDisconnected();
    }
    let replacement: typeof source | undefined;
    if (lifecycle === "replaced" || lifecycle === "handoff") {
      replacement = reopen();
    }
    if (lifecycle === "handoff") {
      presented = false;
      present(replacement!, "dock", () => true);
    }
    if (response === "rejection") {
      acknowledgment.reject(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Command rejected" }),
      );
    } else {
      acknowledgment.resolve({ runId: pending.sendRunId!, status: "error" });
    }
    await send;
    if (lifecycle === "retained") {
      expect(source.state.chatMessage).toBe("/status");
      expect(source.state.chatAttachments).toMatchObject([{ id: document.id }]);
      expect(getChatAttachmentDataUrl(source.state.chatAttachments[0]!)).toBe(
        "data:application/pdf;base64,JVBERi0xLjQK",
      );
      expect(source.state.chatQueue).toEqual([]);
      return;
    }
    const recovered = replacement ?? reopen();
    expect(recovered.state.chatMessage).toBe("");
    expect(recovered.state.chatAttachments).toEqual([]);
    await vi.waitFor(() => {
      expect(recovered.state.chatQueue).toMatchObject([
        { id: pending.id, text: "/status", sendRunId: pending.sendRunId, sendState: "failed" },
      ]);
      expect(getChatAttachmentDataUrl(recovered.state.chatQueue[0]!.attachments![0]!)).toBe(
        "data:application/pdf;base64,JVBERi0xLjQK",
      );
    });
    await retryQueuedChatMessage(recovered.state, pending.id);
    const requests = transport.request.mock.calls.filter(([method]) => method === "chat.send");
    expect(requests).toHaveLength(2);
    expect(requests[1]![1]).toEqual({ ...original, idempotencyKey: expect.any(String) });
    expect(requests[1]![1]).not.toEqual(original);
    expect(recovered.state.chatQueue).toEqual([]);
  });

  it("retires an accepted send after its pane detaches", async () => {
    const acknowledgment = createDeferred<{ status: "ok" }>();
    const transport = makeChatHost({
      requestHandlers: { "chat.send": () => acknowledgment.promise },
    });
    const source = mount(transport);
    stageCommand(source.state);
    const send = source.state.handleSendChat();
    await vi.waitFor(() =>
      expect(transport.request.mock.calls.some(([method]) => method === "chat.send")).toBe(true),
    );
    source.controller.persistComposerForEviction();
    source.controller.hostDisconnected();
    acknowledgment.resolve({ status: "ok" });
    await send;
    const reopened = mount(transport, source.context);
    expect(reopened.state.chatQueue).toEqual([]);
    expect(reopened.state.chatMessage).toBe("");
    expect(reopened.state.chatAttachments).toEqual([]);
  });
});
