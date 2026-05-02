import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResolution, ExecutableResolution } from "./exec-command-resolution.js";

export function makePathEnv(binDir: string): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return { PATH: binDir };
  }
  return { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT;.COM" };
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-approvals-"));
}

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
