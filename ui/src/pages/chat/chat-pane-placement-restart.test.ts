/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createModalDialogTestFixture } from "../../test-helpers/modal-dialog.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;

beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});

afterEach(() => dialogs.cleanup());

describe("chat pane placement restart", () => {
  it("restarts a failed placement on a selected profile without creating a session", async () => {
    const request = dialogs.mockRequest(async (method: string) => {
      if (method === "environments.list") {
        return {
          profiles: [{ id: "aws", providerId: "crabbox" }],
          environments: [],
        };
      }
      return { ok: true };
    });
    const refreshReplacement = vi.fn(async () => undefined);
    const { pane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: { refreshReplacement } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      features: { methods: ["sessions.dispatch"] },
      auth: {
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      },
    } as never;
    const session: GatewaySessionRow = {
      key: "agent:main:failed-worker",
      label: "Failed worker session",
      kind: "direct",
      updatedAt: 0,
      placement: {
        state: "failed",
        generation: 2,
        createdAtMs: 1,
        updatedAtMs: 2,
        stateChangedAtMs: 2,
        recoveryError: "worker disappeared",
        recoveryAction: "restart",
      },
    };

    const restarting = dialogs.track(pane.restartHeaderPlacement(session));
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain(
      "Changes that the previous worker did not upload may be lost.",
    );
    document.body.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]')?.click();
    const restartButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Restart session",
    );
    restartButton?.click();
    await restarting;

    expect(request).toHaveBeenCalledWith("sessions.dispatch", {
      key: session.key,
      agentId: "main",
      profileId: "aws",
    });
    expect(request.mock.calls.some(([method]) => method === "sessions.create")).toBe(false);
    expect(refreshReplacement).toHaveBeenCalledWith("main");
  });
});
