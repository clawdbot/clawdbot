import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runManagedCommand } from "../managed-child-process.mjs";

function appendTail(current: string, chunk: unknown) {
  const next = Buffer.from(current + Buffer.from(chunk as Uint8Array).toString("utf8"));
  return next.subarray(-(64 * 1024)).toString("utf8");
}

export async function runManagedContainer(params: {
  args: string[];
  logPath: string;
  name: string;
  timeoutMs: number;
  runCommand?: typeof runManagedCommand;
}) {
  if (!/^openclaw-[a-z0-9-]+$/u.test(params.name)) {
    throw new Error(`Invalid managed container name: ${params.name}`);
  }
  const runCommand = params.runCommand ?? runManagedCommand;
  let diagnostic = "";
  let probeOutput = "";
  const run = (args: string[], timeoutMs: number, capture = false, probe = false) =>
    runCommand({
      bin: "docker",
      args,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
      timeoutMs,
      requireProcessTreeExit: true,
      onReady: capture
        ? (child) => {
            child.stdout?.on("data", (chunk) => {
              diagnostic = appendTail(diagnostic, chunk);
              if (probe) {
                probeOutput = appendTail(probeOutput, chunk);
              }
            });
            child.stderr?.on("data", (chunk) => {
              diagnostic = appendTail(diagnostic, chunk);
            });
          }
        : undefined,
    });
  let status = 1;
  let failure: unknown;
  let cleanupFailed = false;
  const ownershipDir = mkdtempSync(join(tmpdir(), "openclaw-managed-container-"));
  const cidfile = join(ownershipDir, "container.cid");
  try {
    status = await run(
      [
        "run",
        "--cidfile",
        cidfile,
        "--name",
        params.name,
        "--rm",
        "--log-driver",
        "none",
        ...params.args,
      ],
      params.timeoutMs,
      true,
    );
  } catch (error) {
    failure = error;
  } finally {
    // A name collision must never let this invocation remove another owner's container.
    const ownedContainerId = (() => {
      try {
        return readFileSync(cidfile, "utf8").trim();
      } catch {
        return "";
      }
    })();
    if (ownedContainerId) {
      await run(["rm", "--force", ownedContainerId], 30_000).catch(() => undefined);
      const probeStatus = await run(
        ["ps", "--all", "--quiet", "--filter", `id=${ownedContainerId}`],
        30_000,
        true,
        true,
      ).catch(() => -1);
      cleanupFailed = probeStatus !== 0 || probeOutput.trim() !== "";
    }
    rmSync(ownershipDir, { recursive: true, force: true });
  }
  mkdirSync(dirname(params.logPath), { recursive: true });
  const redacted = diagnostic
    .replaceAll(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replaceAll(/[A-Za-z0-9_-]{32,}/gu, "[redacted]");
  writeFileSync(params.logPath, redacted, "utf8");
  if (cleanupFailed) {
    throw new Error(
      `Managed container ${params.name} remained or cleanup could not be verified.\n${redacted}`,
    );
  }
  if (failure || status !== 0) {
    const reason = failure instanceof Error ? failure.message : `status ${status}`;
    throw new Error(`Managed container ${params.name} failed: ${reason}.\n${redacted}`, {
      cause: failure,
    });
  }
}
