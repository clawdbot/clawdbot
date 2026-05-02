import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { CommandOptions, SpawnResult } from "../process/exec.js";
import { expectSingleNpmInstallIgnoreScriptsCall } from "./exec-assertions.js";

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
