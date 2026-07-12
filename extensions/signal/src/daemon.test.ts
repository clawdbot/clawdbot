// Signal tests cover daemon plugin behavior.
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
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

  it("preserves log lines and UTF-8 across output chunk boundaries", async () => {
    const stream = new PassThrough();
    const logs: string[] = [];
    const errors: string[] = [];
    testApi.bindSignalCliOutput({
      stream,
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    });

    const ended = once(stream, "end");
    stream.write(Buffer.from("ER"));
    stream.write(
      Buffer.from("ROR DaemonCommand - startup failed\r\nWARN Manager - retrying\npartial"),
    );
    stream.write(" warning\n");
    const utf8Line = Buffer.from("INFO Manager - café ready");
    const splitCodePointAt = utf8Line.indexOf(0xc3) + 1;
    stream.write(utf8Line.subarray(0, splitCodePointAt));
    stream.end(utf8Line.subarray(splitCodePointAt));
    await ended;

    expect(errors).toEqual(["signal-cli: ERROR DaemonCommand - startup failed"]);
    expect(logs).toEqual([
      "signal-cli: WARN Manager - retrying",
      "signal-cli: partial warning",
      "signal-cli: INFO Manager - café ready",
    ]);
  });
});
