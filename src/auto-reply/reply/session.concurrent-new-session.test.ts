import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState as initSessionStateRaw } from "./session.js";

const initSessionState = (
  params: Omit<Parameters<typeof initSessionStateRaw>[0], "ctx"> & {
    ctx: Record<string, unknown>;
  },
) => initSessionStateRaw({ ...params, ctx: finalizeInboundContext(params.ctx) });

describe("initSessionState concurrent new-session convergence (#113327)", () => {
  it("resolves concurrent brand-new dispatches for one key to a single sessionId", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-converge-"));
    try {
      const cfg = {
        session: { store: path.join(root, "sessions.json") },
      } as OpenClawConfig;
      const sessionKey = "agent:main:telegram:chat:777";
      const dispatch = (body: string) =>
        initSessionState({
          cfg,
          commandAuthorized: true,
          ctx: {
            Body: body,
            SessionKey: sessionKey,
            ChatType: "direct",
            OriginatingChannel: "telegram",
          },
        });

      // Rapid multi-part messages to a brand-new session, dispatched in parallel
      // (Telegram has no grammY sequentialize), previously each minted their own
      // sessionId and forked the conversation into parallel runs with duplicate
      // acknowledgements under different session IDs. The exclusive store-write
      // lock plus init-conflict retry now serialize resolution.
      const [first, second] = await Promise.all([dispatch("first"), dispatch("second")]);

      expect(first.sessionKey).toBe(sessionKey);
      expect(second.sessionKey).toBe(sessionKey);
      // Both messages belong to one conversation → one sessionId.
      expect(second.sessionId).toBe(first.sessionId);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("keeps distinct keys distinct when dispatched in parallel", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-distinct-"));
    try {
      const cfg = {
        session: { store: path.join(root, "sessions.json") },
      } as OpenClawConfig;
      const dispatch = (sessionKey: string) =>
        initSessionState({
          cfg,
          commandAuthorized: true,
          ctx: {
            Body: "hello",
            SessionKey: sessionKey,
            ChatType: "direct",
            OriginatingChannel: "telegram",
          },
        });

      const [a, b] = await Promise.all([
        dispatch("agent:main:telegram:chat:100"),
        dispatch("agent:main:telegram:chat:200"),
      ]);

      expect(a.sessionKey).not.toBe(b.sessionKey);
      expect(a.sessionId).not.toBe(b.sessionId);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
