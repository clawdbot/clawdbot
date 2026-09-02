import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { agentsHandlers } from "./agents.js";

type HandlerCall = { ok: boolean; payload?: unknown; error?: unknown };

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("agents.files.get/set content hashes", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let workspace: string;

  beforeEach(() => {
    workspace = fs.realpathSync(tempDirs.make("openclaw-agent-files-"));
  });

  async function invokeAgentFilesHandler(
    method: "agents.files.get" | "agents.files.set",
    params: Record<string, unknown>,
  ): Promise<HandlerCall> {
    const calls: HandlerCall[] = [];
    await agentsHandlers[method]?.({
      req: { type: "req", id: method, method, params: {} },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        calls.push({ ok, payload, error });
      },
      context: {
        getRuntimeConfig: () => ({ agents: { defaults: { workspace } } }),
      } as never,
    });
    expect(calls).toHaveLength(1);
    return calls[0] as HandlerCall;
  }

  function readMemory(): string {
    return fs.readFileSync(path.join(workspace, "MEMORY.md"), "utf8");
  }

  it("returns the on-disk content hash from agents.files.get", async () => {
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# Memory\n");

    const call = await invokeAgentFilesHandler("agents.files.get", {
      agentId: "main",
      name: "MEMORY.md",
    });

    expect(call.ok).toBe(true);
    expect((call.payload as { file: { hash?: string } }).file.hash).toBe(hashContent("# Memory\n"));
  });

  it("refuses a stale expectedHash and keeps the lines written since the read", async () => {
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# Memory\n");
    const opened = await invokeAgentFilesHandler("agents.files.get", {
      agentId: "main",
      name: "MEMORY.md",
    });
    const openedHash = (opened.payload as { file: { hash: string } }).file.hash;
    fs.appendFileSync(path.join(workspace, "MEMORY.md"), "- agent learned a birthday\n");

    const call = await invokeAgentFilesHandler("agents.files.set", {
      agentId: "main",
      name: "MEMORY.md",
      content: "# Memory\n- operator note\n",
      expectedHash: openedHash,
    });

    expect(call.ok).toBe(false);
    expect((call.error as { details?: unknown }).details).toEqual({
      type: "agent_file_conflict",
      name: "MEMORY.md",
      currentHash: hashContent("# Memory\n- agent learned a birthday\n"),
    });
    expect(readMemory()).toBe("# Memory\n- agent learned a birthday\n");
  });

  it("writes when expectedHash matches the current file and returns the new hash", async () => {
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# Memory\n");

    const call = await invokeAgentFilesHandler("agents.files.set", {
      agentId: "main",
      name: "MEMORY.md",
      content: "# Memory\n- operator note\n",
      expectedHash: hashContent("# Memory\n"),
    });

    expect(call.ok).toBe(true);
    expect((call.payload as { file: { hash?: string } }).file.hash).toBe(
      hashContent("# Memory\n- operator note\n"),
    );
    expect(readMemory()).toBe("# Memory\n- operator note\n");
  });

  it("reports a conflict without currentHash when the expected file is gone", async () => {
    const call = await invokeAgentFilesHandler("agents.files.set", {
      agentId: "main",
      name: "MEMORY.md",
      content: "# Memory\n",
      expectedHash: hashContent("# Memory\n"),
    });

    expect(call.ok).toBe(false);
    expect((call.error as { details?: unknown }).details).toEqual({
      type: "agent_file_conflict",
      name: "MEMORY.md",
    });
    expect(fs.existsSync(path.join(workspace, "MEMORY.md"))).toBe(false);
  });

  it("keeps the unconditional overwrite when expectedHash is omitted", async () => {
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# Memory\n- agent learned a birthday\n");

    const call = await invokeAgentFilesHandler("agents.files.set", {
      agentId: "main",
      name: "MEMORY.md",
      content: "# Memory\n- operator note\n",
    });

    expect(call.ok).toBe(true);
    expect(readMemory()).toBe("# Memory\n- operator note\n");
  });

  it("admits only one of two concurrent saves that share an expectedHash", async () => {
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# Memory\n");
    const expectedHash = hashContent("# Memory\n");

    const [first, second] = await Promise.all([
      invokeAgentFilesHandler("agents.files.set", {
        agentId: "main",
        name: "MEMORY.md",
        content: "# Memory\n- first operator\n",
        expectedHash,
      }),
      invokeAgentFilesHandler("agents.files.set", {
        agentId: "main",
        name: "MEMORY.md",
        content: "# Memory\n- second operator\n",
        expectedHash,
      }),
    ]);

    const calls = [first, second];
    expect(calls.filter((call) => call.ok)).toHaveLength(1);
    const conflict = calls.find((call) => !call.ok)?.error as {
      details: { type: string; currentHash: string };
    };
    expect(conflict.details.type).toBe("agent_file_conflict");
    expect(["# Memory\n- first operator\n", "# Memory\n- second operator\n"]).toContain(
      readMemory(),
    );
    expect(conflict.details.currentHash).toBe(hashContent(readMemory()));
  });
});
