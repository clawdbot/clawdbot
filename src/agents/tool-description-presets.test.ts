import { describe, expect, it } from "vitest";
import {
  describeAskUserTool,
  describeSessionsHistoryTool,
  describeSessionsListTool,
  describeSessionsSearchTool,
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "./tool-description-presets.js";

describe("ask_user tool guidance", () => {
  it("keeps native-control requirements visible to the model", () => {
    const description = describeAskUserTool();

    expect(description).toContain("exactly one question per call");
    expect(description).toContain("native controls");
    expect(description).toContain("Put every selectable choice in `options`");
    expect(description).toContain("Use `multiSelect` only");
  });
});

const SESSION_LINK_BASE = "http://127.0.0.1:18789/control";
const SESSION_LINK_LINE =
  "When pointing the user at a session, cite its Control UI URL: main session -> `http://127.0.0.1:18789/control/chat/<agentId>`; any other display session key -> `http://127.0.0.1:18789/control/chat/<agentId>/~key/` + key minus `agent:<agentId>:`, with `:` replaced by `/`.";
const SESSION_DESCRIPTIONS = [
  {
    tool: "sessions_list",
    describe: describeSessionsListTool,
    original:
      "List visible sessions and sidebar categories; filter kind/label/agentId/search/activity/archive. Preview recent messages inline via includeLastMessage/messageLimit; includeDerivedTitles adds derived titles. Use before history/send target selection.",
  },
  {
    tool: "sessions_history",
    describe: describeSessionsHistoryTool,
    original:
      "Read sanitized visible-session history. Before reply/debug/resume. Supports limit, offset, search-result sessionId/messageId anchors, and tool messages.",
  },
  {
    tool: "sessions_search",
    describe: describeSessionsSearchTool,
    original: "Search your own past sessions for matching user and assistant text.",
  },
] as const;

describe("session tool link guidance", () => {
  it.each(SESSION_DESCRIPTIONS)("keeps $tool bytes unchanged without a link base", (entry) => {
    expect(entry.describe()).toBe(entry.original);
  });

  it.each(SESSION_DESCRIPTIONS)("appends the shared link rule to $tool", (entry) => {
    expect(entry.describe({ sessionLinkBase: SESSION_LINK_BASE })).toBe(
      `${entry.original} ${SESSION_LINK_LINE}`,
    );
  });
});

describe("sessions_send tool description", () => {
  it("distinguishes local context selection from exact external addressing", () => {
    expect(SESSIONS_SEND_TOOL_DISPLAY_SUMMARY).toContain("same-Gateway");
    expect(describeSessionsSendTool()).toContain("on this Gateway");
    expect(describeSessionsSendTool()).toContain("not an external address");
    expect(describeSessionsSendTool()).not.toContain("conversations_");
    expect(describeSessionsSendTool()).toContain("reply may still announce");
  });
});
