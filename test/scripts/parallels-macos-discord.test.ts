// Parallels macOS Discord tests cover host-side Discord API requests.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { runMock } = vi.hoisted(() => ({
  runMock: vi.fn(),
}));

vi.mock("../../scripts/e2e/parallels/host-command.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../scripts/e2e/parallels/host-command.ts")>();
  return {
    ...actual,
    run: runMock,
  };
});

import { MacosDiscordSmoke } from "../../scripts/e2e/parallels/macos-discord.ts";

describe("Parallels macOS Discord smoke", () => {
  it("bounds host Discord API connections, transfers, and processes", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "openclaw-parallels-macos-discord-"));
    await writeFile(path.join(runDir, "fresh.discord-sent-message-id"), "message-id\n", "utf8");
    runMock.mockReturnValue({ status: 0, stderr: "", stdout: "" });

    try {
      const smoke = new MacosDiscordSmoke({
        config: { channelId: "channel-id", guildId: "guild-id", token: "" },
        guest: {} as never,
        guestNode: "node",
        guestOpenClaw: "openclaw",
        guestOpenClawEntry: "openclaw.mjs",
        runDir,
        vmName: "macos-vm",
      });

      await smoke.cleanupMessages();

      expect(runMock).toHaveBeenCalledOnce();
      const [command, args, options] = runMock.mock.calls[0] ?? [];
      expect(command).toBe("curl");
      expect(args?.slice(0, 7)).toEqual([
        "-fsS",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "-X",
        "DELETE",
      ]);
      expect(args?.at(-1)).toBe(
        "https://discord.com/api/v10/channels/channel-id/messages/message-id",
      );
      expect(options).toEqual({ quiet: true, timeoutMs: 45_000 });
    } finally {
      await rm(runDir, { force: true, recursive: true });
    }
  });
});
