import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import {
  readCodexAppServerProcessSnapshot,
  terminateCodexAppServerOrphan,
} from "./transport-process-containment.js";

const processIdentity = z.object({
  pid: z.number().int().positive().safe(),
  pgid: z.number().int().positive().safe(),
  startedAt: z.string().min(1).max(64),
});
const registrationSchema = z.object({ parent: processIdentity, child: processIdentity }).strict();
type ProcessRegistration = z.infer<typeof registrationSchema>;

/** Reap previous owners before spawn; commit this child's identity before initialization. */
export async function prepareCodexAppServerProcessRegistration(): Promise<
  (child: ChildProcessWithoutNullStreams) => Promise<void>
> {
  if (process.platform === "win32") {
    return async (child) => {
      await once(child, "spawn");
    };
  }
  const { createPluginStateSyncKeyedStore } =
    await import("openclaw/plugin-sdk/plugin-state-store-runtime");
  const store = createPluginStateSyncKeyedStore<ProcessRegistration>("codex", {
    namespace: "app-server-processes",
    maxEntries: 512,
    // Expiration or eviction could forget a child that still owns a native turn.
    overflowPolicy: "reject-new",
  });
  const deadline = Date.now() + 10_000;
  for (const entry of store.entries()) {
    if (Date.now() >= deadline) {
      throw new Error("Codex orphan cleanup exceeded its startup budget. Retry to finish cleanup.");
    }
    const registration = registrationSchema.parse(entry.value);
    const snapshot = await readCodexAppServerProcessSnapshot();
    if (!snapshot?.some((row) => row.pid === process.pid)) {
      throw new Error(
        "Cannot inspect registered Codex processes. Check that ps works, then retry.",
      );
    }
    const parent = snapshot.find((row) => row.pid === registration.parent.pid);
    if (parent?.startedAt === registration.parent.startedAt && !parent.state.startsWith("Z")) {
      continue;
    }
    if (!(await terminateCodexAppServerOrphan(registration.child))) {
      throw new Error(
        `Cannot reap registered Codex process ${registration.child.pid}. Stop it before retrying.`,
      );
    }
    store.delete(entry.key);
  }
  return async (child) => {
    try {
      await once(child, "spawn");
      const snapshot = await readCodexAppServerProcessSnapshot();
      const parent = snapshot?.find((row) => row.pid === process.pid);
      const spawned = snapshot?.find((row) => row.pid === child.pid);
      if (
        !parent ||
        !spawned ||
        spawned.ppid !== process.pid ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        throw new Error(
          "Cannot register the Codex child process. Check that ps works, then retry.",
        );
      }
      const key = randomUUID();
      // Codex rejects non-initialize requests; no native turn can start before
      // this synchronous commit. A failed commit closes the uninitialized child.
      store.register(key, {
        parent: processIdentity.parse(parent),
        child: processIdentity.parse(spawned),
      });
      child.once("exit", () => {
        try {
          store.delete(key);
        } catch {
          // Leave the durable fact for the next connection to verify and remove.
        }
      });
    } catch (error) {
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      throw error;
    }
  };
}
