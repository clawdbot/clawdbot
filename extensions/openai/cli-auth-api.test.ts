import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isPidAlive, killProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexCliAccount } from "./cli-auth-api.js";

type ProbeTrace = {
  pid: number;
  descendantPid?: number;
  codexHome: string;
  args: string[];
  messages: Array<{ method: string; params?: unknown }>;
};

const fixtures = new Set<string>();

async function readTrace(home: string): Promise<ProbeTrace> {
  return JSON.parse(await fs.readFile(path.join(home, "trace.json"), "utf8")) as ProbeTrace;
}

async function createProbeFixture(response: unknown, mode = "account") {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openai-cli-account-")));
  fixtures.add(home);
  const command = path.join(home, "native codex.mjs");
  const script = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const mode = ${JSON.stringify(mode)};
const response = ${JSON.stringify(response)};
const tracePath = path.join(process.env.CODEX_HOME ?? ${JSON.stringify(home)}, 'trace.json');
const trace = { pid: process.pid, codexHome: process.env.CODEX_HOME, args: process.argv.slice(2), messages: [] };
const save = () => fs.writeFileSync(tracePath, JSON.stringify(trace));
save();
if (mode === 'stubborn' || mode === 'stubborn-descendant') {
  if (mode === 'stubborn') process.on('SIGTERM', () => {});
  const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send("ready", () => process.disconnect());'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  trace.descendantPid = descendant.pid;
  save();
  await once(descendant, 'message');
}
let initialized = false;
let notified = false;
const reply = (message, afterWrite) => {
  const line = JSON.stringify(message) + '\\n';
  process.stdout.write(line.slice(0, 5));
  setImmediate(() => { process.stdout.write(line.slice(5)); afterWrite?.(); });
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  trace.messages.push(message);
  save();
  if (message.method === 'initialize') {
    reply({ id: message.id, result: {} }, () => { initialized = true; });
  } else if (message.method === 'initialized') {
    if (!initialized) process.exit(2);
    notified = true;
  } else if (message.method === 'account/read') {
    if (!initialized || !notified) process.exit(3);
    if (mode === 'silent') return;
    if (mode === 'overflow') { process.stdout.write('x'.repeat(65 * 1024)); return; }
    if (mode === 'malformed') { process.stdout.write('not-json\\n'); return; }
    if (mode === 'error') { reply({ id: message.id, error: { code: -32000, message: 'synthetic-secret-error' } }); return; }
    process.stdout.write(JSON.stringify({ method: 'configWarning', params: { message: 'synthetic warning' } }) + '\\n');
    reply({ id: message.id, result: response });
  } else process.exit(4);
});
// EOF before the deferred response intentionally loses it, as native Codex does.
input.on('close', () => process.exit(0));
`;
  await fs.writeFile(command, script, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: home,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  return { command, env, home };
}

async function expectProbeStopped(home: string) {
  const trace = await readTrace(home);
  await vi.waitFor(() => {
    expect(isPidAlive(trace.pid)).toBe(false);
    if (trace.descendantPid) {
      expect(isPidAlive(trace.descendantPid)).toBe(false);
    }
  });
  return trace;
}

async function cleanupFixtures() {
  for (const home of fixtures) {
    const trace = await readTrace(home).catch(() => undefined);
    for (const pid of [trace?.pid, trace?.descendantPid]) {
      if (pid && isPidAlive(pid)) {
        killProcessTree(pid, {
          detached: pid === trace?.pid && process.platform !== "win32",
          force: true,
        });
      }
    }
    if (trace) {
      await expectProbeStopped(home);
    }
    await fs.rm(home, { recursive: true, force: true });
  }
  fixtures.clear();
}

afterEach(cleanupFixtures);

describe("native Codex account discovery", () => {
  it("waits for initialization and keeps stdin open until the account response", async () => {
    const fixture = await createProbeFixture({
      account: { type: "chatgpt", email: " active@example.test ", accessToken: "synthetic-token" },
      requiresOpenaiAuth: true,
    });

    await expect(readCodexCliAccount(fixture)).resolves.toEqual({
      type: "chatgpt",
      email: "active@example.test",
    });
    const trace = await expectProbeStopped(fixture.home);
    expect(trace.codexHome).toBe(fixture.home);
    expect(trace.args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(trace.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
    ]);
    expect(trace.messages[2]?.params).toEqual({ refreshToken: false });
  });

  it.each([
    {
      name: "API key",
      account: { type: "apiKey", email: "unrelated@example.test", apiKey: "synthetic-key" },
      expected: { type: "apiKey" },
    },
    {
      name: "missing email",
      account: { type: "chatgpt", email: null },
      expected: { type: "chatgpt" },
    },
    {
      name: "multiline email",
      account: { type: "chatgpt", email: "a@example.test\nb" },
      expected: { type: "chatgpt" },
    },
    {
      name: "oversized email",
      account: { type: "chatgpt", email: "a".repeat(321) },
      expected: { type: "chatgpt" },
    },
    {
      name: "unsupported account",
      account: { type: "amazonBedrock", email: "unrelated@example.test" },
      expected: { type: "unknown" },
    },
    { name: "malformed account", account: {}, expected: null },
  ])("projects $name without borrowing another identity", async ({ account, expected }) => {
    const fixture = await createProbeFixture({ account, requiresOpenaiAuth: true });
    await expect(readCodexCliAccount(fixture)).resolves.toEqual(expected);
    await expectProbeStopped(fixture.home);
  });

  it.each([true, false])(
    "preserves an absent native account with requiresOpenaiAuth=%s",
    async (requiresOpenaiAuth) => {
      const fixture = await createProbeFixture({ account: null, requiresOpenaiAuth });
      await expect(readCodexCliAccount(fixture)).resolves.toEqual({
        type: "none",
        requiresOpenaiAuth,
      });
      await expectProbeStopped(fixture.home);
    },
  );

  it.each(["malformed", "overflow", "error"])(
    "stops a %s response without exposing diagnostics",
    async (mode) => {
      const fixture = await createProbeFixture({}, mode);
      await expect(readCodexCliAccount(fixture)).resolves.toBeNull();
      await expectProbeStopped(fixture.home);
    },
  );

  it("terminates a stubborn process tree after receiving its account", async () => {
    const fixture = await createProbeFixture({ account: { type: "apiKey" } }, "stubborn");
    await expect(readCodexCliAccount(fixture)).resolves.toEqual({ type: "apiKey" });
    const trace = await expectProbeStopped(fixture.home);
    expect(trace.descendantPid).toBeTypeOf("number");
  });

  // POSIX group cleanup must finish before the caller can discard its Worker timers.
  it.skipIf(process.platform === "win32")(
    "cleans up a stubborn descendant before its caller terminates the worker",
    async () => {
      const fixture = await createProbeFixture(
        { account: { type: "apiKey" } },
        "stubborn-descendant",
      );
      const workerPath = path.join(fixture.home, "reader-worker.mjs");
      await fs.writeFile(
        workerPath,
        `
          import { parentPort, workerData } from "node:worker_threads";
          const { readCodexCliAccount } = await import(workerData.moduleUrl);
          parentPort.postMessage(await readCodexCliAccount(workerData.fixture));
        `,
      );
      const worker = new Worker(workerPath, {
        execArgv: ["--import", new URL("../../scripts/tsx.mjs", import.meta.url).href],
        env: fixture.env,
        workerData: {
          moduleUrl: new URL("./cli-auth-api.ts", import.meta.url).href,
          fixture,
        },
      });

      try {
        const [account] = await once(worker, "message", {
          signal: AbortSignal.timeout(10_000),
        });
        await worker.terminate();
        expect(account).toEqual({ type: "apiKey" });
        const trace = await expectProbeStopped(fixture.home);
        expect(trace.descendantPid).toBeTypeOf("number");
      } finally {
        try {
          await worker.terminate();
        } finally {
          await cleanupFixtures();
        }
      }
    },
    15_000,
  );

  it("ends an unresponsive native probe at its deadline", async () => {
    const fixture = await createProbeFixture({}, "silent");
    await expect(readCodexCliAccount(fixture)).resolves.toBeNull();
    await expectProbeStopped(fixture.home);
  });

  it.each([
    { homeKey: "none", allowed: false },
    { homeKey: "HOME", allowed: process.platform !== "win32" },
    { homeKey: "USERPROFILE", allowed: false },
  ])("launches only with a supported injected home: $homeKey", async ({ homeKey, allowed }) => {
    const fixture = await createProbeFixture({ account: { type: "apiKey" } });
    const env: NodeJS.ProcessEnv = {
      PATH: fixture.env.PATH,
      ...(fixture.env.SystemRoot ? { SystemRoot: fixture.env.SystemRoot } : {}),
      ...(homeKey === "none" ? {} : { [homeKey]: fixture.home }),
    };
    const result = await readCodexCliAccount({ command: fixture.command, env });
    if (allowed) {
      expect(result).toEqual({ type: "apiKey" });
      await expectProbeStopped(fixture.home);
    } else {
      expect(result).toBeNull();
      await expect(fs.stat(path.join(fixture.home, "trace.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("returns unavailable for an executable that cannot start", async () => {
    const fixture = await createProbeFixture({});
    await expect(
      readCodexCliAccount({ command: path.join(fixture.home, "missing"), env: fixture.env }),
    ).resolves.toBeNull();
  });
});
