/** Tests model-facing descriptions selected from the final authorized tool set. */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "./channel-tool-metadata.js";
import {
  describeSessionsSearchTool,
  describeSessionsSendTool,
  describeSessionsSpawnTool,
} from "./tool-description-presets.js";
import { createConversationsSendTool } from "./tools/conversation-tools.js";

function findToolDescription(
  toolName: string,
  schedulerToolName?: "automations" | "cron",
  hasProcessTool = true,
) {
  const tools = withMockedPlatform("linux", () =>
    applyToolAvailabilityDescriptions([
      { name: "exec", description: "exec base" },
      ...(hasProcessTool ? [{ name: "process", description: "process base" }] : []),
      ...(schedulerToolName ? [{ name: schedulerToolName, description: "scheduler base" }] : []),
    ] as AnyAgentTool[]),
  );
  const tool = tools.find((entry) => entry.name === toolName);
  return {
    toolNames: tools.map((entry) => entry.name),
    description: tool?.description ?? "",
  };
}

describe("createOpenClawCodingTools availability guidance", () => {
  it.each(["automations", "cron"] as const)(
    "uses canonical automation guidance when %s survives filtering",
    (schedulerToolName) => {
      const exec = findToolDescription("exec", schedulerToolName);
      const process = findToolDescription("process", schedulerToolName);

      expect(exec.toolNames).toEqual(["exec", "process", schedulerToolName]);
      expect(exec.description).toBe(
        "Run shell now; background continuation supported. Use yieldMs/background, then process for logs/status/input/intervention. Long run: automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion. No sleep loops for reminders/follow-ups; use automations. TTY CLI/UI/coding agent: pty=true. Quote arguments containing shell metacharacters, including URL query strings with `?` or `&`.",
      );
      expect(process.description).toBe(
        "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill. poll/log: status, output, quiet success, completion without auto-wake, input hints. Others: input/intervention. No polling as timer/reminder; scheduled follow-up uses automations.",
      );
    },
  );

  it("drops automation guidance when the scheduler is unavailable", () => {
    const exec = findToolDescription("exec");
    const process = findToolDescription("process");

    expect(exec.toolNames).toEqual(["exec", "process"]);
    expect(exec.description).toBe(
      "Run shell now; background continuation supported. Use yieldMs/background, then process for logs/status/input/intervention. Long run: automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion. TTY CLI/UI/coding agent: pty=true. Quote arguments containing shell metacharacters, including URL query strings with `?` or `&`.",
    );
    expect(process.description).toBe(
      "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill. poll/log: status, output, quiet success, completion without auto-wake, input hints. Others: input/intervention.",
    );
  });

  it.each(["automations", "cron", undefined] as const)(
    "keeps shell-quoting guidance without process and with scheduler %s",
    (schedulerToolName) => {
      const exec = findToolDescription("exec", schedulerToolName, false);

      expect(exec.description).toBe(
        schedulerToolName
          ? "Run shell and wait for completion. No sleep loops for reminders/follow-ups; use automations. TTY CLI/UI/coding agent: pty=true. Quote arguments containing shell metacharacters, including URL query strings with `?` or `&`."
          : "Run shell and wait for completion. TTY CLI/UI/coding agent: pty=true. Quote arguments containing shell metacharacters, including URL query strings with `?` or `&`.",
      );
    },
  );

  it.each([
    { name: "process", description: "plugin process", available: [] },
    {
      name: "sessions_send",
      description: describeSessionsSendTool(),
      available: ["conversations_list", "conversations_send"],
    },
    {
      name: "sessions_search",
      description: describeSessionsSearchTool(),
      available: ["sessions_history"],
    },
    {
      name: "sessions_spawn",
      description: describeSessionsSpawnTool(),
      available: ["agents_list"],
    },
    {
      name: "conversations_send",
      description: createConversationsSendTool().description,
      available: ["conversations_list"],
    },
  ])(
    "preserves ownership metadata when replacing $name descriptions",
    ({ name, description, available }) => {
      const originalTool = {
        name,
        description,
      } as AnyAgentTool;
      setPluginToolMeta(originalTool, { pluginId: "example", optional: false });
      setChannelAgentToolMeta(originalTool as never, { channelId: "example-channel" });

      const [updated] = applyToolAvailabilityDescriptions([
        originalTool,
        ...available.map(
          (toolName) => ({ name: toolName, description: "available" }) as AnyAgentTool,
        ),
      ]);

      expect(updated).not.toBe(originalTool);
      expect(getPluginToolMeta(expectDefined(updated, "updated test invariant"))).toEqual({
        pluginId: "example",
        optional: false,
      });
      expect(getChannelAgentToolMeta(updated as never)).toEqual({
        channelId: "example-channel",
      });
    },
  );

  it("mentions sessions_spawn only when it survives tool filtering", () => {
    const withoutSpawn = applyToolAvailabilityDescriptions([
      { name: "agents_list", description: "base" },
      { name: "agents_wait", description: "base" },
    ] as AnyAgentTool[]);
    const withSpawn = applyToolAvailabilityDescriptions([
      ...withoutSpawn,
      { name: "sessions_spawn", description: "spawn" },
    ] as AnyAgentTool[]);

    for (const tool of withoutSpawn) {
      expect(tool.description).not.toContain("sessions_spawn");
    }
    for (const tool of withSpawn.filter((entry) => entry.name !== "sessions_spawn")) {
      expect(tool.description).toContain("sessions_spawn");
    }
  });

  it.each([
    {
      name: "sessions_send",
      description: describeSessionsSendTool(),
      unavailable: ["conversations_list", "conversations_send", "conversations_turn"],
    },
    {
      name: "sessions_search",
      description: describeSessionsSearchTool(),
      unavailable: ["sessions_history"],
    },
    {
      name: "sessions_spawn",
      description: describeSessionsSpawnTool({ swarmEnabled: true }),
      unavailable: ["agents_list", "agents_wait", "subagents", "sessions_history"],
    },
    {
      name: "conversations_send",
      description: createConversationsSendTool().description,
      unavailable: ["conversations_list"],
    },
  ])(
    "does not advertise unavailable follow-up tools from $name",
    ({ name, description, unavailable }) => {
      const [tool] = applyToolAvailabilityDescriptions([{ name, description } as AnyAgentTool]);

      for (const unavailableTool of unavailable) {
        expect(tool?.description).not.toContain(unavailableTool);
      }
    },
  );

  it.each([
    { available: [], expected: [] },
    { available: ["conversations_list"], expected: [] },
    { available: ["conversations_send"], expected: [] },
    {
      available: ["conversations_list", "conversations_send"],
      expected: ["conversations_list", "conversations_send"],
    },
    {
      available: ["conversations_list", "conversations_turn"],
      expected: ["conversations_list", "conversations_turn"],
    },
    {
      available: ["conversations_list", "conversations_send", "conversations_turn"],
      expected: ["conversations_list", "conversations_send", "conversations_turn"],
    },
  ])("describes only executable conversation routes: $available", ({ available, expected }) => {
    const [tool] = applyToolAvailabilityDescriptions([
      { name: "sessions_send", description: describeSessionsSendTool() },
      ...available.map((name) => ({ name, description: "available" })),
    ] as AnyAgentTool[]);

    for (const name of ["conversations_list", "conversations_send", "conversations_turn"]) {
      expect(tool?.description.includes(name)).toBe(expected.includes(name));
    }
  });

  it("preserves the existing fully authorized session-send description byte for byte", () => {
    const [tool] = applyToolAvailabilityDescriptions([
      { name: "sessions_send", description: describeSessionsSendTool() },
      { name: "conversations_list", description: "list" },
      { name: "conversations_send", description: "send" },
      { name: "conversations_turn", description: "turn" },
    ] as AnyAgentTool[]);

    expect(tool?.description).toBe(
      [
        "Run a visible session on this Gateway by sessionKey/label, or a configured local agent by agentId; sessionKey wins redundant label.",
        "A session identifies model context, not an external address; its reply may still announce through established delivery context.",
        'Accepted results report target admission as `targetDisposition: "queued"` or `"steered"`; `delivery.status` is only later announcement state, and neither proves target completion.',
        "For an exact external destination, use `conversations_list` plus `conversations_send`/`conversations_turn`.",
        'Thread chats rejected: target parent channel. Missing configured-agent main created. Waits for reply when available; status "no_reply" is terminal, so do not wait for an announcement.',
        "watch:true: notice arrives when others later change target session.",
      ].join(" "),
    );
  });

  it("keeps authorized history guidance and the prepared session URL", () => {
    const sessionLinkBase = "https://gateway.example/control";
    const [tool] = applyToolAvailabilityDescriptions([
      {
        name: "sessions_search",
        description: describeSessionsSearchTool({ sessionLinkBase }),
      },
      { name: "sessions_history", description: "history" },
    ] as AnyAgentTool[]);

    expect(tool?.description).toContain("Search visible past sessions");
    expect(tool?.description).toContain("sessions_history");
    expect(tool?.description).toContain(`${sessionLinkBase}/chat/<agentId>`);
    expect(tool?.description.indexOf("Follow up with sessions_history")).toBeLessThan(
      tool?.description.indexOf("When pointing the user at a session") ?? Infinity,
    );
  });

  it("restores conversation lookup guidance only when lookup is authorized", () => {
    const [tool] = applyToolAvailabilityDescriptions([
      createConversationsSendTool(),
      { name: "conversations_list", description: "lookup" } as AnyAgentTool,
    ]);

    expect(tool?.description).toBe(
      "Send directly through a conversationRef from conversations_list. This performs channel delivery; it does not run the local agent in the backing session.",
    );
  });

  it("keeps only authorized spawn follow-ups without losing prepared runtime facts", () => {
    const [tool] = applyToolAvailabilityDescriptions([
      {
        name: "sessions_spawn",
        description: describeSessionsSpawnTool({
          acpAvailable: false,
          threadAvailable: true,
          sessionToolsVisibility: "self",
          swarmEnabled: true,
        }),
      },
      { name: "agents_list", description: "agent lookup" },
      { name: "sessions_history", description: "history" },
    ] as AnyAgentTool[]);

    expect(tool?.description).toContain("configured agent (see agents_list);");
    expect(tool?.description).toContain("sessions_history");
    expect(tool?.description).not.toContain("agents_wait");
    expect(tool?.description).not.toContain("subagents");
    expect(tool?.description).toContain("persistent/thread-bound");
    expect(tool?.description).toContain("(self: current session only)");
    expect(tool?.description).not.toContain('runtime="acp"');
  });

  it("preserves original inline spawn guidance when every follow-up remains available", () => {
    const [tool] = applyToolAvailabilityDescriptions([
      {
        name: "sessions_spawn",
        description: describeSessionsSpawnTool({ acpAvailable: false, swarmEnabled: true }),
      },
      ...["agents_list", "agents_wait", "subagents", "sessions_history"].map((name) => ({
        name,
        description: "available",
      })),
    ] as AnyAgentTool[]);

    expect(tool?.description).toContain("configured agent (see agents_list);");
    expect(tool?.description).toContain("`groupId` groups a batch; await with agents_wait.");
    expect(tool?.description).toContain(
      "No spawn for quick lookup/single read. Check spawns via `subagents`/`sessions_history`. After spawn,",
    );
  });
});
