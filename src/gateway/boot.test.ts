import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const agentCommand = vi.fn();

vi.mock("../commands/agent.js", () => ({ agentCommand }));

const { runBootOnce } = await import("./boot.js");
const { resolveMainSessionKey } = await import("../config/sessions/main-session.js");

describe("runBootOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeDeps = () => ({
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSlack: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  });

  it("skips when BOOT.md is missing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-boot-"));
    await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
      status: "skipped",
      reason: "missing",
    });
    expect(agentCommand).not.toHaveBeenCalled();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("skips when BOOT.md is empty", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-boot-"));
    await fs.writeFile(path.join(workspaceDir, "BOOT.md"), "   \n", "utf-8");
    await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
      status: "skipped",
      reason: "empty",
    });
    expect(agentCommand).not.toHaveBeenCalled();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("runs agent command when BOOT.md exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-boot-"));
    const content = "Say hello when you wake up.";
    await fs.writeFile(path.join(workspaceDir, "BOOT.md"), content, "utf-8");

    agentCommand.mockResolvedValue(undefined);
    await expect(runBootOnce({ cfg: {}, deps: makeDeps(), workspaceDir })).resolves.toEqual({
      status: "ran",
    });

    expect(agentCommand).toHaveBeenCalledTimes(1);
    const call = agentCommand.mock.calls[0]?.[0];
    expect(call).toEqual(
      expect.objectContaining({
        deliver: false,
        sessionKey: resolveMainSessionKey({}),
      }),
    );
    expect(call?.message).toContain("BOOT.md:");
    expect(call?.message).toContain(content);
    expect(call?.message).toContain("NO_REPLY");

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });
});
