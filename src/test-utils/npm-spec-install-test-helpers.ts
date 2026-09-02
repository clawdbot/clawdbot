// Helpers for package install tests that inspect npm spec output.
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { CommandOptions, SpawnResult } from "../process/exec.js";
import { expectSingleNpmInstallIgnoreScriptsCall } from "./exec-assertions.js";

const emptyNpmFailure: SpawnResult = {
  stdout: "",
  stderr: "",
  code: 1,
  signal: null,
  killed: false,
  termination: "exit",
};

export const npmCommandFailureCases: Array<{
  label: string;
  npmResult: SpawnResult;
  expectedDetail: string;
}> = [
  {
    label: "stderr before stdout",
    npmResult: { ...emptyNpmFailure, stderr: " registry unavailable ", stdout: "ignored" },
    expectedDetail: "registry unavailable",
  },
  {
    label: "stdout when stderr is blank",
    npmResult: { ...emptyNpmFailure, stderr: " ", stdout: " registry unavailable " },
    expectedDetail: "registry unavailable",
  },
  {
    label: "exit code without output",
    npmResult: emptyNpmFailure,
    expectedDetail: "exit code 1 (no output from npm)",
  },
  {
    label: "signal without output",
    npmResult: {
      ...emptyNpmFailure,
      code: null,
      signal: "SIGKILL",
      killed: true,
      termination: "signal",
    },
    expectedDetail: "signal SIGKILL (no output from npm)",
  },
  {
    label: "abort before spawn",
    npmResult: { ...emptyNpmFailure, code: null, termination: "signal" },
    expectedDetail: "termination signal (no output from npm)",
  },
  {
    label: "cancellation followed by a nonzero exit",
    npmResult: { ...emptyNpmFailure, termination: "signal", killed: true },
    expectedDetail: "termination signal (no output from npm)",
  },
  ...(["timeout", "no-output-timeout"] as const).map((termination) => ({
    label: `${termination} with normalized exit code`,
    npmResult: {
      ...emptyNpmFailure,
      code: 124,
      signal: "SIGTERM" as const,
      killed: true,
      termination,
    },
    expectedDetail: `termination ${termination} (no output from npm)`,
  })),
];

type InstallResultLike = {
  ok: boolean;
  error?: string;
};

type NpmPackMetadata = {
  id: string;
  name: string;
  version: string;
  filename: string;
  integrity: string;
  shasum: string;
};

type NpmViewMetadata = {
  name: string;
  version: string;
  integrity?: string;
  shasum?: string;
};

// Keep spawn doubles shaped like the real process helper so install tests stay narrow.
function createSuccessfulSpawnResult(stdout = ""): SpawnResult {
  return {
    code: 0,
    stdout,
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
  };
}

/** Mocks npm view JSON metadata for package install validation tests. */
export function mockNpmViewMetadataResult(
  run: {
    mockImplementation: (
      implementation: (
        argv: string[],
        optionsOrTimeout: number | CommandOptions,
      ) => Promise<SpawnResult>,
    ) => unknown;
  },
  metadata: NpmViewMetadata,
) {
  run.mockImplementation(async (argv) => {
    if (argv[0] !== "npm" || argv[1] !== "view") {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }

    return createSuccessfulSpawnResult(
      JSON.stringify({
        name: metadata.name,
        version: metadata.version,
        dist: {
          integrity: metadata.integrity,
          shasum: metadata.shasum,
        },
      }),
    );
  });
}

export async function expectUnsupportedNpmSpec(
  install: (spec: string) => Promise<InstallResultLike>,
  spec = "github:evil/evil",
) {
  const result = await install(spec);
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.error).toContain("unsupported npm spec");
}

export function mockNpmPackMetadataResult(
  run: {
    mockImplementation: (
      implementation: (
        argv: string[],
        optionsOrTimeout: number | CommandOptions,
      ) => Promise<SpawnResult>,
    ) => unknown;
  },
  metadata: NpmPackMetadata,
) {
  run.mockImplementation(async (argv, optionsOrTimeout) => {
    if (argv[0] !== "npm" || argv[1] !== "pack") {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }

    const cwd =
      typeof optionsOrTimeout === "object" && optionsOrTimeout !== null
        ? optionsOrTimeout.cwd
        : undefined;
    if (cwd) {
      fs.writeFileSync(path.join(cwd, metadata.filename), "");
    }

    return createSuccessfulSpawnResult(JSON.stringify([metadata]));
  });
}

export function expectIntegrityDriftRejected(params: {
  onIntegrityDrift: (...args: unknown[]) => unknown;
  result: InstallResultLike;
  expectedIntegrity: string;
  actualIntegrity: string;
}) {
  expect(params.onIntegrityDrift).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedIntegrity: params.expectedIntegrity,
      actualIntegrity: params.actualIntegrity,
    }),
  );
  expect(params.result.ok).toBe(false);
  if (params.result.ok) {
    return;
  }
  expect(params.result.error).toContain("integrity drift");
}

export async function expectInstallUsesIgnoreScripts(params: {
  run: {
    mockResolvedValue: (value: SpawnResult) => unknown;
    mock: { calls: unknown[][] };
  };
  install: () => Promise<
    | {
        ok: true;
        targetDir: string;
      }
    | {
        ok: false;
        error?: string;
      }
  >;
}) {
  params.run.mockResolvedValue(createSuccessfulSpawnResult());
  const result = await params.install();
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expectSingleNpmInstallIgnoreScriptsCall({
    calls: params.run.mock.calls as Array<[unknown, { cwd?: string } | undefined]>,
    expectedTargetDir: result.targetDir,
  });
}
