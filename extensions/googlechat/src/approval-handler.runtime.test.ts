import type {
  ExecApprovalPendingView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  clearGoogleChatApprovalCardBindingsForTest,
  shouldSuppressGoogleChatManualExecApprovalFollowupText,
} from "./approval-card-actions.js";

const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const updateGoogleChatMessage = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    sendGoogleChatMessage,
    updateGoogleChatMessage,
  };
});

const { googleChatApprovalNativeRuntime } = await import("./approval-handler.runtime.js");

beforeEach(() => {
  vi.clearAllMocks();
  clearGoogleChatApprovalCardBindingsForTest();
});

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {
    audienceType: "app-url",
    audience: "https://chat-app.example.test/googlechat",
    appPrincipal: "123456789012345678901",
  },
} as ResolvedGoogleChatAccount;

const cfg: OpenClawConfig = {
  channels: {
    googlechat: {
      serviceAccount: {
        type: "service_account",
        client_email: "bot@example.com",
        private_key: "test-key",
        token_uri: "https://oauth2.googleapis.com/token",
      },
      audienceType: "app-url",
      audience: "https://chat-app.example.test/googlechat",
      appPrincipal: "123456789012345678901",
      dm: { allowFrom: ["users/123"] },
    },
  },
};

function createPendingView(): ExecApprovalPendingView {
  return {
    approvalId: "approval-1",
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    metadata: [{ label: "Agent", value: "main" }],
    ask: "on-miss",
    agentId: "main",
    warningText: null,
    commandAnalysis: null,
    commandText: "echo hi",
    commandPreview: null,
    cwd: "/tmp",
    envKeys: [],
    host: "gateway",
    nodeId: null,
    sessionKey: "agent:main:googlechat:spaces/AAA",
    actions: [
      {
        kind: "decision",
        decision: "allow-once",
        label: "Allow Once",
        style: "success",
        command: "/approve approval-1 allow-once",
        action: {
          type: "approval",
          approvalId: "approval-1",
          approvalKind: "exec",
          decision: "allow-once",
        },
      },
      {
        kind: "decision",
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve approval-1 deny",
        action: {
          type: "approval",
          approvalId: "approval-1",
          approvalKind: "exec",
          decision: "deny",
        },
      },
    ],
    expiresAtMs: Date.now() + 60_000,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

type CardPayloadWithTextWidgets = {
  cardsV2: Array<{
    card: {
      sections?: Array<{
        header?: string;
        widgets?: Array<{ textParagraph?: { text: string } }>;
      }>;
    };
  }>;
};

function getTextParagraphText(payload: unknown, header: string): string {
  const text = (payload as CardPayloadWithTextWidgets).cardsV2[0]?.card.sections?.find(
    (section) => section.header === header,
  )?.widgets?.[0]?.textParagraph?.text;
  if (typeof text !== "string") {
    throw new Error(`Expected ${header} text paragraph`);
  }
  return text;
}

function isUtf16WellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe("googleChatApprovalNativeRuntime", () => {
  async function preparePendingDelivery(view = createPendingView()) {
    const nowMs = Date.now();
    const request = {
      id: view.approvalId,
      request: { command: view.commandText },
      createdAtMs: nowMs,
      expiresAtMs: view.expiresAtMs,
    };
    const pendingPayload = await googleChatApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg,
      accountId: "default",
      context: { account },
      request,
      approvalKind: "exec",
      nowMs,
      view,
    });
    const plannedTarget = {
      surface: "origin" as const,
      target: { to: "spaces/AAA", threadId: "threads/T1" },
      reason: "preferred" as const,
    };
    const prepared = await googleChatApprovalNativeRuntime.transport.prepareTarget({
      cfg,
      accountId: "default",
      context: { account },
      plannedTarget,
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    if (!prepared) {
      throw new Error("Expected prepared target");
    }
    return { pendingPayload, plannedTarget, prepared, request, view };
  }

  it("keeps truncated pending command card text UTF-16 well formed", async () => {
    const view = createPendingView();
    view.commandText = `${"a".repeat(1796)}😀${"b".repeat(100)}`;

    const { pendingPayload } = await preparePendingDelivery(view);
    const commandText = getTextParagraphText(pendingPayload, "Command");

    expect(commandText.length).toBeLessThanOrEqual(1800);
    expect(commandText.endsWith("...")).toBe(true);
    expect(isUtf16WellFormed(commandText)).toBe(true);
    expect(JSON.stringify(pendingPayload.cardsV2)).not.toContain("\\ud83d");
  });

  it("preserves a complete astral character when it fits before the truncation suffix", async () => {
    const view = createPendingView();
    view.commandText = `${"a".repeat(1795)}😀${"b".repeat(100)}`;

    const { pendingPayload } = await preparePendingDelivery(view);
    const commandText = getTextParagraphText(pendingPayload, "Command");

    expect(commandText).toBe(`${"a".repeat(1795)}😀...`);
    expect(commandText.length).toBe(1800);
    expect(isUtf16WellFormed(commandText)).toBe(true);
  });

  it("sends pending cards and updates the delivered message without buttons", async () => {
    sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });
    updateGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });

    const view = createPendingView();
    const pendingPayload = await googleChatApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg,
      accountId: "default",
      context: { account },
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    });

    expect(JSON.stringify(pendingPayload)).toContain("cardsV2");
    expect(JSON.stringify(pendingPayload.cardsV2)).toContain(
      "https://chat-app.example.test/googlechat",
    );
    expect(JSON.stringify(pendingPayload.cardsV2)).not.toContain("/approve approval-1 allow-once");

    const prepared = await googleChatApprovalNativeRuntime.transport.prepareTarget({
      cfg,
      accountId: "default",
      context: { account },
      plannedTarget: {
        surface: "origin",
        target: { to: "spaces/AAA", threadId: "threads/T1" },
        reason: "preferred",
      },
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    if (!prepared) {
      throw new Error("Expected prepared target");
    }
    const entry = await googleChatApprovalNativeRuntime.transport.deliverPending({
      cfg,
      accountId: "default",
      context: { account },
      plannedTarget: {
        surface: "origin",
        target: { to: "spaces/AAA", threadId: "threads/T1" },
        reason: "preferred",
      },
      preparedTarget: prepared.target,
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
      approvalKind: "exec",
      view,
      pendingPayload,
    });

    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      cardsV2: expect.any(Array),
      thread: "threads/T1",
    });
    expect(sendGoogleChatMessage.mock.calls[0]?.[0]).not.toHaveProperty("text");
    expect(entry).toEqual({
      accountId: "default",
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "threads/T1",
      actionTokens: expect.any(Array),
    });
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        "Please reply with:\n/approve approval-1 allow-once",
      ),
    ).toBe(true);

    const resolvedView: ResolvedApprovalView = {
      ...view,
      phase: "resolved",
      decision: "allow-once",
      resolvedBy: "users/123",
    };
    const final = await googleChatApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg,
      accountId: "default",
      context: { account },
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
      resolved: {
        id: "approval-1",
        decision: "allow-once",
        resolvedBy: "users/123",
        ts: Date.now(),
      },
      view: resolvedView,
      entry,
    });
    expect(final.kind).toBe("update");
    if (final.kind !== "update" || !entry) {
      throw new Error("Expected update result and entry");
    }
    await googleChatApprovalNativeRuntime.transport.updateEntry?.({
      cfg,
      accountId: "default",
      context: { account },
      entry,
      payload: final.payload,
      phase: "resolved",
    });

    expect(updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/msg-1",
      cardsV2: expect.any(Array),
    });
    expect(updateGoogleChatMessage.mock.calls[0]?.[0]).not.toHaveProperty("text");
    expect(JSON.stringify(final.payload)).not.toContain("buttonList");
  });

  it("suppresses manual approval follow-ups while the native card send is in flight", async () => {
    const deferred = createDeferred<{ messageName: string }>();
    sendGoogleChatMessage.mockReturnValue(deferred.promise);
    const { pendingPayload, plannedTarget, prepared, request, view } =
      await preparePendingDelivery();

    const deliveryPromise = googleChatApprovalNativeRuntime.transport.deliverPending({
      cfg,
      accountId: "default",
      context: { account },
      plannedTarget,
      preparedTarget: prepared.target,
      request,
      approvalKind: "exec",
      view,
      pendingPayload,
    });

    await vi.waitFor(() => expect(sendGoogleChatMessage).toHaveBeenCalled());
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        "Please reply with:\n`/approve approval-1 allow-once`",
      ),
    ).toBe(true);

    deferred.resolve({ messageName: "spaces/AAA/messages/msg-1" });
    await expect(deliveryPromise).resolves.toEqual(
      expect.objectContaining({ messageName: "spaces/AAA/messages/msg-1" }),
    );
  });

  it("restores manual approval follow-ups when the native card send fails", async () => {
    sendGoogleChatMessage.mockRejectedValue(new Error("send failed"));
    const { pendingPayload, plannedTarget, prepared, request, view } =
      await preparePendingDelivery();

    await expect(
      googleChatApprovalNativeRuntime.transport.deliverPending({
        cfg,
        accountId: "default",
        context: { account },
        plannedTarget,
        preparedTarget: prepared.target,
        request,
        approvalKind: "exec",
        view,
        pendingPayload,
      }),
    ).rejects.toThrow("send failed");
    expect(
      shouldSuppressGoogleChatManualExecApprovalFollowupText(
        "Please reply with:\n`/approve approval-1 allow-once`",
      ),
    ).toBe(false);
  });

  it("uses the named Chat action when app-url add-on principal binding is absent", async () => {
    const view = createPendingView();
    const pendingPayload = await googleChatApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {
        channels: {
          googlechat: {
            serviceAccount: {
              type: "service_account",
              client_email: "bot@example.com",
              private_key: "test-key",
              token_uri: "https://oauth2.googleapis.com/token",
            },
            audienceType: "app-url",
            audience: "https://chat-app.example.test/googlechat",
            dm: { allowFrom: ["users/123"] },
          },
        },
      },
      accountId: "default",
      context: {
        account: {
          ...account,
          config: {
            audienceType: "app-url",
            audience: "https://chat-app.example.test/googlechat",
          },
        },
      },
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    });

    expect(JSON.stringify(pendingPayload.cardsV2)).toContain("openclaw.approval");
    expect(JSON.stringify(pendingPayload.cardsV2)).not.toContain(
      "https://chat-app.example.test/googlechat",
    );
  });
});
