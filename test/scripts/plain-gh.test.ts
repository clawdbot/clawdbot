// Exercise real subprocess boundaries with disposable PATH routes and synthetic credentials.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  execGhApiRead,
  execGhJson,
  execGhRead,
  execGhReadAsync,
  execPlainGh,
  plainGhAuthenticatedEnv,
  resolvePlainGhBin,
} from "../../scripts/lib/plain-gh.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const commandDirs = useAutoCleanupTempDirTracker(afterAll);
const shellHelper = path.resolve("scripts/lib/plain-gh.sh");
const tokenNames = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;
const engines = ["shell", "Node"] as const;
let commands: ReturnType<typeof makeCommandFixture>;

beforeAll(() => {
  commands = makeCommandFixture();
});

function makeCommandFixture() {
  const root = commandDirs.make("plain-gh-commands-");
  const home = path.join(root, "home");
  const protectedBin = path.join(home, "bin");
  const secondBin = path.join(root, "second");
  const toolsBin = path.join(root, "tools");
  for (const dir of [protectedBin, secondBin, toolsBin]) {
    mkdirSync(dir, { recursive: true });
  }
  symlinkSync("/usr/bin/env", path.join(toolsBin, "env"));
  for (const [dir, route] of [
    [protectedBin, "protected"],
    [secondBin, "second"],
  ] as const) {
    const gh = path.join(dir, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
const fs = require("node:fs");
const env = process.env;
const argv = process.argv.slice(2);
const route = ${JSON.stringify(route)};
fs.appendFileSync(env.FAKE_GH_CALLS, JSON.stringify({ route, argv, override: env.OPENCLAW_GH_BIN ?? null }) + "\\n");
if (argv[0] === "auth" && argv[1] === "token") {
  process.stdout.write("fixture-token\\n");
} else if (env.FAKE_GH_REJECT && route === "protected") {
  process.stdout.write("protected refusal\\n");
  process.stderr.write("policy denied\\n");
  process.exitCode = 23;
} else if (env.FAKE_GH_BYTES) {
  process.stdout.write(Buffer.alloc(Number(env.FAKE_GH_BYTES), 0xff));
} else {
  const colors = Object.fromEntries(["NO_COLOR", "FORCE_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "COLORTERM", "GH_FORCE_TTY"].map(key => [key, env[key] ?? null]));
  const tokens = Object.fromEntries(${JSON.stringify(tokenNames)}.filter(key => env[key]).map(key => [key, env[key]]));
  const result = JSON.stringify({ route, argv, colors, tokens, override: env.OPENCLAW_GH_BIN ?? null, cwd: process.cwd() });
  const colored = env.NO_COLOR !== "1" || env.FORCE_COLOR !== "0" || env.CLICOLOR !== "0" || env.CLICOLOR_FORCE !== "0" || env.COLORTERM || env.GH_FORCE_TTY;
  process.stdout.write(colored ? "\\x1b[31m" + result + "\\x1b[0m" : result);
}
`,
    );
    chmodSync(gh, 0o755);
  }
  return { home, protectedBin, secondBin, toolsBin };
}

function makeFixture() {
  const root = tempDirs.make("plain-gh-");
  // Share executable files only; environments and outputs stay private to each test.
  const { home, protectedBin, secondBin, toolsBin } = commands;
  const calls = path.join(root, "calls.jsonl");
  writeFileSync(calls, "");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: [protectedBin, secondBin, toolsBin].join(path.delimiter),
    FAKE_GH_CALLS: calls,
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
    GH_FORCE_TTY: "120",
  };
  return {
    root,
    home,
    protectedBin,
    secondBin,
    toolsBin,
    env,
    override: path.join(secondBin, "gh"),
    calls: () =>
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

function runGh(engine: (typeof engines)[number], env: NodeJS.ProcessEnv, cwd?: string) {
  const options = { cwd, encoding: "utf8" as const, env, stdio: "pipe" as const };
  if (engine === "Node") {
    return execPlainGh(["--version"], options);
  }
  return execFileSync(
    "/bin/bash",
    ["-c", 'source "$1"; shift; gh_plain "$@"', "plain-gh", shellHelper, "--version"],
    options,
  );
}

describe.each(engines)("%s plain gh execution", (engine) => {
  it.each([undefined, ""])(
    "keeps HOME/bin first on PATH with override %j and does not extract credentials",
    (override) => {
      const fixture = makeFixture();
      fixture.env.OPENCLAW_GH_BIN = override;
      const before = { ...fixture.env };
      const result = JSON.parse(runGh(engine, fixture.env));
      expect(result).toMatchObject({
        route: "protected",
        argv: ["--version"],
        colors: {
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          CLICOLOR: "0",
          CLICOLOR_FORCE: "0",
          COLORTERM: null,
          GH_FORCE_TTY: null,
        },
      });
      expect(result.tokens).toEqual({});
      expect(fixture.calls()).toEqual([
        { route: "protected", argv: ["--version"], override: override ?? null },
      ]);
      expect(fixture.env).toEqual(before);
    },
  );

  it("preserves a protected refusal and both output streams without fallback", () => {
    const fixture = makeFixture();
    fixture.env.FAKE_GH_REJECT = "1";
    expect(() => runGh(engine, fixture.env)).toThrow(
      expect.objectContaining({
        status: 23,
        stdout: "protected refusal\n",
        stderr: "policy denied\n",
      }),
    );
    expect(fixture.calls()).toEqual([{ route: "protected", argv: ["--version"], override: null }]);
  });

  it.each(["missing PATH command", "nonexecutable override"])(
    "refuses %s without native discovery",
    (failure) => {
      const fixture = makeFixture();
      if (failure === "missing PATH command") {
        fixture.env.PATH = fixture.toolsBin;
      } else {
        fixture.env.OPENCLAW_GH_BIN = path.join(fixture.root, "not-executable");
        writeFileSync(fixture.env.OPENCLAW_GH_BIN, "not executable");
        // Existing ambient credentials isolate executable validation from split-auth probing.
        fixture.env.GH_TOKEN = "fixture-ambient";
      }
      expect(() => runGh(engine, fixture.env)).toThrow();
      expect(fixture.calls()).toEqual([]);
    },
  );

  it.each(tokenNames)("preserves ambient %s without probing in either route", (tokenName) => {
    const fixture = makeFixture();
    fixture.env[tokenName] = "fixture-ambient";
    for (const explicit of [false, true]) {
      fixture.env.OPENCLAW_GH_BIN = explicit ? fixture.override : undefined;
      const before = { ...fixture.env };
      const result = JSON.parse(runGh(engine, fixture.env));
      expect(result).toMatchObject({
        route: explicit ? "second" : "protected",
        override: explicit ? fixture.override : null,
      });
      expect(result.tokens).toEqual({ [tokenName]: "fixture-ambient" });
      expect(fixture.env).toEqual(before);
    }
    expect(fixture.calls()).toEqual([
      { route: "protected", argv: ["--version"], override: null },
      { route: "second", argv: ["--version"], override: fixture.override },
    ]);
  });

  it.each([
    { host: undefined, tokenName: "GH_TOKEN", args: ["auth", "token"] },
    {
      host: "github.com",
      tokenName: "GH_TOKEN",
      args: ["auth", "token", "--hostname", "github.com"],
    },
    {
      host: "github.example.com",
      tokenName: "GH_ENTERPRISE_TOKEN",
      args: ["auth", "token", "--hostname", "github.example.com"],
    },
  ])(
    "forwards explicit override credentials for host $host only to the child",
    ({ host, tokenName, args }) => {
      const fixture = makeFixture();
      Object.assign(fixture.env, { GH_HOST: host, OPENCLAW_GH_BIN: fixture.override });
      const before = { ...fixture.env };
      const output =
        engine === "Node"
          ? execFileSync(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `import { execPlainGh } from ${JSON.stringify(path.resolve("scripts/lib/plain-gh.mjs"))};
const before = JSON.stringify(process.env);
process.stdout.write(execPlainGh(["--version"], { encoding: "utf8" }));
if (JSON.stringify(process.env) !== before) throw new Error("parent environment changed");`,
              ],
              { encoding: "utf8", env: fixture.env, stdio: "pipe" },
            )
          : execFileSync(
              "/bin/bash",
              [
                "-c",
                'source "$1"; gh_plain --version && test -z "${GH_TOKEN-}${GH_ENTERPRISE_TOKEN-}"',
                "plain-gh",
                shellHelper,
              ],
              { encoding: "utf8", env: fixture.env, stdio: "pipe" },
            );
      const result = JSON.parse(output);
      expect(result).toMatchObject({
        route: "second",
        override: fixture.override,
      });
      expect(result.tokens).toEqual({ [tokenName]: "fixture-token" });
      expect(fixture.calls()).toEqual([
        { route: "protected", argv: args, override: engine === "shell" ? "" : null },
        { route: "second", argv: ["--version"], override: fixture.override },
      ]);
      expect(fixture.env).toEqual(before);
    },
  );
});

describe("plain gh subprocess contracts", () => {
  it("ignores a shell function shadowing the external PATH executable", () => {
    const fixture = makeFixture();
    const output = execFileSync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; gh() { echo function-shadow >&2; return 71; }; resolved=$(resolve_plain_gh_bin); "$resolved" --version',
        "plain-gh",
        shellHelper,
      ],
      { encoding: "utf8", env: fixture.env, stdio: "pipe" },
    );
    expect(output).toContain('"route":"protected"');
    expect(fixture.calls()).toHaveLength(1);
  });

  it.each(["bin", ""])("uses the Node child cwd for relative PATH entry %j", (entry) => {
    const fixture = makeFixture();
    const cwd = entry ? fixture.home : fixture.protectedBin;
    fixture.env.PATH = [entry, fixture.secondBin, fixture.toolsBin].join(path.delimiter);
    expect(JSON.parse(runGh("Node", fixture.env, cwd))).toMatchObject({ route: "protected", cwd });
    expect(fixture.calls()).toHaveLength(1);
  });

  it("keeps direct resolver/environment consumers on PATH without an auth probe", () => {
    const fixture = makeFixture();
    const output = execFileSync(resolvePlainGhBin(fixture.env), ["--version"], {
      encoding: "utf8",
      env: plainGhAuthenticatedEnv(fixture.env),
      stdio: "pipe",
    });
    expect(JSON.parse(output).route).toBe("protected");
    expect(fixture.calls()).toEqual([{ route: "protected", argv: ["--version"], override: null }]);
  });

  it("keeps explicit reads override-independent and parses normalized JSON", async () => {
    const fixture = makeFixture();
    fixture.env.OPENCLAW_GH_BIN = "/invalid-explicit-override";
    const options = { encoding: "utf8" as const, env: fixture.env };
    expect(JSON.parse(execGhApiRead("repos/example/repo", options))).toMatchObject({
      route: "protected",
      argv: ["api", "repos/example/repo", "--method", "GET"],
      override: null,
    });
    expect(execGhJson(["--version"], options)).toMatchObject({
      route: "protected",
      override: null,
    });
    expect(JSON.parse(await execGhReadAsync(["--version"], options))).toMatchObject({
      route: "protected",
      override: null,
      colors: { NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR: "0", CLICOLOR_FORCE: "0" },
    });
    expect(fixture.calls()).toHaveLength(3);
    expect(fixture.env.OPENCLAW_GH_BIN).toBe("/invalid-explicit-override");
  });

  it("preserves asynchronous read refusals and buffer limits without another route", async () => {
    const fixture = makeFixture();
    fixture.env.OPENCLAW_GH_BIN = fixture.override;
    fixture.env.FAKE_GH_REJECT = "1";
    const options = { env: fixture.env, timeout: 10_000, killSignal: "SIGKILL" as const };
    await expect(execGhReadAsync(["--version"], options)).rejects.toMatchObject({
      code: 23,
      stderr: "policy denied\n",
      stdout: "protected refusal\n",
    });
    delete fixture.env.FAKE_GH_REJECT;
    fixture.env.FAKE_GH_BYTES = "4096";
    await expect(
      execGhReadAsync(["--version"], { ...options, maxBuffer: 1024 }),
    ).rejects.toMatchObject({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });
    expect(fixture.calls()).toEqual([
      { route: "protected", argv: ["--version"], override: null },
      { route: "protected", argv: ["--version"], override: null },
    ]);
  });

  it.each([execPlainGh, execGhRead])(
    "preserves binary output, streaming, and caller buffer limits (%#)",
    (execute) => {
      const fixture = makeFixture();
      // Explicit selection also keeps this payload proof harmless on the pre-fix resolver.
      fixture.env.OPENCLAW_GH_BIN = fixture.override;
      fixture.env.GH_TOKEN = "fixture-ambient";
      fixture.env.FAKE_GH_BYTES = String(2 * 1024 * 1024);
      const options = {
        env: fixture.env,
        stdio: "pipe" as const,
        timeout: 10_000,
        killSignal: "SIGKILL" as const,
      };
      const output = execute(["--version"], options);
      expect(Buffer.isBuffer(output)).toBe(true);
      expect(Buffer.alloc(2 * 1024 * 1024, 0xff).equals(output)).toBe(true);
      expect(() => execute(["--version"], { ...options, maxBuffer: 1024 })).toThrow(
        expect.objectContaining({ code: "ENOBUFS" }),
      );
      const destination = path.join(fixture.root, "artifact.bin");
      const fd = openSync(destination, "w");
      try {
        execute(["--version"], { ...options, stdio: ["ignore", fd, "pipe"] });
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(destination).equals(output)).toBe(true);
    },
  );

  it("preserves bounded read options and invocation errors", () => {
    const calls: unknown[][] = [];
    expect(
      execGhJson(
        ["api", "repos/example/repo"],
        {
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "inherit"],
          timeout: 60_000,
        },
        {
          execFileSyncImpl: (...args: unknown[]) => {
            calls.push(args);
            return '{"ok":true}';
          },
        },
      ),
    ).toEqual({ ok: true });
    expect(calls).toEqual([
      [
        "gh",
        ["api", "repos/example/repo"],
        expect.objectContaining({
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: 32 * 1024 * 1024,
          stdio: ["ignore", "pipe", "inherit"],
          timeout: 60_000,
        }),
      ],
    ]);
    const failure = new Error("gh read failed");
    expect(() =>
      execGhRead(
        ["--version"],
        {},
        {
          execFileSyncImpl: () => {
            throw failure;
          },
        },
      ),
    ).toThrow(failure);
  });
});
