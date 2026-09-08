import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createChatRunState } from "../server-chat-state.js";
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import type { AgentTurnContext } from "./types.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  await state?.cleanup();
});

it.each(["main", "work"])(
  "admits images using the explicit %s global session owner",
  async (agentId) => {
    state = await createOpenClawTestState({ label: "agent-content-owner" });
    const { stateDir, workspaceDir } = state;
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { model: "mock-openai/main-vision" },
          work: { model: "mock-openai/work-vision" },
        },
        defaults: { workspace: state.workspaceDir },
      },
      plugins: { enabled: false },
      session: { scope: "global" },
    };
    await state.writeConfig(cfg);
    const loadGatewayModelCatalogSnapshot = vi.fn<
      AgentTurnContext["loadGatewayModelCatalogSnapshot"]
    >(async (params) => ({
      agentId: params?.agentId ?? agentId,
      agentDir: stateDir,
      workspaceDir,
      catalogComplete: true,
      config: cfg,
      entries: [
        {
          id: `${params?.agentId}-vision`,
          name: "Synthetic vision model",
          provider: "mock-openai",
          input: ["text", "image"],
        } satisfies ModelCatalogEntry,
      ],
      routeVariants: [],
    }));
    const context: AgentTurnContext = {
      addChatRun: vi.fn(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
      deps: {},
      getRuntimeConfig: () => cfg,
      getSessionEventSubscriberConnIds: () => new Set(),
      loadGatewayModelCatalog: vi.fn(async () => []),
      loadGatewayModelCatalogSnapshot,
      logGateway: createSubsystemLogger("test/agent-content"),
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(() => undefined),
    };
    const respond = vi.fn();
    const result = await prepareAgentContentPhase({
      request: {
        message: "Inspect this synthetic pixel",
        agentId,
        sessionKey: "global",
        idempotencyKey: `image-${agentId}`,
      },
      cfg,
      context,
      respond,
      isRawModelRun: false,
      requestedSessionKeyRaw: "global",
      requestedSessionKey: "global",
      agentId,
      knownAgents: ["main", "work"],
      normalizedAttachments: [
        {
          type: "file",
          mimeType: "image/png",
          fileName: "pixel.png",
          content:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      ],
    });
    expect(respond).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId,
      requestedSessionKey: "global",
      images: [expect.objectContaining({ mimeType: "image/png" })],
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledExactlyOnceWith({
      agentId,
      readOnly: true,
    });
  },
);
