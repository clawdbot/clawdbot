import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const listProviderPairingRequests = vi.fn();
const approveProviderPairingCode = vi.fn();

vi.mock("../pairing/pairing-store.js", () => ({
  listProviderPairingRequests,
  approveProviderPairingCode,
}));

vi.mock("../telegram/send.js", () => ({
  sendMessageTelegram: vi.fn(),
}));

vi.mock("../discord/send.js", () => ({
  sendMessageDiscord: vi.fn(),
}));

vi.mock("../slack/send.js", () => ({
  sendMessageSlack: vi.fn(),
}));

vi.mock("../signal/send.js", () => ({
  sendMessageSignal: vi.fn(),
}));

vi.mock("../imessage/send.js", () => ({
  sendMessageIMessage: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

vi.mock("../telegram/token.js", () => ({
  resolveTelegramToken: vi.fn().mockReturnValue({ token: "t" }),
}));

describe("pairing cli", () => {
  it("labels Telegram ids as telegramUserId", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    listProviderPairingRequests.mockResolvedValueOnce([
      {
        id: "123",
        code: "ABC123",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
        meta: { username: "peter" },
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "list", "--provider", "telegram"], {
      from: "user",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("telegramUserId=123"),
    );
  });

  it("accepts provider as positional for list", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    listProviderPairingRequests.mockResolvedValueOnce([]);

    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "list", "telegram"], { from: "user" });

    expect(listProviderPairingRequests).toHaveBeenCalledWith("telegram");
  });

  it("labels Discord ids as discordUserId", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    listProviderPairingRequests.mockResolvedValueOnce([
      {
        id: "999",
        code: "DEF456",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
        meta: { tag: "Ada#0001" },
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "list", "--provider", "discord"], {
      from: "user",
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("discordUserId=999"),
    );
  });

  it("accepts provider as positional for approve (npm-run compatible)", async () => {
    const { registerPairingCli } = await import("./pairing-cli.js");
    approveProviderPairingCode.mockResolvedValueOnce({
      id: "123",
      entry: {
        id: "123",
        code: "ABCDEFGH",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
      },
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", "approve", "telegram", "ABCDEFGH"], {
      from: "user",
    });

    expect(approveProviderPairingCode).toHaveBeenCalledWith({
      provider: "telegram",
      code: "ABCDEFGH",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Approved"));
  });
});
