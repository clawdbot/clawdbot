import { describe, expect, it } from "vitest";

import { stripRedundantSubsystemPrefixForConsole } from "../logging.js";

describe("stripRedundantSubsystemPrefixForConsole", () => {
  it("drops '<subsystem>:' prefix", () => {
    expect(
      stripRedundantSubsystemPrefixForConsole("discord: hello", "discord"),
    ).toBe("hello");
  });

  it("drops '<Subsystem>:' prefix case-insensitively", () => {
    expect(
      stripRedundantSubsystemPrefixForConsole("WhatsApp: hello", "whatsapp"),
    ).toBe("hello");
  });

  it("drops '<subsystem> ' prefix", () => {
    expect(
      stripRedundantSubsystemPrefixForConsole(
        "discord gateway: closed",
        "discord",
      ),
    ).toBe("gateway: closed");
  });

  it("drops '[subsystem]' prefix", () => {
    expect(
      stripRedundantSubsystemPrefixForConsole(
        "[discord] connection stalled",
        "discord",
      ),
    ).toBe("connection stalled");
  });

  it("keeps messages that do not start with the subsystem", () => {
    expect(
      stripRedundantSubsystemPrefixForConsole("discordant: hello", "discord"),
    ).toBe("discordant: hello");
  });
});
