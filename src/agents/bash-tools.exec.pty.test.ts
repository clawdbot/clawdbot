import { afterEach, expect, test } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

function currentEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
}

function currentNodeEvalCommand(source: string): string {
  const node = shellQuote(process.execPath);
  const script = shellQuote(source);
  return process.platform === "win32" ? `& ${node} -e ${script}` : `${node} -e ${script}`;
}

async function runPtyCommand(command: string) {
  const handle = await runExecProcess({
    command,
    workdir: process.cwd(),
    env: currentEnv(),
    usePty: true,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 5,
  });
  return await handle.promise;
}

test("exec supports pty output", async () => {
  const result = await runPtyCommand(
    currentNodeEvalCommand("process.stdout.write(String.fromCharCode(111,107))"),
  );

  expect(result.status).toBe("completed");
  expect(result.aggregated).toContain("ok");
});

test("exec sets OPENCLAW_SHELL in pty mode", async () => {
  const result = await runPtyCommand(
    currentNodeEvalCommand('process.stdout.write(process.env.OPENCLAW_SHELL || "")'),
  );

  expect(result.status).toBe("completed");
  expect(result.aggregated).toContain("exec");
});
