// Exact-head Gateway proof: agents.update null/empty clears emoji/avatar in
// config and removes parser-accepted unbulleted IDENTITY.md labels.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "../test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("agents.update clear identity gateway", () => {
  let started: Awaited<ReturnType<typeof startServerWithClient>> | undefined;
  let workspaceDir = "";
  const token = "proof-agents-clear-identity-token";

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agents-clear-id-"));
    started = await startServerWithClient(token);
    await connectOk(started.ws);
  }, 120_000);

  afterAll(async () => {
    if (started) {
      started.ws.close();
      await started.server.close().catch(() => undefined);
      started.envSnapshot.restore();
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("null emoji/avatar clears config and unbulleted IDENTITY.md fields", async () => {
    expect(started).toBeDefined();
    const ws = started!.ws;
    const agentWorkspace = path.join(workspaceDir, "clear-id-agent");
    await fs.mkdir(agentWorkspace, { recursive: true });

    const created = await rpcReq<{ ok: boolean; agentId: string }>(ws, "agents.create", {
      name: "Clear Identity Agent",
      workspace: agentWorkspace,
      emoji: "🐢",
      avatar: "https://example.com/avatar.png",
    });
    expect(created.ok).toBe(true);
    const agentId = created.payload?.agentId;
    expect(agentId).toBeTruthy();

    // Parser-accepted unbulleted form that the writer previously failed to clear.
    await fs.writeFile(
      path.join(agentWorkspace, "IDENTITY.md"),
      [
        "# IDENTITY.md - Agent Identity",
        "",
        "Name: Clear Identity Agent",
        "Emoji: 🐢",
        "Avatar: https://example.com/avatar.png",
        "Creature: Familiar",
        "",
      ].join("\n"),
      "utf8",
    );

    const cleared = await rpcReq<{ ok: boolean; agentId: string }>(ws, "agents.update", {
      agentId,
      emoji: null,
      avatar: null,
    });
    expect(cleared.ok).toBe(true);

    const listed = await rpcReq<{
      agents: Array<{ id: string; identity?: { emoji?: string; avatar?: string; name?: string } }>;
    }>(ws, "agents.list", {});
    expect(listed.ok).toBe(true);
    const agent = listed.payload?.agents.find((entry) => entry.id === agentId);
    expect(agent?.identity?.emoji).toBeUndefined();
    expect(agent?.identity?.avatar).toBeUndefined();

    const identityAfter = await fs.readFile(path.join(agentWorkspace, "IDENTITY.md"), "utf8");
    expect(identityAfter).toContain("Creature: Familiar");
    expect(identityAfter).not.toMatch(/Emoji\s*:/);
    expect(identityAfter).not.toMatch(/Avatar\s*:/);
  }, 120_000);
});
