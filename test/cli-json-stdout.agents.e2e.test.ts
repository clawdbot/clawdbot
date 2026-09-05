import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  it.each([
    {
      name: "add without an interactive terminal in human mode",
      args: ["agents", "add", "work"],
      message:
        "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.",
      human: true,
    },
    {
      name: "add without an interactive terminal in JSON wizard mode",
      args: ["agents", "add", "work", "--json"],
      message:
        "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.",
    },
    {
      name: "add without a workspace in human mode",
      args: ["agents", "add", "work", "--non-interactive"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
      human: true,
    },
    {
      name: "add without a workspace in explicit non-interactive mode",
      args: ["agents", "add", "work", "--non-interactive", "--json"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
    },
    {
      name: "add without a workspace when a model selects automation",
      args: ["agents", "add", "work", "--model", "openai/gpt-5.6-luna", "--json"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
    },
    {
      name: "add without a workspace before its missing name",
      args: ["agents", "add", "--non-interactive", "--json"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
    },
    {
      name: "add without a name after a valid workspace",
      args: ["agents", "add", "--workspace", "$WORKSPACE", "--json"],
      message:
        "Agent name is required in non-interactive mode. Run openclaw agents add <id> --workspace <path>.",
    },
    {
      name: "add with an invalid agent id",
      args: ["agents", "add", "агент✨", "--workspace", "$WORKSPACE", "--json"],
      message:
        'Agent name "агент✨" has no valid id characters. Use at least one letter a-z or digit.',
    },
    ...["openclaw", "crestodian"].map((agentId) => ({
      name: `add with reserved system-agent id ${agentId}`,
      args: ["agents", "add", agentId, "--workspace", "$WORKSPACE", "--json"],
      message: `"${agentId}" is reserved. Choose another name, or run openclaw agents list to inspect configured agents.`,
    })),
    {
      name: "add with an already-configured agent",
      args: ["agents", "add", "main", "--workspace", "$WORKSPACE", "--json"],
      message: 'Agent "main" already exists.',
    },
    {
      name: "add with a malformed binding",
      args: ["agents", "add", "work", "--workspace", "$WORKSPACE", "--bind", "telegram:", "--json"],
      message:
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
    },
    {
      name: "add with multiple malformed bindings in input order",
      args: [
        "agents",
        "add",
        "work",
        "--workspace",
        "$WORKSPACE",
        "--bind",
        "telegram:",
        "--bind",
        "telegram:work:extra",
        "--json",
      ],
      message: [
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
      ].join("\n"),
    },
    {
      name: "add with an unknown binding channel",
      args: [
        "agents",
        "add",
        "work",
        "--workspace",
        "$WORKSPACE",
        "--bind",
        "definitely-not-a-channel",
        "--json",
      ],
      message:
        'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
    },
    {
      name: "add with a normalized id before a malformed binding",
      args: ["agents", "add", "Work", "--workspace", "$WORKSPACE", "--bind", "telegram:", "--json"],
      message:
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
    },
    {
      name: "add without a workspace through dual-TTY finalization",
      args: ["agents", "add", "work", "--non-interactive", "--json"],
      message:
        "Non-interactive agent creation requires --workspace. Re-run openclaw agents add <id> --workspace <path> or omit flags to use the wizard.",
      tty: true,
    },
    {
      name: "add with a malformed binding through dual-TTY finalization",
      args: ["agents", "add", "work", "--workspace", "$WORKSPACE", "--bind", "telegram:", "--json"],
      message:
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
      tty: true,
    },
    {
      name: "bindings with an invalid agent",
      args: ["agents", "bindings", "--agent", "агент✨", "--json"],
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bindings with an unknown agent",
      args: ["agents", "bindings", "--json", "--agent", "ghost"],
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind with an invalid agent",
      args: ["agents", "bind", "--agent", "агент✨", "--bind", "telegram", "--json"],
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind with an unknown agent before missing bindings",
      args: ["agents", "bind", "--json", "--agent", "ghost"],
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "bind without bindings",
      args: ["agents", "bind", "--json"],
      message: "Provide at least one --bind <channel[:accountId]>.",
    },
    {
      name: "bind with only a blank binding",
      args: ["agents", "bind", "--bind", "  ", "--json"],
      message: "Provide at least one --bind <channel[:accountId]>.",
    },
    {
      name: "bind with multiple malformed bindings in input order",
      args: ["agents", "bind", "--bind", "telegram:", "--bind", "telegram:work:extra", "--json"],
      message: [
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
      ].join("\n"),
    },
    {
      name: "bind with an unknown channel",
      args: ["agents", "bind", "--json", "--bind", "definitely-not-a-channel"],
      message:
        'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
    },
    {
      name: "unbind with an invalid agent",
      args: ["agents", "unbind", "--agent", "агент✨", "--all", "--json"],
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "unbind with an unknown agent before incompatible options",
      args: ["agents", "unbind", "--agent", "ghost", "--all", "--bind", "telegram", "--json"],
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "unbind without bindings",
      args: ["agents", "unbind", "--json"],
      message: "Provide at least one --bind <channel[:accountId]> or use --all.",
    },
    {
      name: "unbind with a malformed binding",
      args: ["agents", "unbind", "--bind", "telegram:work:extra", "--json"],
      message:
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
    },
    {
      name: "unbind with incompatible options in human mode",
      args: ["agents", "unbind", "--all", "--bind", "telegram"],
      message: "Use either --all or --bind, not both.",
      human: true,
    },
    {
      name: "unbind with incompatible options in JSON mode",
      args: ["agents", "unbind", "--all", "--bind", "telegram", "--json"],
      message: "Use either --all or --bind, not both.",
    },
    {
      name: "bind without bindings through dual-TTY finalization",
      args: ["agents", "bind", "--json"],
      message: "Provide at least one --bind <channel[:accountId]>.",
      tty: true,
    },
    {
      name: "set-identity with an unknown agent in human mode",
      args: ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost"],
      message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
      human: true,
    },
    {
      name: "set-identity with an unknown agent in JSON mode",
      args: ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
      message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
    },
    {
      name: "set-identity with an invalid agent before identity-file resolution",
      args: ["agents", "set-identity", "--agent", "агент✨", "--from-identity", "--json"],
      message: 'Agent "агент✨" not found. Create it with `openclaw agents add`.',
    },
    {
      name: "set-identity with an unmatched workspace",
      args: ["agents", "set-identity", "--workspace", "$WORKSPACE", "--name", "Ghost", "--json"],
      message: "No agent workspace matches ~/workspace. Pass --agent to target a specific agent.",
    },
    {
      name: "set-identity with a missing workspace identity file",
      args: [
        "agents",
        "set-identity",
        "--agent",
        "main",
        "--workspace",
        "$WORKSPACE",
        "--from-identity",
        "--json",
      ],
      message: "No identity data found in ~/workspace/IDENTITY.md.",
    },
    {
      name: "set-identity with a missing explicit identity file",
      args: [
        "agents",
        "set-identity",
        "--agent",
        "main",
        "--identity-file",
        "$WORKSPACE",
        "--json",
      ],
      message: "No identity data found in ~/workspace.",
    },
    {
      name: "set-identity with an unknown agent through dual-TTY finalization",
      args: ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
      message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
      tty: true,
    },
  ])("renders agent management $name through the canonical failure owner", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "missing-openclaw.json");
        const workspace = path.join(tempHome, "workspace");
        const preload = `data:text/javascript,${encodeURIComponent(
          'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
        )}`;
        const args = testCase.args.map((argument) =>
          argument === "$WORKSPACE" ? workspace : argument,
        );
        const result = runBuiltCli(tempHome, args, {
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: configPath,
          ...("tty" in testCase ? { NODE_OPTIONS: `--import=${preload}`, FORCE_COLOR: "1" } : {}),
        });

        expect(result.status, result.stderr).toBe(1);
        if ("human" in testCase) {
          expect(result.stdout).toBe("");
        } else {
          expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: { type: "cli_error", message: testCase.message },
          });
        }
        expect(result.stderr).toContain(testCase.message);
        expect(result.stderr.split(testCase.message)).toHaveLength(2);
        if ("tty" in testCase) {
          expect(result.stderr).toContain("\u001B[?25h");
        }
        await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "openclaw-agent-management-json-failure-e2e-" },
    );
  });

  it("leaves existing config and IDENTITY.md untouched when set-identity rejects an agent", async () => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        const workspace = path.join(tempHome, "workspace");
        const identityPath = path.join(workspace, "IDENTITY.md");
        const originalConfig = `${JSON.stringify({
          agents: { entries: { main: { workspace, identity: { name: "Original" } } } },
        })}\n`;
        const originalIdentity = "- Name: Original workspace identity\n";
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(configPath, originalConfig, "utf8");
        await fs.writeFile(identityPath, originalIdentity, "utf8");

        const result = runBuiltCli(
          tempHome,
          ["agents", "set-identity", "--agent", "ghost", "--name", "Ghost", "--json"],
          {
            OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
            OPENCLAW_CONFIG_PATH: configPath,
          },
        );

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: 'Agent "ghost" not found. Create it with `openclaw agents add`.',
          },
        });
        await expect(fs.readFile(configPath, "utf8")).resolves.toBe(originalConfig);
        await expect(fs.readFile(identityPath, "utf8")).resolves.toBe(originalIdentity);
      },
      { prefix: "openclaw-agent-identity-json-failure-e2e-" },
    );
  });

  it.each([
    {
      name: "bindings list success",
      args: ["agents", "bindings", "--json"],
      payload: [],
    },
    {
      name: "bind success",
      args: ["agents", "bind", "--bind", "telegram:work", "--json"],
      payload: {
        agentId: "main",
        added: ["telegram accountId=work"],
        updated: [],
        skipped: [],
        conflicts: [],
      },
      writesConfig: true,
    },
    {
      name: "unbind-all success",
      args: ["agents", "unbind", "--all", "--json"],
      payload: { agentId: "main", removed: [], missing: [], conflicts: [] },
    },
    {
      name: "bind ownership conflict",
      args: ["agents", "bind", "--agent", "main", "--bind", "telegram:work", "--json"],
      payload: {
        agentId: "main",
        added: [],
        updated: [],
        skipped: [],
        conflicts: ["telegram accountId=work (agent=ops)"],
      },
      conflict: true,
    },
    {
      name: "unbind ownership conflict",
      args: ["agents", "unbind", "--agent", "main", "--bind", "telegram:work", "--json"],
      payload: {
        agentId: "main",
        removed: [],
        missing: [],
        conflicts: ["telegram accountId=work (agent=ops)"],
      },
      conflict: true,
    },
  ])("preserves agent binding $name as its existing domain payload", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        const existingConfig = `${JSON.stringify({
          agents: {
            ownership: "explicit",
            list: [
              { id: "main", workspace: path.join(tempHome, "main") },
              { id: "ops", workspace: path.join(tempHome, "ops") },
            ],
          },
          bindings: [
            { type: "route", agentId: "ops", match: { channel: "telegram", accountId: "work" } },
          ],
        })}\n`;
        if ("conflict" in testCase) {
          await fs.writeFile(configPath, existingConfig, "utf8");
        }

        const result = runBuiltCli(tempHome, testCase.args, {
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: configPath,
        });

        expect(result.status, result.stderr).toBe("conflict" in testCase ? 1 : 0);
        expect(result.stdout, result.stderr).not.toBe("");
        expect(JSON.parse(result.stdout)).toEqual(testCase.payload);
        if ("writesConfig" in testCase) {
          await expect(fs.access(configPath)).resolves.toBeUndefined();
        } else if ("conflict" in testCase) {
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(existingConfig);
        } else {
          await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      },
      { prefix: "openclaw-agent-bindings-domain-payload-e2e-" },
    );
  });
});
