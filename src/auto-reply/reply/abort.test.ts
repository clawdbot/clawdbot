import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../../config/config.js";
import { isAbortTrigger } from "./abort.js";
import { initSessionState } from "./session.js";

describe("abort detection", () => {
  it("triggerBodyNormalized extracts /stop from RawBody for abort detection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-abort-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as ClawdbotConfig;

    const groupMessageCtx = {
      Body: `[Context]\nJake: /stop\n[from: Jake]`,
      RawBody: "/stop",
      ChatType: "group",
      SessionKey: "agent:main:whatsapp:group:G1",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    // /stop is detected via exact match in handleAbort, not isAbortTrigger
    expect(result.triggerBodyNormalized).toBe("/stop");
  });

  it("isAbortTrigger matches bare word triggers (without slash)", () => {
    expect(isAbortTrigger("stop")).toBe(true);
    expect(isAbortTrigger("esc")).toBe(true);
    expect(isAbortTrigger("abort")).toBe(true);
    expect(isAbortTrigger("wait")).toBe(true);
    expect(isAbortTrigger("exit")).toBe(true);
    expect(isAbortTrigger("hello")).toBe(false);
    // /stop is NOT matched by isAbortTrigger - it's handled separately
    expect(isAbortTrigger("/stop")).toBe(false);
  });
});
