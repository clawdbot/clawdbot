// Tests gateway process argv parsing for diagnostics.
import { describe, expect, it } from "vitest";
import { isGatewayArgv, isOpenClawCommandArgv, parseProcCmdline } from "./gateway-process-argv.js";

describe("parseProcCmdline", () => {
  it("splits null-delimited argv and trims empty entries", () => {
    expect(parseProcCmdline(" node \0 gateway \0\0 --port \0 18789 \0")).toEqual([
      "node",
      "gateway",
      "--port",
      "18789",
    ]);
  });

  it("keeps non-delimited single arguments and drops whitespace-only entries", () => {
    expect(parseProcCmdline(" gateway ")).toEqual(["gateway"]);
    expect(parseProcCmdline(" \0\t\0 ")).toStrictEqual([]);
  });
});

describe("isGatewayArgv", () => {
  it("requires a gateway token", () => {
    expect(isGatewayArgv(["node", "dist/index.js", "--port", "18789"])).toBe(false);
  });

  it("matches known entrypoints across slash and case variants", () => {
    expect(isGatewayArgv(["NODE", "C:\\OpenClaw\\DIST\\ENTRY.JS", "gateway"])).toBe(true);
    expect(isGatewayArgv(["bun", "/srv/openclaw/scripts/run-node.mjs", "gateway"])).toBe(true);
    expect(isGatewayArgv(["node", "/srv/openclaw/openclaw.mjs", "gateway"])).toBe(true);
    expect(isGatewayArgv(["tsx", "/srv/openclaw/src/entry.ts", "gateway"])).toBe(true);
    expect(isGatewayArgv(["tsx", "/srv/openclaw/src/index.ts", "gateway"])).toBe(true);
  });

  it("matches the openclaw executable but gates the gateway binary behind the opt-in flag", () => {
    expect(isGatewayArgv(["C:\\bin\\openclaw.cmd", "gateway"])).toBe(true);
    expect(isGatewayArgv(["/usr/local/bin/openclaw-gateway", "gateway"])).toBe(false);
    expect(isGatewayArgv(["openclaw-gateway"])).toBe(false);
    expect(
      isGatewayArgv(["/usr/local/bin/openclaw-gateway", "gateway"], {
        allowGatewayBinary: true,
      }),
    ).toBe(true);
    expect(
      isGatewayArgv(["C:\\bin\\openclaw-gateway.EXE", "gateway"], {
        allowGatewayBinary: true,
      }),
    ).toBe(true);
    expect(isGatewayArgv(["openclaw-gateway"], { allowGatewayBinary: true })).toBe(true);
  });

  it("rejects unknown gateway argv even when the token is present", () => {
    expect(isGatewayArgv(["node", "/srv/openclaw/custom.js", "gateway"])).toBe(false);
    expect(isGatewayArgv(["python", "gateway", "script.py"])).toBe(false);
  });
});

describe("isOpenClawCommandArgv", () => {
  it("matches doctor across source, built, and installed entrypoints", () => {
    expect(isOpenClawCommandArgv(["node", "/srv/openclaw/openclaw.mjs", "doctor"], "doctor")).toBe(
      true,
    );
    expect(
      isOpenClawCommandArgv(["NODE", "C:\\OpenClaw\\DIST\\ENTRY.JS", "DOCTOR"], "doctor"),
    ).toBe(true);
    expect(isOpenClawCommandArgv(["C:\\bin\\openclaw.cmd", "doctor", "--fix"], "doctor")).toBe(
      true,
    );
  });

  it("rejects other OpenClaw commands and unrelated doctor processes", () => {
    expect(isOpenClawCommandArgv(["openclaw", "gateway"], "doctor")).toBe(false);
    expect(isOpenClawCommandArgv(["python", "doctor", "worker.py"], "doctor")).toBe(false);
  });
});
