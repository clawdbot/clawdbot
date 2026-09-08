import { z } from "zod";
import { resolveNodeStartupTlsEnvironment } from "../../bootstrap/node-startup-env.js";
import {
  GatewayServiceStagedFilesSchema,
  type GatewayServiceStagedFiles,
} from "../../daemon/service-stage.js";
import { spawnCommand } from "../../process/exec.js";

/** Supplied by the executor; evidence from the child does not grant authority. */
export type UpdateServiceLoadBoundary = {
  assertCurrent: () => void;
  seal: (staged: GatewayServiceStagedFiles, signal: AbortSignal) => Promise<void>;
};
export class UpdateServiceLoadBoundaryError extends Error {
  override name = "UpdateServiceLoadBoundaryError";
}
const stagedMessage = z.strictObject({
  type: z.literal("openclaw-service-staged"),
  id: z.uuid(),
  staged: GatewayServiceStagedFilesSchema,
});

/** Run the installed runtime, retain its writer, then release only after sealing. */
export async function runGatewayInstallWithLoadBoundary(params: {
  argv: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  boundary: UpdateServiceLoadBoundary;
}): Promise<"unverified"> {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(60_000),
    ...(params.signal ? [params.signal] : []),
  ]);
  signal.throwIfAborted();
  params.boundary.assertCurrent();
  const child = spawnCommand(params.argv, {
    baseEnv: {},
    env: {
      ...params.env,
      ...resolveNodeStartupTlsEnvironment({
        env: params.env,
        execPath: params.argv[0],
        includeDarwinDefaults: false,
      }),
      OPENCLAW_NO_RESPAWN: "1",
    },
    cwd: params.cwd,
    ipc: true,
    cancelSignal: signal,
    forceKillAfterDelay: 300,
    stdin: "ignore",
    maxBuffer: 1024 * 1024,
    reject: false,
  });
  let handoff: Promise<void> | undefined;
  let approved = false;
  let failure: unknown;
  const onMessage = (message: unknown) => {
    if (handoff) {
      failure = new Error("Repeated staged-service handoff.");
      controller.abort();
      return;
    }
    handoff = (async () => {
      const parsed = stagedMessage.parse(message);
      signal.throwIfAborted();
      params.boundary.assertCurrent();
      await params.boundary.seal(parsed.staged, signal);
      signal.throwIfAborted();
      params.boundary.assertCurrent();
      if (!child.nodeChildProcess.connected) {
        throw new Error("Target runtime exited before service-load handoff.");
      }
      await new Promise<void>((resolve, reject) => {
        child.nodeChildProcess.send({ type: "openclaw-service-load", id: parsed.id }, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      approved = true;
    })().catch((error: unknown) => {
      failure = error;
      controller.abort();
    });
  };
  child.nodeChildProcess.on("message", onMessage);
  try {
    const result = await child;
    // Settlement cancels a still-running seal; its caller must honor this signal.
    if (!approved) {
      controller.abort();
    }
    await handoff;
    params.signal?.throwIfAborted();
    params.boundary.assertCurrent();
    if (failure || !approved || result.failed || result.exitCode !== 0) {
      throw new UpdateServiceLoadBoundaryError(
        "Staged gateway install did not complete its sealed load.",
        { cause: failure },
      );
    }
    return "unverified";
  } catch (cause) {
    controller.abort();
    await handoff;
    throw new UpdateServiceLoadBoundaryError(
      "Gateway service load boundary failed; retain staged recovery material.",
      { cause },
    );
  } finally {
    child.nodeChildProcess.off("message", onMessage);
  }
}
