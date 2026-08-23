// Test script helpers provide shared filesystem and process utilities for script tests.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export function writeNodeBackedJq(binDir: string): void {
  const jqPath = path.join(binDir, "jq");
  fs.writeFileSync(
    jqPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const query = args.at(-1) ?? "";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const print = (value) => process.stdout.write(String(value ?? "") + "\\n");

if (query === ".login") print(input.login);
else if (query === ".name // empty") print(input.name ?? "");
else if (query === ".created_at") print(input.created_at);
else if (query === ".type") print(input.type);
else if (query === ".totalCommitContributions") print(input.totalCommitContributions);
else if (query === ".totalIssueContributions") print(input.totalIssueContributions);
else if (query === ".totalPullRequestContributions") print(input.totalPullRequestContributions);
else if (query === ".totalPullRequestReviewContributions") print(input.totalPullRequestReviewContributions);
else if (query.includes("{id: .profileId")) {
  const profiles = input.auth?.oauth?.profiles ?? [];
  const profile = profiles.filter((item) => item.provider === "anthropic" && item.type === "oauth").sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
  print(profile?.profileId ?? "none");
} else if (query.includes(".auth.providers[]")) {
  const counts = (input.auth?.providers ?? []).filter((item) => item.provider === "anthropic").map((item) => item.profiles?.apiKey ?? 0);
  print(Math.max(0, ...counts));
} else if (query.includes(".auth.oauth.profiles[]")) {
  const profiles = (input.auth?.oauth?.profiles ?? []).filter((item) => item.provider === "anthropic" && item.type === "oauth");
  print(Math.max(0, ...profiles.map((item) => item.expiresAt ?? 0)));
} else {
  process.stderr.write("unsupported jq query: " + query + "\\n");
  process.exit(2);
}
`,
  );
  fs.chmodSync(jqPath, 0o755);
}

export function createScriptTestHarness() {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function createTempDirAsync(prefix: string): Promise<string> {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function trackTempDir(dir: string): string {
    tempDirs.push(dir);
    return dir;
  }

  return {
    createTempDir,
    createTempDirAsync,
    trackTempDir,
  };
}
