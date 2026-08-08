import { describe, expect, it } from "vitest";
import {
  extractSpawnedAcpSessionKey,
  identityFromTurn,
  parseAdapterEvents,
  readAcpSessionIdFromRow,
  resolveResetCommand,
  sameAcpSession,
} from "../../scripts/acp-reset-timeout-proof.js";

describe("ACP reset timeout proof helpers", () => {
  it("parses complete JSONL events and ignores an incomplete trailing line", () => {
    const events = parseAdapterEvents(
      [
        JSON.stringify({
          at: "2026-07-30T00:00:00.000Z",
          event: "turn_end",
          instanceId: "adapter-1",
          pid: 10,
          sessionId: "session-1",
        }),
        '{"at":"incomplete"',
      ].join("\n"),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "turn_end", sessionId: "session-1" });
  });

  it("compares ACP ownership by session ID across adapter process reconnects", () => {
    const oldIdentity = identityFromTurn({
      at: "2026-07-30T00:00:00.000Z",
      event: "turn_end",
      instanceId: "adapter-old",
      pid: 10,
      sessionId: "session-old",
    });
    const reconnectedIdentity = { instanceId: "adapter-new", sessionId: "session-old" };
    const freshIdentity = { instanceId: "adapter-new", sessionId: "session-new" };

    expect(sameAcpSession(oldIdentity, reconnectedIdentity)).toBe(true);
    expect(sameAcpSession(oldIdentity, freshIdentity)).toBe(false);
  });

  it("reads the ACPX session ID from persistent manager metadata", () => {
    expect(
      readAcpSessionIdFromRow({
        identity_json: JSON.stringify({ state: "resolved", acpxSessionId: "session-fresh" }),
      }),
    ).toBe("session-fresh");
    expect(readAcpSessionIdFromRow({ identity_json: "not-json" })).toBe("");
  });

  it("extracts the dynamically spawned ACP session key from command history", () => {
    expect(
      extractSpawnedAcpSessionKey([
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Spawned ACP session agent:main:acp:session-1 (persistent, backend acpx). Bound this conversation to it.",
            },
          ],
        },
      ]),
    ).toBe("agent:main:acp:session-1");
  });

  it("covers both bound ACP reset command routes in the real proof", () => {
    expect(resolveResetCommand("late-turn")).toBe("/new");
    expect(resolveResetCommand("close-timeout")).toBe("/reset");
    expect(resolveResetCommand("cancel-timeout")).toBe("/reset");
    expect(resolveResetCommand("runtime-option-timeout")).toBe("/reset");
  });

  it("rejects turn events without an ACP session identity", () => {
    expect(() =>
      identityFromTurn({
        at: "2026-07-30T00:00:00.000Z",
        event: "turn_end",
        instanceId: "adapter-1",
        pid: 10,
      }),
    ).toThrow("missing sessionId");
  });
});
