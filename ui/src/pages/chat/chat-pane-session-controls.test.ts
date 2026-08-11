/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

describe("chat pane composer controls", () => {
  it("renders only the model control", () => {
    const container = document.createElement("div");
    const state = {
      chatRunId: null,
      connected: true,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: { state: { modelOverrides: {} } },
      chatModelSwitchPromises: {},
      sessionKey: "main",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
    } as unknown as ChatPageHost;

    render(
      renderChatPaneComposerControls({
        state,
        selectedSession: undefined,
        agentDefaultModel: undefined,
        modelAccess: { allowed: true, requiredScope: "operator.write" },
        effortAccess: { allowed: true, requiredScope: "operator.write" },
      }),
      container,
    );

    expect(Array.from(container.children).map((node) => node.className)).toEqual([
      "chat-composer-model-control",
    ]);
    expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
  });
});
