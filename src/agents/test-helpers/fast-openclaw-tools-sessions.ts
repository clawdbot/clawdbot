/**
 * Fast OpenClaw sessions-tool mocks.
 *
 * Stubs unrelated tool factories so sessions/subagent registration tests import cheaply.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { vi } from "vitest";
import { stubTool } from "./fast-tool-stubs.js";

vi.mock("../tools/agents-list-tool.js", () => ({
  createAgentsListTool: () => stubTool("agents_list"),
}));

vi.mock("../tools/cron-tool.js", () => ({
  createCronTool: () => stubTool("cron"),
}));

vi.mock("../tools/gateway-tool.js", () => ({
  createGatewayTool: () => stubTool("gateway"),
}));

vi.mock("../tools/message-tool.js", () => ({
  createMessageTool: () => stubTool("message"),
}));

vi.mock("../tools/music-generate-tool.js", () => ({
  createMusicGenerateTool: () => stubTool("music_generate"),
}));

vi.mock("../tools/nodes-tool.js", () => ({
  createNodesTool: () => stubTool("nodes"),
}));

vi.mock("../tools/pdf-tool.js", () => ({
  createPdfTool: () => stubTool("pdf"),
}));

vi.mock("../tools/session-status-tool.js", () => ({
  createSessionStatusTool: () => stubTool("session_status"),
}));

vi.mock("../tools/tts-tool.js", () => ({
  createTtsTool: () => stubTool("tts"),
}));

vi.mock("../tools/update-plan-tool.js", () => ({
  createUpdatePlanTool: () => stubTool("update_plan"),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => null,
  normalizeChannelId: (channel?: string) => normalizeOptionalLowercaseString(channel),
  listChannelPlugins: () => [],
}));

vi.mock("../../channels/plugins/session-conversation.js", () => ({
  resolveSessionConversationRef: (sessionKey: string) => {
    const match =
      /^(?:agent:[^:]+:)?(?<channel>[^:]+):(?<kind>group|channel):(?<id>[^:]+)(?::topic:(?<threadId>[^:]+))?$/u.exec(
        sessionKey.trim(),
      );
    if (!match?.groups?.channel || !match.groups.kind || !match.groups.id) {
      return null;
    }
    return {
      channel: match.groups.channel,
      kind: match.groups.kind,
      id: match.groups.id,
      threadId: match.groups.threadId,
    };
  },
}));
