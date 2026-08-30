import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import type { ChatHistoryResult } from "../../pages/chat/chat-history.ts";
import { copyToClipboard } from "../clipboard.ts";
import { showToast } from "../toast.ts";
import { canSplitSessionView, runSessionNavigationAction } from "./session-menu-navigation.ts";

vi.mock("../clipboard.ts", () => ({ copyToClipboard: vi.fn(async () => true) }));
vi.mock("../toast.ts", () => ({ showToast: vi.fn() }));

const session = {
  key: "agent:research:dashboard:12345678-90ab-cdef-1234-567890abcdef",
  sessionId: "session-1",
};

function fixture() {
  const request = vi.fn<(...args: unknown[]) => Promise<ChatHistoryResult>>();
  const context = {
    basePath: "/control",
    agentSelection: { state: { selectedId: "research" } },
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          agents: [{ id: "research", name: "Research" }],
        },
      },
    },
    gateway: {
      snapshot: {
        phase: "connected",
        client: { request },
        hello: {
          features: { methods: ["chat.history"] },
          auth: { role: "operator", scopes: ["operator.read"] },
        },
      },
    },
    sessions: { state: { result: { sessions: [{ ...session, boardFace: "dashboard" }] } } },
  } as unknown as ApplicationContext;
  const params = { context, session, isCurrent: () => true };
  return { context, params, request };
}

function page(messages: unknown[], extra: Partial<ChatHistoryResult> = {}): ChatHistoryResult {
  return { sessionId: session.sessionId, messages, totalMessages: 3, hasMore: false, ...extra };
}

function message(seq: number, content: string) {
  return { role: "assistant", content, __openclaw: { seq } };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("session menu navigation actions", () => {
  it("copies an exact session link with the stored face and deployment prefix", async () => {
    const { params } = fixture();
    await runSessionNavigationAction("copy-session-link", params);
    const copied = vi.mocked(copyToClipboard).mock.calls[0]?.[0];
    const url = new URL(copied!);
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe(
      "/control/dashboard/research/dashboard/12345678-90ab-cdef-1234-567890abcdef",
    );
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it.each([
    ["open-new-tab", undefined],
    ["open-new-window", "popup"],
  ] as const)("opens %s with a detached opener", async (kind, features) => {
    const opened = { opener: window };
    const open = vi.spyOn(window, "open").mockReturnValue(opened as unknown as Window);
    await runSessionNavigationAction(kind, fixture().params);
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("/control/dashboard/research/"),
      "_blank",
      features,
    );
    expect(opened.opener).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("reports popup blocking", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    await runSessionNavigationAction("open-new-window", fixture().params);
    expect(showToast).toHaveBeenCalledWith({ message: t("sessionsView.openWindowBlocked") });
  });

  it("copies every history page chronologically without duplicating replayed records", async () => {
    const { params, request } = fixture();
    const first = message(1, "First response");
    const middle = message(2, "Middle response");
    const last = message(3, "Last response");
    request.mockResolvedValueOnce(page([middle, last], { hasMore: true, nextOffset: 1 }));
    request.mockResolvedValueOnce(page([first, middle]));

    await runSessionNavigationAction("copy-markdown", params);

    expect(request.mock.calls.map((call) => call[1])).toEqual([
      { sessionKey: session.key, agentId: "research", limit: 1000, maxChars: 500_000, offset: 0 },
      { sessionKey: session.key, agentId: "research", limit: 1000, maxChars: 500_000, offset: 1 },
    ]);
    const copied = vi.mocked(copyToClipboard).mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("# Chat with Research");
    expect(copied.match(/Middle response/g)).toHaveLength(1);
    expect(copied.indexOf("First response")).toBeLessThan(copied.indexOf("Middle response"));
    expect(copied.indexOf("Middle response")).toBeLessThan(copied.indexOf("Last response"));
  });

  it.each([
    { sessionId: "replacement-session" },
    { totalMessages: 4 },
    { sessionInfo: { activeLeafEntryId: "different-branch" } as ChatHistoryResult["sessionInfo"] },
    { hasMore: true, nextOffset: 1 },
  ])("does not copy partial history when paging changes or stalls: %j", async (changed) => {
    const { params, request } = fixture();
    request.mockResolvedValueOnce(page([message(3, "Newest")], { hasMore: true, nextOffset: 1 }));
    request.mockResolvedValueOnce(page([message(1, "Older")], changed));
    await runSessionNavigationAction("copy-markdown", params);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({ message: t("sessionsView.copyTranscriptChanged") });
  });

  it("retires a pending transcript copy when its source view changes", async () => {
    const { params, request } = fixture();
    let current = true;
    params.isCurrent = () => current;
    request.mockImplementationOnce(async () => {
      current = false;
      return page([message(1, "Wrong view")]);
    });
    await runSessionNavigationAction("copy-markdown", params);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({ message: t("sessionsView.copyTranscriptChanged") });
  });

  it("denies transcript reads without operator.read", async () => {
    const { params, request } = fixture();
    params.context.gateway.snapshot.hello!.auth!.scopes = [];
    await runSessionNavigationAction("copy-markdown", params);
    expect(request).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({ message: t("sessionsView.actionRequiresRead") });
  });

  it("reports an empty transcript without replacing the clipboard", async () => {
    const { params, request } = fixture();
    request.mockResolvedValueOnce(page([], { totalMessages: 0 }));
    await runSessionNavigationAction("copy-markdown", params);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({ message: t("chat.commandResults.emptyExport") });
  });

  it("uses the mounted chat owner's split capability and requires its handling receipt", async () => {
    const params = fixture().params;
    expect(canSplitSessionView()).toBe(false);
    const chatPage = document.createElement("openclaw-chat-page");
    Object.assign(chatPage, { sessionSplitAvailable: true });
    document.body.append(chatPage);
    expect(canSplitSessionView()).toBe(true);
    const received = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(UI_COMMAND_EVENT, received);
    try {
      await runSessionNavigationAction("split-below", params);
      const event = received.mock.calls[0]?.[0] as CustomEvent;
      expect(event.detail).toEqual({
        command: { kind: "split", direction: "down", sessionKey: session.key },
      });
      expect(showToast).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(UI_COMMAND_EVENT, received);
    }
    await runSessionNavigationAction("split-right", params);
    expect(showToast).toHaveBeenCalledWith({ message: t("sessionsView.splitUnavailable") });
  });
});
