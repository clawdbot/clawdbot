import { describe, expect, it } from "vitest";
import { createCodexSupervisorTools } from "./plugin-tools.js";
import type { CodexSupervisor } from "./supervisor.js";

function createSupervisorStub() {
  const calls: string[] = [];
  const supervisor = {
    listEndpoints: () => [
      {
        id: "prod",
        transport: "websocket",
        url: "wss://user:secret@example.invalid/control?token=hidden",
      },
    ],
    probeEndpoints: async () => [{ endpointId: "prod", ok: true }],
    listSessionSnapshot: async () => ({
      sessions: [
        {
          endpointId: "prod",
          threadId: "thread-1",
          status: "idle",
          preview: "secret prompt",
          name: "secret title",
        },
      ],
      errors: [{ endpointId: "down", ok: false, detail: "secret stderr" }],
    }),
    readSession: async () => ({
      thread: {
        id: "thread-1",
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345",
      },
    }),
    sendToSession: async (params: { mode?: string }) => {
      calls.push(`send:${params.mode ?? "auto"}`);
      return {
        endpointId: "prod",
        threadId: "thread-1",
        mode: "start" as const,
        turnId: "turn-1",
      };
    },
    interruptSession: async () => {
      calls.push("interrupt");
      return {
        endpointId: "prod",
        threadId: "thread-1",
        turnId: "turn-1",
      };
    },
  } satisfies Pick<
    CodexSupervisor,
    | "interruptSession"
    | "listEndpoints"
    | "listSessionSnapshot"
    | "probeEndpoints"
    | "readSession"
    | "sendToSession"
  >;
  return { calls, supervisor: supervisor as unknown as CodexSupervisor };
}

function toolByName(tools: ReturnType<typeof createCodexSupervisorTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

describe("createCodexSupervisorTools", () => {
  it("registers redacted read-only supervisor tools by default", async () => {
    const { supervisor } = createSupervisorStub();
    const tools = createCodexSupervisorTools({
      supervisor,
      policy: { allowRawTranscripts: false, allowWriteControls: false },
    });

    const probe = await toolByName(tools, "codex_endpoint_probe").execute("call-1", {});
    expect(probe.details).toMatchObject({
      summary: "codex endpoints: 1/1 ok",
      endpoints: [
        { id: "prod", transport: "websocket", url: "wss://example.invalid/control?[redacted]" },
      ],
    });

    const list = await toolByName(tools, "codex_sessions_list").execute("call-2", {});
    expect(list.details).toEqual({
      summary: "codex sessions: 1",
      sessions: [{ endpointId: "prod", threadId: "thread-1", status: "idle" }],
      errors: [{ endpointId: "down", ok: false }],
    });
  });

  it("gates transcript reads and write controls", async () => {
    const { supervisor } = createSupervisorStub();
    const tools = createCodexSupervisorTools({
      supervisor,
      policy: { allowRawTranscripts: false, allowWriteControls: false },
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("call-1", { thread_id: "thread-1" }),
    ).rejects.toThrow("Codex session reads are disabled");
    await expect(
      toolByName(tools, "codex_session_send").execute("call-2", {
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("Codex write controls are disabled");
  });

  it("allows trusted read and write tools when policy enables them", async () => {
    const { calls, supervisor } = createSupervisorStub();
    const tools = createCodexSupervisorTools({
      supervisor,
      policy: { allowRawTranscripts: true, allowWriteControls: true },
    });

    const read = await toolByName(tools, "codex_session_read").execute("call-1", {
      thread_id: "thread-1",
    });
    expect(read.details).toEqual({
      summary: "codex session: thread-1",
      response: { thread: { id: "thread-1", authorization: "[redacted]" } },
    });

    const sent = await toolByName(tools, "codex_session_send").execute("call-2", {
      thread_id: "thread-1",
      text: "continue",
      mode: "start",
    });
    expect(sent.details).toMatchObject({
      summary: "codex start: turn-1",
      result: { turnId: "turn-1" },
    });
    expect(calls).toEqual(["send:start"]);
  });
});
