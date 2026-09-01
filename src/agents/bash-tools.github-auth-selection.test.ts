import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { resolveManagedGitHubProfileDir } from "./github-tool-identity.js";

const relayCapture = vi.hoisted(() => ({
  sends: undefined as MockInstance<ChildProcess["send"]>[] | undefined,
}));
afterEach(() => {
  const sends = relayCapture.sends;
  relayCapture.sends = undefined;
  for (const send of sends ?? []) {
    send.mockRestore();
  }
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (child.connected && relayCapture.sends) {
        relayCapture.sends.push(vi.spyOn(child, "send"));
      }
      return child;
    },
  };
});

// Contract fixture only: no gh binary, network, native keyring, or default profile lookup.
// JSON is a YAML subset; only these test-owned hosts.yml documents are supported.
const authContractFixture = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const suppliedProfile = process.argv[2];
if (!suppliedProfile || process.env.GH_CONFIG_DIR !== suppliedProfile) {
  throw new Error("Fixture requires the explicitly supplied synthetic profile");
}
if (process.argv[3] === "deleted-after-launch") fs.rmSync(suppliedProfile, { recursive: true });
if (process.argv[3] === "stripped-after-launch") {
  fs.writeFileSync(path.join(suppliedProfile, "hosts.yml"), JSON.stringify({ "github.com": { user: "synthetic-managed-account" } }));
}
const fakeKeyring = new Map([["github.com", "synthetic-native-token"]]);
let selected;
let source;
if (process.env.GH_TOKEN) {
  selected = process.env.GH_TOKEN;
  source = "GH_TOKEN";
} else if (process.env.GITHUB_TOKEN) {
  selected = process.env.GITHUB_TOKEN;
  source = "GITHUB_TOKEN";
} else {
  let hosts = {};
  try {
    hosts = JSON.parse(fs.readFileSync(path.join(suppliedProfile, "hosts.yml"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  selected = hosts["github.com"]?.oauth_token;
  source = "profile";
  if (!selected) {
    selected = fakeKeyring.get("github.com");
    source = "fake-keyring";
  }
}
const accounts = new Map([
  ["synthetic-managed-token", "synthetic-managed-account"],
  ["synthetic-rotated-token", "synthetic-rotated-account"],
  ["synthetic-native-token", "synthetic-native-account"],
  ["synthetic-ambient-gh-token", "synthetic-ambient-gh-account"],
  ["synthetic-ambient-github-token", "synthetic-ambient-github-account"],
]);
const account = accounts.get(selected);
if (!account) throw new Error("Fixture received an unexpected token; value omitted");
const lineage = process.argv[4] === "service"
  ? { lineage: fs.fstatSync(3).isSocket() || fs.fstatSync(3).isFIFO() } : {};
process.stdout.write(JSON.stringify({ account, source, ...lineage }) + "\n");
`;

describe.skipIf(process.platform === "win32")("selected GitHub profile authentication", () => {
  it.each(
    [
      { pty: false, service: false },
      { pty: true, service: false },
      { pty: false, service: true },
    ].flatMap(({ pty, service }) =>
      ["missing", "tokenless", "available", "deleted-after-launch", "stripped-after-launch"].map(
        (profileState) => ({ pty, service, profileState }),
      ),
    ),
  )(
    "$profileState profile binds local auth (pty=$pty, service=$service)",
    async ({ profileState, pty, service }) => {
      const sends: MockInstance<ChildProcess["send"]>[] = [];
      relayCapture.sends = sends;
      const artifacts = path.join(process.cwd(), ".artifacts");
      await fs.mkdir(artifacts, { recursive: true });
      const root = await fs.realpath(await fs.mkdtemp(path.join(artifacts, "github-auth-repro-")));
      const homeDir = path.join(root, "home");
      const stateDir = path.join(homeDir, ".openclaw");
      await fs.mkdir(homeDir, { mode: 0o700 });
      try {
        await withEnvAsync(
          {
            HOME: homeDir,
            USERPROFILE: homeDir,
            OPENCLAW_HOME: homeDir,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
            ZDOTDIR: homeDir,
            XDG_CONFIG_HOME: path.join(homeDir, ".config"),
            XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
            XDG_STATE_HOME: path.join(homeDir, ".local", "state"),
            XDG_CACHE_HOME: path.join(homeDir, ".cache"),
            OPENCLAW_SERVICE_MARKER: service ? "synthetic-github-exec-proof" : undefined,
            GH_CONFIG_DIR: undefined,
            GH_TOKEN: "synthetic-ambient-gh-token",
            GITHUB_TOKEN: "synthetic-ambient-github-token",
          },
          async () => {
            const profileId = "ghp_11111111111111111111111111111111";
            const config = { tools: { github: { profileId } } };
            const profileDir = resolveManagedGitHubProfileDir({
              agentId: "main",
              scope: "system",
              profileId,
            });
            if (profileState !== "missing") {
              await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
              await fs.writeFile(
                path.join(profileDir, "hosts.yml"),
                JSON.stringify({
                  "github.com": {
                    user: "synthetic-managed-account",
                    ...(profileState !== "tokenless"
                      ? { oauth_token: "synthetic-managed-token" }
                      : {}),
                  },
                }),
                { mode: 0o600 },
              );
            }
            const fixturePath = path.join(root, "auth-contract-fixture.cjs");
            await fs.writeFile(fixturePath, authContractFixture, { mode: 0o600 });
            const tool = createExecTool({
              host: "gateway",
              security: "full",
              ask: "off",
              allowBackground: false,
              notifyOnExit: false,
              cwd: root,
              config,
              agentId: "main",
            });
            const execution = tool.execute(`synthetic-auth-${profileState}`, {
              command: [
                process.execPath,
                fixturePath,
                profileDir,
                profileState,
                service ? "service" : "direct",
              ]
                .map(quoteCliArg)
                .join(" "),
              pty,
            });
            const result = await execution;
            const output = result.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n");
            if (service) {
              const requests = sends.flatMap((send) => send.mock.calls.map(([message]) => message));
              expect(requests).toContainEqual(
                expect.objectContaining({
                  type: "start",
                  env: expect.objectContaining({ GH_TOKEN: "", GITHUB_TOKEN: "" }),
                }),
              );
              const serialized = JSON.stringify(requests);
              for (const token of [
                "synthetic-managed-token",
                "synthetic-ambient-gh-token",
                "synthetic-ambient-github-token",
              ]) {
                expect(serialized).not.toContain(token);
              }
            }
            if (profileState === "missing" || profileState === "tokenless") {
              expect(result.details).toMatchObject({ exitCode: 1 });
              expect(output).toContain("Reconnect or change GitHub Identity");
              expect(output).not.toContain("synthetic-native-account");
              return;
            }

            expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
            expect(JSON.parse(output)).toEqual({
              account: "synthetic-managed-account",
              source: "GH_TOKEN",
              ...(service ? { lineage: true } : {}),
            });
            if (profileState === "available") {
              await fs.writeFile(
                path.join(profileDir, "hosts.yml"),
                JSON.stringify({
                  "github.com": { oauth_token: "synthetic-rotated-token" },
                }),
              );
              const refreshed = await tool.execute("refreshed-auth", {
                command: [process.execPath, fixturePath, profileDir].map(quoteCliArg).join(" "),
                pty,
              });
              expect(refreshed.content).toEqual([
                {
                  type: "text",
                  text: JSON.stringify({
                    account: "synthetic-rotated-account",
                    source: "GH_TOKEN",
                  }),
                },
              ]);
            }
          },
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
