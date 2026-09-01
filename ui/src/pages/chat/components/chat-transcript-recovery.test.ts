/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { resetChatViewState } from "../chat-view-state.ts";
import type { SidebarFullMessageLoader } from "./chat-sidebar.ts";
import {
  renderTranscriptSearch,
  toggleTranscriptSearch,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

type FullMessageResult = Awaited<ReturnType<SidebarFullMessageLoader>>;

const previewMessage = {
  role: "assistant",
  content: "Preview\n...(truncated)...",
  __openclaw: { id: "assistant-full-1", truncated: true },
  timestamp: 1_000,
};

function fullMessage(content: string): FullMessageResult {
  return { ok: true, message: { role: "assistant", content } };
}

class RecoveryTranscriptElement extends LitElement {
  props: ChatThreadProps = threadProps("recovery-pane");
  private readonly transcript = new ChatTranscriptController(this);

  override createRenderRoot() {
    return this;
  }

  override render() {
    const requestUpdate = () => this.requestUpdate();
    return html`
      ${renderTranscriptSearch(this.props.paneId, requestUpdate)}
      ${renderChatThread({ ...this.props, onRequestUpdate: requestUpdate }, this.transcript)}
    `;
  }

  override disconnectedCallback() {
    // Match the pane-specific production reset before Lit disconnects controllers.
    resetChatViewState(this.props.paneId);
    super.disconnectedCallback();
  }
}

customElements.define("test-recovery-transcript", RecoveryTranscriptElement);

function mountTranscript(
  paneId: string,
  loadFullAssistantMessage: SidebarFullMessageLoader,
  sessionKey = "agent:work:main",
): RecoveryTranscriptElement {
  const pane = document.createElement("test-recovery-transcript") as RecoveryTranscriptElement;
  pane.props = {
    ...threadProps(paneId, sessionKey, [previewMessage]),
    fullMessageAgentId: "work",
    loadFullAssistantMessage,
  };
  document.body.append(pane);
  return pane;
}

describe("chat transcript full-message recovery", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("automatically loads once and keeps full text through rerenders and search filtering", async () => {
    const load = vi
      .fn<SidebarFullMessageLoader>()
      .mockResolvedValue(fullMessage("Complete answer."));
    const pane = mountTranscript("recovery-visible", load);
    await vi.waitFor(() => expect(pane.textContent).toContain("Complete answer."));
    expect(load).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:work:main",
      agentId: "work",
      messageId: "assistant-full-1",
    });
    expect(pane.querySelector(".chat-message-disclosure__toggle")).toBeNull();

    toggleTranscriptSearch(pane.props.paneId, () => pane.requestUpdate());
    await pane.updateComplete;
    const input = expectDefined(
      pane.querySelector<HTMLInputElement>(".agent-chat__search-bar input"),
      "transcript search input",
    );
    input.value = "unmatched search";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await pane.updateComplete;
    expect(pane.querySelector(".chat-bubble")).toBeNull();

    toggleTranscriptSearch(pane.props.paneId, () => pane.requestUpdate());
    await pane.updateComplete;
    pane.requestUpdate();
    await pane.updateComplete;
    expect(pane.textContent).toContain("Complete answer.");
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps the transport preview when full content is unavailable", async () => {
    const load = vi.fn<SidebarFullMessageLoader>().mockRejectedValue(new Error("offline"));
    const pane = mountTranscript("recovery-unavailable", load);
    await vi.waitFor(() => expect(pane.textContent).toContain("Could not load the full message."));
    expect(pane.textContent).toContain("Preview");
    expect(pane.textContent).toContain("...(truncated)...");
    expect(pane.querySelector(".chat-message-disclosure__toggle")).toBeNull();
  });

  it("retires a disconnected pane's bodies without invalidating a surviving split pane", async () => {
    const load = vi
      .fn<SidebarFullMessageLoader>()
      .mockResolvedValue(fullMessage("Original answer."));
    const first = mountTranscript("recovery-split-first", load);
    await vi.waitFor(() => expect(first.textContent).toContain("Original answer."));
    const sibling = mountTranscript("recovery-split-second", load);
    await vi.waitFor(() => expect(sibling.textContent).toContain("Original answer."));
    const loadedRequests = load.mock.calls.length;

    first.remove();
    sibling.requestUpdate();
    await sibling.updateComplete;
    expect(sibling.textContent).toContain("Original answer.");
    expect(load).toHaveBeenCalledTimes(loadedRequests);

    load.mockResolvedValue(fullMessage("Recovered after remount."));
    const replacement = mountTranscript("recovery-split-first", load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(loadedRequests + 1));
    await vi.waitFor(() => expect(replacement.textContent).toContain("Recovered after remount."));
    expect(sibling.textContent).toContain("Original answer.");
  });

  it("ignores a pending completion after pane teardown and same-identity remount", async () => {
    const pending = createDeferred<FullMessageResult>();
    const load = vi
      .fn<SidebarFullMessageLoader>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(fullMessage("Current answer."));
    const retired = mountTranscript("recovery-remount", load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    retired.remove();
    const current = mountTranscript("recovery-remount", load);
    await current.updateComplete;
    await flushDeferredRowPrune();
    const retiredUpdates = vi.spyOn(retired, "requestUpdate");

    pending.resolve(fullMessage("Retired answer."));
    await flushDeferredRowPrune();
    expect(retiredUpdates).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(current.textContent).toContain("Current answer."));
    expect(current.textContent).not.toContain("Retired answer.");
  });

  it.each(["session", "agent"] as const)("scopes recovery to the requested %s", async (scope) => {
    const load = vi.fn<SidebarFullMessageLoader>().mockResolvedValue(fullMessage("First scope."));
    const pane = mountTranscript("recovery-routing", load, "global");
    await vi.waitFor(() => expect(pane.textContent).toContain("First scope."));

    load.mockResolvedValue(fullMessage("Second scope."));
    pane.props = {
      ...pane.props,
      ...(scope === "session"
        ? { sessionKey: "agent:work:other" }
        : { fullMessageAgentId: "other" }),
    };
    pane.requestUpdate();
    await vi.waitFor(() => expect(pane.textContent).toContain("Second scope."));
    expect(load).toHaveBeenLastCalledWith({
      sessionKey: pane.props.sessionKey,
      agentId: pane.props.fullMessageAgentId,
      messageId: "assistant-full-1",
    });
  });

  it("discards recovered bodies when their source leaves active history", async () => {
    const load = vi.fn<SidebarFullMessageLoader>().mockResolvedValue(fullMessage("Original body."));
    const pane = mountTranscript("recovery-pruning", load);
    await vi.waitFor(() => expect(pane.textContent).toContain("Original body."));

    pane.props.messages = [];
    pane.requestUpdate();
    await pane.updateComplete;
    load.mockResolvedValue(fullMessage("Revisited body."));
    pane.props.messages = [previewMessage];
    pane.requestUpdate();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(pane.textContent).toContain("Revisited body."));
  });

  it("keeps recovered pending-input text until that input leaves the source", async () => {
    const load = vi
      .fn<SidebarFullMessageLoader>()
      .mockResolvedValue(fullMessage("Accepted input."));
    const pane = mountTranscript("recovery-pending-input", load);
    const pendingInputs: ChatThreadProps["pendingInputs"] = [
      {
        id: "accepted-1",
        acceptedAt: 1_000,
        state: "queued",
        message: {
          ...previewMessage,
          role: "user",
          __openclaw: { id: "pending:accepted-1", truncated: true },
        },
      },
    ];
    pane.props.messages = [];
    pane.props.pendingInputs = pendingInputs;
    await vi.waitFor(() => expect(pane.textContent).toContain("Accepted input."));
    pane.requestUpdate();
    await pane.updateComplete;
    expect(load).toHaveBeenCalledOnce();
    expect(pane.textContent).toContain("Accepted input.");

    pane.props.pendingInputs = [];
    pane.requestUpdate();
    await pane.updateComplete;
    load.mockResolvedValue(fullMessage("Revisited input."));
    pane.props.pendingInputs = pendingInputs;
    pane.requestUpdate();
    await vi.waitFor(() => expect(pane.textContent).toContain("Revisited input."));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("fences a pruned request when the same message starts a new recovery", async () => {
    const first = createDeferred<FullMessageResult>();
    const second = createDeferred<FullMessageResult>();
    const load = vi
      .fn<SidebarFullMessageLoader>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const pane = mountTranscript("recovery-pending-pruning", load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());

    pane.props.messages = [];
    pane.requestUpdate();
    await pane.updateComplete;
    pane.props.messages = [previewMessage];
    pane.requestUpdate();
    await pane.updateComplete;
    await flushDeferredRowPrune();
    const updates = vi.spyOn(pane, "requestUpdate");
    first.resolve(fullMessage("Obsolete body."));
    await flushDeferredRowPrune();
    expect(updates).not.toHaveBeenCalled();
    expect(pane.textContent).not.toContain("Obsolete body.");

    second.resolve(fullMessage("Replacement body."));
    await vi.waitFor(() => expect(pane.textContent).toContain("Replacement body."));
  });
});
