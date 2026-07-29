// Provides shared fixtures for exec approval tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResolution, ExecutableResolution } from "./exec-command-resolution.js";

// Shared exec-approval fixtures keep parser, allowlist, and wrapper tests on
// the same mock resolution shape.
export function makePathEnv(binDir: string): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return { PATH: binDir };
  }
  return { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT;.COM" };
}

/** Create a real temp directory for exec-approval tests that need filesystem paths. */
export function makeTempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approvals-")));
}

/** Create an executable file in a test bin directory. */
export function makeExecutable(dir: string, name: string): string {
  const fileName = process.platform === "win32" ? `${name}.exe` : name;
  const exe = path.join(dir, fileName);
  fs.writeFileSync(exe, "");
  fs.chmodSync(exe, 0o755);
  return exe;
}

/** Build a minimal executable resolution for command-policy tests. */
export function makeMockExecutableResolution(params: {
  rawExecutable: string;
  executableName: string;
  resolvedPath?: string;
  resolvedRealPath?: string;
}): ExecutableResolution {
  return {
    rawExecutable: params.rawExecutable,
    resolvedPath: params.resolvedPath,
    resolvedRealPath: params.resolvedRealPath,
    executableName: params.executableName,
  };
}

/** Build a command resolution while preserving legacy getter accessors. */
export function makeMockCommandResolution(params: {
  execution: ExecutableResolution;
  policy?: ExecutableResolution;
  effectiveArgv?: string[];
  wrapperChain?: string[];
  policyBlocked?: boolean;
  blockedWrapper?: string;
}): CommandResolution {
  const policy = params.policy ?? params.execution;
  const resolution: CommandResolution = {
    execution: params.execution,
    policy,
    effectiveArgv: params.effectiveArgv,
    wrapperChain: params.wrapperChain,
    policyBlocked: params.policyBlocked,
    blockedWrapper: params.blockedWrapper,
  };
  return Object.defineProperties(resolution, {
    rawExecutable: {
      get: () => params.execution.rawExecutable,
    },
    resolvedPath: {
      get: () => params.execution.resolvedPath,
    },
    resolvedRealPath: {
      get: () => params.execution.resolvedRealPath,
    },
    executableName: {
      get: () => params.execution.executableName,
    },
    policyResolution: {
      get: () => (policy === params.execution ? undefined : policy),
    },
  });
}

type ShellParserParityFixtureCase = {
  id: string;
  command: string;
  ok: boolean;
  executables: string[];
};

type ShellParserParityFixture = {
  cases: ShellParserParityFixtureCase[];
};

type WrapperResolutionParityFixtureCase = {
  id: string;
  argv: string[];
  expectedRawExecutable: string | null;
};

type WrapperResolutionParityFixture = {
  cases: WrapperResolutionParityFixtureCase[];
};

export function loadShellParserParityFixtureCases(): ShellParserParityFixtureCase[] {
  const fixturePath = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "exec-allowlist-shell-parser-parity.json",
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ShellParserParityFixture;
  return fixture.cases;
}

/** Load wrapper resolution parity cases generated from shell-parser fixtures. */
export function loadWrapperResolutionParityFixtureCases(): WrapperResolutionParityFixtureCase[] {
  const fixturePath = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "exec-wrapper-resolution-parity.json",
  );
  const fixture = JSON.parse(
    fs.readFileSync(fixturePath, "utf8"),
  ) as WrapperResolutionParityFixture;
  return fixture.cases;
}
