import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import type { WorkboardSessionResolution } from "../../lib/workboard/session-resolution.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { renderCardDetailsPanel } from "./view-card-details.ts";
import type { WorkboardProps } from "./view-helpers.ts";

function renderDetails(card: WorkboardCard, overrides: Partial<WorkboardProps> = {}) {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [card];
  state.detailCardId = card.id;
  const props: WorkboardProps = {
    host,
    client: null,
    connected: true,
    canWrite: true,
    agentsList: null,
    sessions: [],
    onOpenSession: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  workboardTestHost().connection.connected = true;
  render(renderCardDetailsPanel(props), container);
  return { state, props, container };
}

describe("Workboard card execution actions", () => {
  it.each([
    { key: "agent:writer:existing", status: "unknown", canOpen: true },
    { key: "agent:writer:existing", status: "unavailable", canOpen: true },
    { key: "subagent:workboard-default-card-1", status: "unknown", canOpen: false },
    { key: "subagent:workboard-default-card-1", status: "ambiguous", canOpen: false },
    { key: "global", status: "unknown", canOpen: false },
    { key: "unknown", status: "unknown", canOpen: false },
  ] as const)(
    "keeps Edit recovery without replacement Start for $status link $key",
    ({ key, status, canOpen }) => {
      const card = createWorkboardCard({ sessionKey: key });
      const resolution: WorkboardSessionResolution = { key, status };
      const { container, state, props } = renderDetails(card, { sessionResolution: resolution });
      const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open session"]');
      if (canOpen) {
        expectDefined(open, "canonical session action").click();
        expect(props.onOpenSession).toHaveBeenCalledWith({ sessionKey: key });
      } else {
        expect(open).toBeNull();
      }
      expectDefined(
        container.querySelector<HTMLButtonElement>('button[aria-label="Edit card"]'),
        "link recovery action",
      ).click();
      expect(state.draftOpen).toBe(true);
      expect(state.draftSessionKey).toBe(key);
      expect(container.querySelectorAll(".workboard-card__start")).toHaveLength(0);
    },
  );

  it.each([
    {
      key: "subagent:workboard-default-card-1",
      sessionKey: "agent:writer:subagent:workboard-default-card-1",
    },
    { key: "agent:writer:existing", sessionKey: "agent:writer:existing", agentId: "writer" },
  ])(
    "stops the resolved $key owner after the card is reassigned",
    async ({ key, sessionKey, agentId }) => {
      const session = createGatewaySession({
        key: sessionKey,
        ...(agentId ? { agentId } : {}),
      });
      const card = createWorkboardCard({
        agentId: "main",
        sessionKey: key,
        status: "running",
        runId: "writer-run",
      });
      const blocked = { ...card, status: "blocked", updatedAt: 2 };
      let aborts = 0;
      const client = createWorkboardTestClient((method) => {
        if (method === "chat.abort") {
          aborts += 1;
          return { aborted: !agentId || aborts > 1 };
        }
        if (method === "workboard.cards.update") {
          return { card: blocked };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { container, state } = renderDetails(card, {
        client,
        sessionResolution: { key, status: "resolved", session },
      });

      expectDefined(
        container.querySelector<HTMLButtonElement>('button[aria-label="Stop session"]'),
        "resolved execution stop action",
      ).click();
      await waitForFast(() => expect(state.cards[0]?.status).toBe("blocked"));

      expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
        sessionKey: session.key,
        ...(agentId ? { agentId } : {}),
        runId: "writer-run",
      });
      if (agentId) {
        expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", { sessionKey, agentId });
      }
      expect(state.error).toBeNull();
    },
  );

  it.each(["start", "stop"] as const)(
    "rejects a retained %s action after the card link changes",
    async (action) => {
      const session = createGatewaySession({ key: "agent:writer:original" });
      const card = createWorkboardCard(
        action === "stop" ? { sessionKey: session.key, status: "running" } : {},
      );
      const client = createWorkboardTestClient(() => {
        throw new Error("A retained action cannot operate on the replacement card");
      });
      const { container, state } = renderDetails(card, { client, sessions: [session] });
      const button = expectDefined(
        container.querySelector<HTMLButtonElement>(
          action === "start"
            ? ".workboard-card__start--manual"
            : 'button[aria-label="Stop session"]',
        ),
        "original card action",
      );
      const successor = {
        ...card,
        updatedAt: card.updatedAt + 1,
        sessionKey: "agent:writer:replacement",
      };
      state.cards = [successor];
      button.click();
      await waitForFast(() => expect(state.error).toBeTruthy());

      expect(client.request).not.toHaveBeenCalled();
      expect(state.cards).toEqual([successor]);
      expect(state.busyCardIds.size).toBe(0);
    },
  );
});
