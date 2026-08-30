import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { terminateCodexAppServerOrphan } from "./transport-process-containment.js";
import {
  readCodexAppServerProcess,
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
} from "./transport-process-snapshot.js";

const processIdentity = z.object({
  pid: z.number().int().positive().safe(),
  pgid: z.number().int().positive().safe(),
  startedAt: z.string().min(1).max(64),
});
const childIdentity = processIdentity.extend({
  // Durable rows hold only a digest: appServer.args is operator-configurable and
  // may carry secrets, matching the spawn-identity argsFingerprint precedent.
  // Unreleased dev/nightly rows stay reapable with identity-only authority instead
  // of blocking spawns. Require the fingerprint at the next natural schema touch.
  commandFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const registrationSchema = z.object({ parent: processIdentity, child: childIdentity }).strict();
type ProcessRegistration = z.infer<typeof registrationSchema>;

function fingerprintProcessCommand(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

async function openProcessRegistrationStore() {
  const { createPluginStateSyncKeyedStore } =
    await import("openclaw/plugin-sdk/plugin-state-store-runtime");
  return createPluginStateSyncKeyedStore<ProcessRegistration>("codex", {
    namespace: "app-server-processes",
    maxEntries: 512,
    // Expiration or eviction could forget a child that still owns a native turn.
    overflowPolicy: "reject-new",
  });
}

async function reapRegisteredCodexAppServerOrphans(requestedDeadline?: number): Promise<void> {
  const store = await openProcessRegistrationStore();
  const deadline = requestedDeadline ?? Date.now() + 10_000;
  for (const entry of store.entries()) {
    if (Date.now() >= deadline) {
      throw new Error("Codex orphan cleanup exceeded its startup budget. Retry to finish cleanup.");
    }
    const registration = registrationSchema.parse(entry.value);
    const snapshot = await readCodexAppServerProcessSnapshot();
    if (!snapshot?.some((row) => row.pid === process.pid)) {
      throw new Error(
        "Cannot inspect registered Codex processes. Check process inspection permissions (/proc on Linux, ps on macOS), then retry.",
      );
    }
    const parent = snapshot.find((row) => row.pid === registration.parent.pid);
    if (parent?.startedAt === registration.parent.startedAt && !parent.state.startsWith("Z")) {
      continue;
    }
    const child = snapshot.find((row) => row.pid === registration.child.pid);
    if (
      registration.child.commandFingerprint !== undefined &&
      child?.startedAt === registration.child.startedAt &&
      !child.state.startsWith("Z")
    ) {
      const command = await readCodexAppServerProcessCommand(registration.child.pid, deadline);
      if (command === undefined) {
        const current = await readCodexAppServerProcess(registration.child.pid, deadline);
        if (current?.startedAt === registration.child.startedAt) {
          throw new Error(
            `Cannot inspect registered Codex process ${registration.child.pid} command. Check process command inspection permissions (/proc on Linux, ps on macOS), then retry.`,
          );
        }
      } else if (fingerprintProcessCommand(command) !== registration.child.commandFingerprint) {
        // macOS lstart has second granularity: a replacement can inherit pid +
        // startedAt. A different command revokes kill authority; Linux already
        // uses tick-granular start identities.
        store.delete(entry.key);
        continue;
      }
    }
    if (!(await terminateCodexAppServerOrphan(registration.child))) {
      throw new Error(
        `Cannot reap registered Codex process ${registration.child.pid}. Stop it before retrying.`,
      );
    }
    store.delete(entry.key);
  }
}

export function createCodexAppServerProcessReaperService(): OpenClawPluginService {
  return {
    id: "codex-app-server-process-reaper",
    start(ctx) {
      if (process.platform === "win32") {
        return;
      }
      // Boot cleanup is best-effort promptness. The before-spawn check remains
      // authoritative and fails closed without delaying Gateway startup.
      void (async () => {
        try {
          await reapRegisteredCodexAppServerOrphans();
        } catch (error) {
          ctx.logger.warn(`Codex app-server orphan cleanup failed: ${String(error)}`);
        }
      })();
    },
  };
}

/** Reap previous owners before spawn; commit this child's identity before initialization. */
export async function prepareCodexAppServerProcessRegistration(): Promise<
  (child: ChildProcessWithoutNullStreams) => Promise<void>
> {
  if (process.platform === "win32") {
    return async (child) => {
      await once(child, "spawn");
    };
  }
  await reapRegisteredCodexAppServerOrphans();
  const store = await openProcessRegistrationStore();
  return async (child) => {
    await once(child, "spawn");
    const snapshot = await readCodexAppServerProcessSnapshot();
    const parent = snapshot?.find((row) => row.pid === process.pid);
    const spawned = snapshot?.find((row) => row.pid === child.pid);
    if (!parent || !spawned || spawned.ppid !== process.pid) {
      throw new Error(
        "Cannot register the Codex child process. Check process inspection permissions (/proc on Linux, ps on macOS), then retry.",
      );
    }
    const command = await readCodexAppServerProcessCommand(spawned.pid, Date.now() + 2_000);
    if (command === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        "Cannot register the Codex child process command. Check process command inspection permissions (/proc on Linux, ps on macOS), then retry.",
      );
    }
    const key = randomUUID();
    // Codex rejects non-initialize requests; no native turn can start before
    // this synchronous commit. A failed commit closes the uninitialized child.
    store.register(key, {
      parent: processIdentity.parse(parent),
      child: childIdentity.parse({
        ...spawned,
        commandFingerprint: fingerprintProcessCommand(command),
      }),
    });
    child.once("exit", () => {
      try {
        store.delete(key);
      } catch {
        // Leave the durable fact for the next connection to verify and remove.
      }
    });
  };
}
