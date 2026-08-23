import { describe, expect, it } from "vitest";
import { isConfigMachineOutput, isConfigSetJsonParseOnly } from "./config-output-mode.js";
import { isCronMachineOutput } from "./cron-cli/output-mode.js";
import { isDoctorMachineOutput } from "./doctor-output-mode.js";
import { isGatewayMachineOutput } from "./gateway-cli/output-mode.js";
import { isMachineOutputStdoutTTY } from "./machine-output-argv.js";
import { isProxyMachineOutput } from "./proxy-output-mode.js";
import { isSkillsMachineOutput } from "./skills-output-mode.js";
import { isSystemMachineOutput } from "./system-output-mode.js";

describe("built-in machine-output resolvers", () => {
  it("normalizes missing stdout TTY metadata to false", () => {
    expect(isMachineOutputStdoutTTY({})).toBe(false);
    expect(isMachineOutputStdoutTTY({ isTTY: false })).toBe(false);
    expect(isMachineOutputStdoutTTY({ isTTY: true })).toBe(true);
  });

  it.each([
    ["heartbeat last", ["system", "heartbeat", "last"]],
    ["heartbeat enable", ["system", "heartbeat", "enable"]],
    ["heartbeat disable", ["system", "heartbeat", "disable"]],
    ["presence", ["system", "presence"]],
  ])("detects system %s", (_name, path) => {
    expect(isSystemMachineOutput(["node", "openclaw", ...path])).toBe(true);
  });

  it("detects non-TTY doctor lint without changing terminal output", () => {
    const argv = ["node", "openclaw", "doctor", "--lint"];
    expect(isDoctorMachineOutput({ argv, stdoutIsTTY: false })).toBe(true);
    expect(isDoctorMachineOutput({ argv, stdoutIsTTY: true })).toBe(false);
  });

  it.each(["blob", "coverage", "purge", "query", "sessions"])(
    "detects proxy %s output",
    (command) => {
      expect(isProxyMachineOutput(["node", "openclaw", "proxy", command])).toBe(true);
    },
  );

  it("accepts supported root options after the command root", () => {
    expect(
      isProxyMachineOutput(["node", "openclaw", "proxy", "--log-level", "debug", "sessions"]),
    ).toBe(true);
    expect(
      isSkillsMachineOutput(["node", "openclaw", "skills", "--log-level", "debug", "verify", "x"]),
    ).toBe(true);
    expect(
      isGatewayMachineOutput([
        "node",
        "openclaw",
        "gateway",
        "--log-level",
        "debug",
        "restart-handoff",
        "capabilities",
      ]),
    ).toBe(true);
    expect(
      isGatewayMachineOutput([
        "node",
        "openclaw",
        "gateway",
        "--log-level=debug",
        "restart-handoff",
        "consume",
      ]),
    ).toBe(true);
  });

  it("reserves raw cron scratch output", () => {
    expect(isCronMachineOutput(["node", "openclaw", "cron", "scratch", "job"])).toBe(true);
  });

  it.each(["get", "file", "schema"])("reserves config %s machine output", (subcommand) => {
    expect(isConfigMachineOutput(["node", "openclaw", "config", subcommand])).toBe(true);
    expect(
      isConfigMachineOutput(["node", "openclaw", "config", "--section", "agents", subcommand]),
    ).toBe(true);
  });

  it("treats config set --json as parse-only except for JSON dry-run reports", () => {
    expect(isConfigMachineOutput(["node", "openclaw", "config", "set", "gateway.port"])).toBe(
      false,
    );
    expect(
      isConfigSetJsonParseOnly([
        "node",
        "openclaw",
        "config",
        "set",
        "gateway.port",
        "18789",
        "--json",
      ]),
    ).toBe(true);
    expect(
      isConfigSetJsonParseOnly([
        "node",
        "openclaw",
        "config",
        "set",
        "gateway.port",
        "18789",
        "--dry-run",
        "--json",
      ]),
    ).toBe(false);
  });

  it("finds agent-scoped skill verification", () => {
    expect(
      isSkillsMachineOutput([
        "node",
        "openclaw",
        "skills",
        "--agent",
        "main",
        "verify",
        "@owner/skill",
      ]),
    ).toBe(true);
  });
});
