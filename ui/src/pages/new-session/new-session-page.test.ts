import { render, type TemplateResult } from "lit";
import { describe, expect, it } from "vitest";
import type { PendingCloudRecoveryState, SubmissionOutcomeReason } from "./cloud-recovery-state.ts";
import type { CloudRecoveryRetirement } from "./cloud-submit.ts";
import "./new-session-page.ts";

type TestNewSessionPage = {
  pendingCloud: PendingCloudRecoveryState;
  renderDraftBlock(): TemplateResult;
  submissionOutcomeUnknown: SubmissionOutcomeReason | null;
  clearPendingCloudRecoveryFor(
    gatewayUrl: string,
    recoveryScope: string,
    sessionKey: string,
    retirement: CloudRecoveryRetirement,
  ): void;
  showCloudDraftOwnershipLost(): void;
};

describe("new session page outcomes", () => {
  it("renders the ownership-lost cloud outcome", () => {
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    const host = document.createElement("div");

    page.showCloudDraftOwnershipLost();
    render(page.renderDraftBlock(), host);

    expect(host.querySelector(".new-session-page__error")?.textContent).toContain(
      "Another window took over this cloud session. Check recent sessions before starting this task again.",
    );
  });

  it("preserves an interrupted outcome when retiring accepted delivery", () => {
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    const host = document.createElement("div");
    const gatewayUrl = "ws://gateway.example";
    const recoveryScope = "principal-a";
    const sessionKey = "agent:cloud:interrupted";
    page.pendingCloud.gatewayUrl = gatewayUrl;
    page.pendingCloud.recoveryScope = recoveryScope;
    page.pendingCloud.sessionKey = sessionKey;
    page.submissionOutcomeUnknown = "cloud-interrupted";

    page.clearPendingCloudRecoveryFor(gatewayUrl, recoveryScope, sessionKey, "interrupted");
    render(page.renderDraftBlock(), host);

    expect(page.pendingCloud.sessionKey).toBe("");
    expect(host.querySelector(".new-session-page__error")?.textContent).toContain(
      "This cloud session's setup was interrupted. Check recent sessions before starting this task again.",
    );
  });
});
