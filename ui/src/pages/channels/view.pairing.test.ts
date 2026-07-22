/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  renderChannelPairingDetail,
  renderChannelPairingPrompt,
  renderChannelPairingQueue,
} from "./view.pairing.ts";
import type { ChannelsProps } from "./view.types.ts";

const request = {
  requestId: "opaque-request-id",
  channel: "whatsapp",
  channelLabel: "WhatsApp",
  accountId: "personal",
  accountLabel: "Personal",
  senderId: "+15551234567",
  senderLabel: "Phone number",
  metadata: { name: "Alice" },
  createdAt: "2026-07-20T10:00:00.000Z",
  lastSeenAt: "2026-07-20T10:05:00.000Z",
  expiresAt: "2026-07-20T11:00:00.000Z",
  notifySupported: true,
} as const;

function createProps(overrides: Partial<ChannelsProps> = {}): ChannelsProps {
  return {
    connected: true,
    loading: false,
    snapshot: null,
    lastError: null,
    lastSuccessAt: null,
    pairingLoading: false,
    pairingSnapshot: {
      accounts: [
        {
          channel: "whatsapp",
          channelLabel: "WhatsApp",
          accountId: "personal",
          accountLabel: "Personal",
          notifySupported: true,
        },
      ],
      requests: [request],
      commandOwnerConfigured: false,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    },
    pairingError: null,
    pairingLastSuccessAt: null,
    pairingBusyRequestId: null,
    pairingChannelFilter: null,
    pairingAccountFilter: null,
    pairingPrompt: null,
    pairingNotice: null,
    canManagePairing: true,
    canAdmin: true,
    whatsappMessage: null,
    whatsappQrDataUrl: null,
    whatsappConnected: null,
    whatsappBusy: false,
    configSchema: null,
    configSchemaLoading: false,
    configForm: null,
    configUiHints: {},
    configSaving: false,
    configFormDirty: false,
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    selectedChannel: null,
    wizard: { phase: "idle" },
    wizardMultiselect: [],
    setupBlockedByDirtyConfig: false,
    onShowDetail: () => undefined,
    onCloseDetail: () => undefined,
    onStartSetup: () => undefined,
    onWizardAnswer: () => undefined,
    onWizardToggleMultiselect: () => undefined,
    onWizardClose: () => undefined,
    onRefresh: () => undefined,
    onPairingRefresh: () => undefined,
    onPairingFilterChange: () => undefined,
    onPairingReviewAccount: () => undefined,
    onPairingApprove: () => undefined,
    onPairingDismiss: () => undefined,
    onPairingPromptChange: () => undefined,
    onPairingPromptCancel: () => undefined,
    onPairingPromptConfirm: () => undefined,
    onWhatsAppStart: () => undefined,
    onWhatsAppWait: () => undefined,
    onWhatsAppLogout: () => undefined,
    onConfigPatch: () => undefined,
    onConfigSave: () => undefined,
    onConfigReload: () => undefined,
    onNostrProfileEdit: () => undefined,
    onNostrProfileCancel: () => undefined,
    onNostrProfileFieldChange: () => undefined,
    onNostrProfileSave: () => undefined,
    onNostrProfileImport: () => undefined,
    onNostrProfileToggleAdvanced: () => undefined,
    ...overrides,
  };
}

function renderInto(template: unknown): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(template as never, container);
  return container;
}

describe("channel DM access request views", () => {
  it("renders pending senders without exposing the pairing code", () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    const container = renderInto(
      renderChannelPairingQueue(
        createProps({ onPairingApprove: onApprove, onPairingDismiss: onDismiss }),
      ),
    );

    expect(container.textContent).toContain("+15551234567");
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).not.toContain("SECRET12");
    const buttons = Array.from(container.querySelectorAll("button"));
    buttons.find((button) => button.textContent?.trim() === "Approve")?.click();
    buttons.find((button) => button.textContent?.trim() === "Dismiss")?.click();
    expect(onApprove).toHaveBeenCalledWith(request);
    expect(onDismiss).toHaveBeenCalledWith(request);
  });

  it("hides cached sender data without pairing access", () => {
    const container = renderInto(
      renderChannelPairingQueue(createProps({ canManagePairing: false })),
    );

    expect(container.textContent).toContain("operator.pairing access");
    expect(container.textContent).not.toContain("+15551234567");
    expect(container.textContent).not.toContain("Alice");
  });

  it("disables every request action while one mutation is active", () => {
    const secondRequest = {
      ...request,
      requestId: "other-request",
      senderId: "987654321",
    };
    const props = createProps({
      pairingBusyRequestId: request.requestId,
      pairingSnapshot: {
        ...createProps().pairingSnapshot!,
        requests: [request, secondRequest],
      },
    });
    const container = renderInto(renderChannelPairingQueue(props));
    const actionButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => /^(Approve|Dismiss) /u.test(button.getAttribute("aria-label") ?? ""));

    expect(actionButtons).toHaveLength(4);
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
  });

  it("shows explicit notification and first-owner choices for an admin", () => {
    const container = renderInto(
      renderChannelPairingPrompt(
        createProps({
          pairingPrompt: {
            kind: "approve",
            request,
            notify: false,
            bootstrapCommandOwner: false,
          },
        }),
      ),
    );

    expect(container.textContent).toContain("Notify the requester after approval");
    expect(container.textContent).toContain("Also make this sender the first command owner");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("links a channel account detail back to the filtered request queue", () => {
    const review = vi.fn();
    const container = renderInto(
      renderChannelPairingDetail("whatsapp", createProps({ onPairingReviewAccount: review })),
    );

    expect(container.textContent).toContain("1 pending");
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Review requests",
    );
    button?.click();
    expect(review).toHaveBeenCalledWith("whatsapp", "personal");
  });
});
