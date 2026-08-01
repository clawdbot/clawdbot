// Argv invocation tests cover CLI argv normalization before command dispatch.
import { describe, expect, it } from "vitest";
import { resolveCliArgvInvocation } from "./argv-invocation.js";

describe("argv-invocation", () => {
  it("resolves root help and empty command path", () => {
    expect(resolveCliArgvInvocation(["node", "openclaw", "--help"])).toEqual({
      argv: ["node", "openclaw", "--help"],
      commandPath: [],
      primary: null,
      hasHelpOrVersion: true,
      isRootHelpInvocation: true,
    });
  });

  it("resolves command path and primary with root options", () => {
    expect(
      resolveCliArgvInvocation(["node", "openclaw", "--profile", "work", "gateway", "status"]),
    ).toEqual({
      argv: ["node", "openclaw", "--profile", "work", "gateway", "status"],
      commandPath: ["gateway", "status"],
      primary: "gateway",
      hasHelpOrVersion: false,
      isRootHelpInvocation: false,
    });
  });

  it.each([
    {
      name: "version-pinned install",
      argv: ["node", "openclaw", "skills", "install", "@owner/weather", "--version", "1.2.3"],
      commandPath: ["skills", "install"],
    },
    {
      name: "version-pinned verification",
      argv: ["node", "openclaw", "skills", "verify", "@owner/weather", "--version", "1.2.3"],
      commandPath: ["skills", "verify"],
    },
    {
      name: "equals-form version-pinned install",
      argv: ["node", "openclaw", "skills", "install", "@owner/weather", "--version=1.2.3"],
      commandPath: ["skills", "install"],
    },
    {
      name: "profiled version-pinned verification",
      argv: [
        "node",
        "openclaw",
        "--profile",
        "work",
        "skills",
        "verify",
        "@owner/weather",
        "--version",
        "1.2.3",
      ],
      commandPath: ["skills", "verify"],
    },
  ])("keeps $name in command execution mode", ({ argv, commandPath }) => {
    expect(resolveCliArgvInvocation(argv)).toEqual({
      argv,
      commandPath,
      primary: "skills",
      hasHelpOrVersion: false,
      isRootHelpInvocation: false,
    });
  });

  it("consumes agent parent option values before the exec subcommand", () => {
    expect(
      resolveCliArgvInvocation([
        "node",
        "openclaw",
        "agent",
        "--model",
        "openai/gpt-5.6-sol",
        "exec",
        "fix it",
      ]).commandPath,
    ).toEqual(["agent", "exec"]);
  });

  it("does not treat an exec-valued parent option as the subcommand", () => {
    expect(
      resolveCliArgvInvocation(["node", "openclaw", "agent", "--message", "exec"]).commandPath,
    ).toEqual(["agent"]);
  });

  it("consumes root options between the agent parent and exec", () => {
    expect(
      resolveCliArgvInvocation([
        "node",
        "openclaw",
        "agent",
        "--no-color",
        "--model",
        "openai/gpt-5.6-sol",
        "exec",
        "fix it",
      ]).commandPath,
    ).toEqual(["agent", "exec"]);
  });
});
