import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testApi } from "./daemon.js";

describe("signal daemon args", () => {
  it("expands home-relative configPath before passing it to signal-cli", () => {
    expect(
      testApi.buildDaemonArgs({
        cliPath: "signal-cli",
        configPath: "~/.openclaw/signal-cli",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toEqual([
      "--config",
      path.join(os.homedir(), ".openclaw/signal-cli"),
      "daemon",
      "--http",
      "127.0.0.1:8080",
      "--no-receive-stdout",
    ]);
  });
});

describe("signal daemon log classification", () => {
  it("keeps routine signal-cli warnings out of error state", () => {
    expect(
      testApi.classifySignalCliLogLine(
        "WARN  ManagerImpl - No profile name set. When sending a message it's recommended to set a profile name.",
      ),
    ).toBe("log");
  });

  it("keeps recoverable prekey decrypt receive failures out of error state", () => {
    expect(
      testApi.classifySignalCliLogLine(
        "receive exception: org.signal.libsignal.protocol.InvalidMessageException: invalid PreKey message: decryption failed",
      ),
    ).toBe("log");
  });

  it("still surfaces signal-cli failures as errors", () => {
    expect(testApi.classifySignalCliLogLine("ERROR DaemonCommand - startup failed")).toBe("error");
    expect(testApi.classifySignalCliLogLine("SEVERE Manager - database exception")).toBe("error");
  });
});
