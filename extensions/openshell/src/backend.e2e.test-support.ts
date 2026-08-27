import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { SandboxBackendHandle, SandboxFsBridge } from "openclaw/plugin-sdk/sandbox";
import { expect } from "vitest";

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function runCommand(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timeout =
      params.timeoutMs && params.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, params.timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        reject(new Error(`command timed out: ${params.command} ${params.args.join(" ")}`));
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !params.allowFailure) {
        const message = [
          `command failed: ${params.command} ${params.args.join(" ")}`,
          `exit: ${exitCode}`,
        ];
        const trimmedStdout = stdout.trim();
        if (trimmedStdout.length > 0) {
          message.push(`stdout:\n${stdout}`);
        }
        const trimmedStderr = stderr.trim();
        if (trimmedStderr.length > 0) {
          message.push(`stderr:\n${stderr}`);
        }
        reject(new Error(message.join("\n")));
        return;
      }
      resolve({ code: exitCode, stdout, stderr });
    });

    child.stdin.end(params.stdin);
  });
}

export async function runBackendExec(params: {
  backend: SandboxBackendHandle;
  command: string;
  env?: Record<string, string>;
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  const execSpec = await params.backend.buildExecSpec({
    command: params.command,
    env: params.env ?? {},
    usePty: false,
  });
  return await runPreparedBackendExec({ ...params, execSpec });
}

export async function runPreparedBackendExec(params: {
  backend: SandboxBackendHandle;
  execSpec: Awaited<ReturnType<SandboxBackendHandle["buildExecSpec"]>>;
  allowFailure?: boolean;
  timeoutMs?: number;
}): Promise<ExecResult> {
  const { execSpec } = params;
  let result: ExecResult | null | undefined;
  try {
    result = await runCommand({
      command: execSpec.argv[0] ?? "ssh",
      args: execSpec.argv.slice(1),
      env: execSpec.env,
      allowFailure: params.allowFailure,
      timeoutMs: params.timeoutMs,
    });
    return result;
  } finally {
    await params.backend.finalizeExec?.({
      status: result?.code === 0 ? "completed" : "failed",
      exitCode: result?.code ?? 1,
      timedOut: false,
      token: execSpec.finalizeToken,
    });
  }
}

export async function stressBackend(params: {
  backends: Array<Parameters<typeof runBackendExec>[0]["backend"]>;
  bridge: SandboxFsBridge;
  mode: "mirror" | "remote";
  workspaceDir: string;
}): Promise<void> {
  const startedAt = Date.now();
  const expectedIds: string[] = [];
  const latencies: number[] = [];
  const waves = 8;
  const concurrency = 8;
  for (let wave = 0; wave < waves; wave++) {
    // Keep all writes under one directory so mirror upload cost stays independent of task count.
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, async (_, slot) => {
        const id = `${wave}-${slot}`;
        const started = Date.now();
        const backend = params.backends[(wave + Math.floor(slot / 2)) % params.backends.length]!;
        if (slot % 2 === 0) {
          expectedIds.push(id);
          const exitCode = slot === 0 ? 23 : 0;
          const result = await runBackendExec({
            backend,
            command: `mkdir -p stress; n=$(cat stress/count 2>/dev/null || echo 0); sleep 0.02; printf '%s\\n' "$((n + 1))" > stress/count; printf '%s\\n' '${id}' >> stress/ledger; printf '%s' "$STRESS_VALUE" > 'stress/@exec-${id}'; exit ${exitCode}`,
            env: { STRESS_VALUE: `value-${id}` },
            allowFailure: true,
            timeoutMs: 60_000,
          });
          expect(result.code).toBe(exitCode);
        } else {
          const filePath = `stress/@file-${id}`;
          await params.bridge.writeFile({ filePath, data: id, mkdir: true });
          const temporaryPath = `stress/tmp-${id}`;
          switch (slot) {
            case 1:
              await expect(
                params.bridge.createFileExclusive?.({ filePath, data: "overwrite" }),
              ).resolves.toBe("exists");
              break;
            case 3:
              await expect(
                params.bridge.createFileExclusive?.({ filePath: temporaryPath, data: id }),
              ).resolves.toBe("created");
              await params.bridge.rename({ from: temporaryPath, to: `stress/@renamed-${id}` });
              break;
            case 5:
              await params.bridge.mkdirp({ filePath: temporaryPath });
              await params.bridge.remove({ filePath: temporaryPath, recursive: true });
              break;
            case 7:
              await expect(params.bridge.stat({ filePath })).resolves.toMatchObject({
                type: "file",
                size: Buffer.byteLength(id),
              });
              break;
          }
        }
        latencies.push(Date.now() - started);
      }),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "OpenShell stress wave failed",
      );
    }
    await expect(params.bridge.readFile({ filePath: `stress/@file-${wave}-1` })).resolves.toEqual(
      Buffer.from(`${wave}-1`),
    );
    console.log(
      JSON.stringify({
        probe: "openshell-stress-progress",
        mode: params.mode,
        completedWorkflows: (wave + 1) * concurrency,
        elapsedMs: Date.now() - startedAt,
      }),
    );
  }
  // Read the remote tree without exec preparation: a fresh mirror upload could hide divergence.
  const inventory = await params.backends[0]!.runShellCommand({
    script: `python3 -c 'import json,pathlib,sys; root=pathlib.Path(sys.argv[1]); print(json.dumps({str(p.relative_to(root)):p.read_text() for p in root.rglob("*") if p.is_file()}))' "$1"`,
    args: [`${params.backends[0]!.workdir}/stress`],
  });
  const remoteFiles = JSON.parse(inventory.stdout.toString("utf8")) as Record<string, string>;
  const ledger = expectDefined(remoteFiles.ledger, "OpenShell remote command ledger");
  expect(ledger.trim().split("\n").toSorted()).toEqual(expectedIds.toSorted());
  const expectedFiles: Record<string, string> = {
    ledger,
    count: `${expectedIds.length}\n`,
  };
  for (let wave = 0; wave < waves; wave++) {
    for (let slot = 0; slot < concurrency; slot++) {
      const id = `${wave}-${slot}`;
      const filePath = `stress/@${slot % 2 === 0 ? "exec" : "file"}-${id}`;
      const expected = slot % 2 === 0 ? `value-${id}` : id;
      expectedFiles[path.posix.basename(filePath)] = expected;
      if (slot === 3) {
        expectedFiles[`@renamed-${id}`] = id;
      }
    }
  }
  expect(remoteFiles).toEqual(expectedFiles);
  if (params.mode === "mirror") {
    expect((await fs.readdir(path.join(params.workspaceDir, "stress"))).toSorted()).toEqual(
      Object.keys(expectedFiles).toSorted(),
    );
    for (const [file, expected] of Object.entries(expectedFiles)) {
      await expect(params.bridge.readFile({ filePath: `stress/${file}` })).resolves.toEqual(
        Buffer.from(expected),
      );
    }
  }
  if (params.mode === "remote") {
    await expect(fs.stat(path.join(params.workspaceDir, "stress"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  const orderedLatencies = latencies.toSorted((a, b) => a - b);
  console.log(
    JSON.stringify({
      probe: "openshell-stress",
      mode: params.mode,
      workflows: waves * concurrency,
      concurrency,
      commands: expectedIds.length,
      intentionalCommandFailures: waves,
      elapsedMs: Date.now() - startedAt,
      p50Ms: orderedLatencies[Math.floor(latencies.length / 2)],
      p95Ms: orderedLatencies[Math.floor(latencies.length * 0.95)],
      verifiedFiles: Object.keys(expectedFiles).length - 2,
    }),
  );
}
