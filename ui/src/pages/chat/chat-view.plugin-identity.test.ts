/* @vitest-environment jsdom */

import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { html, LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiSurface,
  ControlUiViewContext,
} from "../../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { renderChat, type ChatProps } from "./chat-view.ts";
import { renderGroupedMessage } from "./components/chat-message-bubble.ts";
import { threadProps } from "./components/chat-transcript.test-support.ts";

afterEach(() => resetComposerFixture());

describe("native chat view session identity", () => {
  it("passes the pane's raw global owner to transcript and tool replacements", async () => {
    const lifetime = new AbortController();
    const host = {
      signal: lifetime.signal,
      sessions: {},
      agents: {},
      navigation: {},
      ui: {},
      components: {},
    } as unknown as ControlUiHost;
    const replacements = new Map(
      (["transcript", "tool-result"] as const).map((surface) => [
        surface,
        {
          key: `identity/${surface}`,
          pluginId: "identity",
          signal: lifetime.signal,
          host,
          value: {
            id: surface,
            label: surface,
            surface,
            mount(container: HTMLElement, view: ControlUiViewContext<BoardGetParams>) {
              container.dataset.nativeOwner = surface;
              container.textContent = `${view.props.agentId}/${view.props.sessionKey}`;
            },
          },
        },
      ]),
    );
    const reportError = vi.fn();
    const context = {
      agentSelection: { state: { selectedId: "main" } },
      plugins: {
        registrations: () => [],
        selectedReplacement: (surface: ControlUiSurface) =>
          surface === "transcript" || surface === "tool-result"
            ? replacements.get(surface)
            : undefined,
        subscribe: () => () => undefined,
        reportError,
      },
    } as unknown as ApplicationContext;
    const provider = createApplicationContextProvider(context);
    const props: ChatProps = {
      ...threadProps("native-owner", "global", []),
      ...createComposerProps({
        paneId: "native-owner",
        sessionKey: "global",
        currentAgentId: "writer",
      }),
      transcript: createTestTranscript(),
      onSessionKeyChange: vi.fn(),
      thinkingLevel: null,
      error: null,
      approvalCanGrant: false,
      onRefresh: vi.fn(),
      agentsList: null,
      onAgentChange: vi.fn(),
    };
    class ChatHost extends LitElement {
      override createRenderRoot() {
        return this;
      }

      override render() {
        return html`${renderChat(props)}
        ${renderGroupedMessage(
          {
            role: "toolResult",
            toolCallId: "identity-result",
            toolName: "inspect",
            content: [{ type: "text", text: "Inspection complete" }],
          },
          "identity-message",
          {
            isStreaming: false,
            showReasoning: false,
            sessionKey: props.sessionKey,
            agentId: props.currentAgentId,
          },
        )}`;
      }
    }
    customElements.define("native-chat-owner-test-host", ChatHost);
    provider.append(document.createElement("native-chat-owner-test-host"));
    document.body.append(provider);

    await vi.waitFor(() => {
      expect(reportError).not.toHaveBeenCalled();
      expect(provider.querySelectorAll("[data-native-owner]")).toHaveLength(2);
    });
    expect(
      Object.fromEntries(
        [...provider.querySelectorAll<HTMLElement>("[data-native-owner]")].map((element) => [
          element.dataset.nativeOwner,
          element.textContent,
        ]),
      ),
    ).toEqual({ transcript: "writer/global", "tool-result": "writer/global" });
    expect(reportError).not.toHaveBeenCalled();
  });
});
