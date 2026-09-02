import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { requireGitCommand as requireGit } from "../infra/git-exec.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const privateRepositories: string[] = [];

afterEach(() => {
  for (const repository of privateRepositories.splice(0)) {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "keeps Git backup failures useful through the shipped CLI",
  async () => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, ".openclaw");
        const repository = fs.mkdtempSync(
          path.join(fs.realpathSync("/var/tmp"), "openclaw-backup-git-cli-"),
        );
        privateRepositories.push(repository);
        const remote = path.join(tempHome, "remote.git");
        const unborn = path.join(tempHome, "unborn");
        const hooks = path.join(tempHome, "hooks");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          NO_COLOR: "1",
        };
        delete env.OPENCLAW_CONFIG_PATH;
        delete env.OPENCLAW_HOME;
        delete env.VITEST;

        openOpenClawStateDatabase({ env });
        closeOpenClawStateDatabase();
        await requireGit(tempHome, ["init", "--bare", remote]);

        const entry = path.resolve(process.cwd(), "src/entry.ts");
        const runCli = async (args: string[], childEnv: NodeJS.ProcessEnv = env) =>
          await runCliProcessChild({
            nodeArgs: ["--import", "tsx", entry, ...args],
            env: childEnv,
          });
        const expectExit = (result: Awaited<ReturnType<typeof runCli>>, code: number) => {
          expect(
            result.code,
            formatCliProcessFailure({
              reason: `expected CLI exit ${code}`,
              stderr: result.stderr,
              stdout: result.stdout,
            }),
          ).toBe(code);
        };

        expectExit(
          await runCli(["backup", "git", "init", "--repository", repository, "--remote", remote]),
          0,
        );
        await requireGit(repository, ["config", "user.name", "OpenClaw Backup Test"]);
        await requireGit(repository, ["config", "user.email", "backup@example.invalid"]);
        fs.mkdirSync(hooks);
        const username = ["synthetic", "cli", "user"].join("-");
        const password = ["synthetic", "cli", "password"].join("-");
        const querySecret = ["synthetic", "cli", "query"].join("-");
        const credentialUrl = `https://${username}:${password}@example.invalid/backup.git?access_token=${querySecret}`;
        fs.writeFileSync(
          path.join(hooks, "pre-push"),
          [
            "#!/bin/sh",
            ...Array.from(
              { length: 20 },
              (_, index) => `printf 'stderr-old-${index} ${credentialUrl}\\n' >&2`,
            ),
            `printf 'stderr-tail-🦞 ${credentialUrl}\\n' >&2`,
            ...Array.from(
              { length: 20 },
              (_, index) => `printf 'stdout-old-${index} ${credentialUrl}\\n'`,
            ),
            `printf 'stdout-tail-🐚 ${credentialUrl}\\n'`,
            "exit 1",
          ].join("\n"),
          { mode: 0o700 },
        );
        await requireGit(repository, ["config", "core.hooksPath", hooks]);

        const failedPush = await runCli([
          "backup",
          "git",
          "create",
          "--repository",
          repository,
          "--global",
          "--push",
          "--exclude-secrets",
        ]);
        expectExit(failedPush, 0);
        const pushOutput = `${failedPush.stdout}\n${failedPush.stderr}`;
        expect(pushOutput).toContain("git push failed (code=1, termination=exit)");
        expect(pushOutput).toContain("stderr-tail-🦞");
        expect(pushOutput).toContain("stdout-tail-🐚");
        expect(pushOutput).toContain("https://***:***@example.invalid/backup.git?access_token=***");
        expect(pushOutput).not.toContain(username);
        expect(pushOutput).not.toContain(password);
        expect(pushOutput).not.toContain(querySecret);

        await requireGit(tempHome, ["init", unborn]);
        const emptyHistory = await runCli(["backup", "git", "log", "--repository", unborn]);
        expectExit(emptyHistory, 0);
        expect(emptyHistory.stdout).toContain("No Git backup commits");

        const blob = await requireGit(repository, ["hash-object", "-w", "--stdin"], {
          input: "not a commit\n",
        });
        await requireGit(repository, ["update-ref", "refs/tags/broken", blob]);
        const quarantine = path.join(repository, ".git", "quarantine");
        fs.mkdirSync(quarantine);
        fs.renameSync(
          path.join(repository, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
          path.join(quarantine, blob),
        );
        await requireGit(repository, ["symbolic-ref", "HEAD", "refs/tags/broken"]);
        const historyUsername = ["synthetic", "history", "user"].join("-");
        const historyPassword = ["synthetic", "history", "password"].join("-");
        const historyQuery = ["synthetic", "history", "query"].join("-");
        const historyEnv = {
          ...env,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: `"/tmp/https://${historyUsername}:${historyPassword}@example.invalid/objects?access_token=${historyQuery}"`,
        };
        const failedHistory = await runCli(
          ["backup", "git", "log", "--repository", repository, "--json"],
          historyEnv,
        );
        expectExit(failedHistory, 1);
        const historyOutput = `${failedHistory.stdout}\n${failedHistory.stderr}`;
        expect(historyOutput).toContain("git show-ref HEAD failed (code=128, termination=exit)");
        expect(historyOutput).toContain("stderr:");
        expect(historyOutput).toContain("https://***:***@example.invalid/objects?access_token=***");
        expect(historyOutput).not.toContain(historyUsername);
        expect(historyOutput).not.toContain(historyPassword);
        expect(historyOutput).not.toContain(historyQuery);
      },
      { prefix: "openclaw-backup-git-cli-" },
    );
  },
  120_000,
);
