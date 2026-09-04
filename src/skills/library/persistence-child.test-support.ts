import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PERSISTENCE_SESSION_ID,
  PERSISTENCE_SESSION_KEY,
  persistenceFiles,
  type PersistenceCommand,
  type PersistenceReply,
} from "./persistence.test-support.js";

async function send(
  message:
    | PersistenceReply
    | { kind: "ready" | "booted" }
    | { kind: "error"; error: string }
    | { kind: "phase"; phase: string },
) {
  await new Promise<void>((resolve, reject) => {
    assert.ok(typeof process.send === "function");
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function phase(label: string) {
  await send({ kind: "phase", phase: label });
}

async function beginOperation() {
  // Readiness means imports are complete. The parent starts the operation clock
  // before releasing this gate, so startup cannot spend the publication budget.
  const start = new Promise<void>((resolve) => {
    process.once("message", () => resolve());
  });
  await send({ kind: "ready" });
  await start;
  await phase("operation-start");
}

async function hold() {
  // The IPC listener keeps the publisher alive without a sleep or production testing flag.
  await new Promise<void>((resolve) => {
    process.once("message", () => resolve());
  });
}

type OlderReaderRuntime = Pick<
  typeof import("../../state/openclaw-state-db.js"),
  | "openOpenClawStateDatabase"
  | "openExistingOpenClawStateDatabaseReadOnly"
  | "closeOpenClawStateDatabase"
> &
  Pick<
    typeof import("../../state/openclaw-agent-db.js"),
    "openOpenClawAgentDatabase" | "closeOpenClawAgentDatabases"
  > &
  Pick<
    typeof import("../../state/user-preferences.js"),
    "getUserPreferences" | "setUserPreferences"
  > &
  Pick<
    typeof import("../../config/sessions/session-accessor.sqlite-entry.js"),
    "loadSessionEntry" | "upsertSessionEntryCore"
  > & { OPENCLAW_STATE_SCHEMA_VERSION: number; OPENCLAW_AGENT_SCHEMA_VERSION: number };

async function runOlderReader(
  entrypoint: string,
  profileId: string,
  root: string,
): Promise<PersistenceReply> {
  // This branch imports only the supplied baseline executable. Type-only imports above
  // describe its exports and cannot load the candidate's schema/parser/store.
  await phase("baseline-import");
  const old = (await import(pathToFileURL(entrypoint).href)) as OlderReaderRuntime;
  assert.equal(old.OPENCLAW_STATE_SCHEMA_VERSION, 15);
  assert.equal(old.OPENCLAW_AGENT_SCHEMA_VERSION, 19);
  await phase("imports-complete");
  await beginOperation();
  const options = { env: process.env, path: path.join(root, "state", "openclaw.sqlite") };
  const scope = { env: process.env, agentId: "main", sessionKey: PERSISTENCE_SESSION_KEY };
  try {
    const readOnly = await old.openExistingOpenClawStateDatabaseReadOnly(options);
    assert.ok(readOnly);
    readOnly.walMaintenance.close();
    const state = old.openOpenClawStateDatabase(options);
    assert.equal(
      old.setUserPreferences(profileId, { "library.persistence.legacy": true }, options).ok,
      true,
    );
    assert.deepEqual(old.getUserPreferences(profileId, ["library.persistence.legacy"], options), {
      "library.persistence.legacy": true,
    });
    assert.ok(old.loadSessionEntry(scope));
    const updated = await old.upsertSessionEntryCore(scope, { label: "Edited by baseline reader" });
    assert.equal(updated?.label, "Edited by baseline reader");
    const agent = old.openOpenClawAgentDatabase({ agentId: "main", env: process.env });
    return {
      kind: "older-reader",
      stateVersion: Number(state.db.prepare("PRAGMA user_version").get()?.user_version),
      agentVersion: Number(agent.db.prepare("PRAGMA user_version").get()?.user_version),
    };
  } finally {
    old.closeOpenClawAgentDatabases();
    old.closeOpenClawStateDatabase();
  }
}

async function runCandidate(
  command: Exclude<PersistenceCommand, { action: "older-reader" }>,
  root: string,
): Promise<PersistenceReply> {
  await phase("bundle-import");
  const bundle = await import("./bundle.js");
  if (command.action === "stage-hold") {
    await beginOperation();
    await phase("stage-operation");
    const staged = await bundle.stageSkillLibraryBundle(
      command.pin.skillId,
      bundle.prepareSkillLibraryBundle(persistenceFiles(command.version)),
      process.env,
    );
    try {
      await send({ kind: "staged", directory: staged.staging });
      await hold();
    } finally {
      await staged.cleanup();
    }
    return { kind: "complete" };
  }
  await phase("state-import");
  const state = await import("../../state/openclaw-state-db.js");
  await phase("profiles-import");
  const { ensureProfileForEmail } = await import("../../state/user-profiles.js");
  await phase("service-import");
  const service = await import("./service.js");
  const usesSessions = ["seed", "read", "update-remove"].includes(command.action);
  await phase("session-imports");
  const sessions = usesSessions
    ? await import("../../config/sessions/session-accessor.sqlite-entry.js")
    : undefined;
  const agent = usesSessions ? await import("../../state/openclaw-agent-db.js") : undefined;
  const selection = usesSessions ? await import("./selection.js") : undefined;
  const uploads = command.action === "seed" ? await import("./import.js") : undefined;
  await phase("imports-complete");
  await beginOperation();
  const options = { env: process.env, path: path.join(root, "state", "openclaw.sqlite") };
  const scope = { env: process.env, agentId: "main", sessionKey: PERSISTENCE_SESSION_KEY };
  const draft = (version: "old" | "new" | "orphan", slug: string) => {
    const [instructions, ...files] = persistenceFiles(version);
    return { slug, content: instructions!.content, files };
  };
  try {
    await phase("profile-open");
    const profile = ensureProfileForEmail("persistence@example.test", options);
    await phase("profile-ready");
    const authority = {
      profileId: profile.id,
      scopes: ["operator.admin"],
      getConfig: () => ({}),
      assertCurrent: () => {},
    };
    if (command.action === "seed") {
      assert.ok(sessions && selection && uploads);
      for (const ownership of ["personal", "team"]) {
        const result = await service.saveSkillLibrary(
          authority,
          { ...draft("old", `persistence-${ownership}`), expectedRevision: null },
          options,
        );
        if (ownership === "team") {
          service.mutateSkillLibrary(
            authority,
            {
              skillId: result.entry.skillId,
              expectedRevision: result.entry.revision,
              action: "transfer",
            },
            options,
          );
        }
      }
      const pins = selection.seedSkillLibrarySelection(authority, options);
      sessions.replaceSessionEntrySync(scope, {
        sessionId: PERSISTENCE_SESSION_ID,
        updatedAt: Date.now(),
        skillLibrarySelections: pins,
      });
      const { uploadSkillLibrary } = uploads;
      const pendingBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      const upload = await uploadSkillLibrary(
        authority,
        {
          action: "begin",
          slug: "unfinished-import",
          sizeBytes: pendingBytes.length,
          sha256: createHash("sha256").update(pendingBytes).digest("hex"),
        },
        options,
      );
      assert.ok("uploadId" in upload);
      await uploadSkillLibrary(
        authority,
        {
          action: "chunk",
          uploadId: upload.uploadId,
          offset: 0,
          data: pendingBytes.subarray(0, 2).toString("base64"),
        },
        options,
      );
      return { kind: "seeded", profileId: profile.id, pins };
    }
    const pins = sessions?.loadSessionEntry(scope)?.skillLibrarySelections;
    if (command.action === "read") {
      assert.ok(pins && selection);
      const catalog = selection.loadSkillLibrarySelection(pins, options);
      return {
        kind: "selected",
        pins,
        files: await Promise.all(
          pins.map((pin) => selection.readSelectedSkillLibraryFiles(pin, options)),
        ),
        catalog: catalog.map((entry) => ({ name: entry.skill.name, baseDir: entry.skill.baseDir })),
        available: service
          .listSkillLibrary(authority, {}, options)
          .entries.map((entry) => entry.skillId),
      };
    }
    if (command.action === "update-remove") {
      assert.ok(pins);
      for (const pin of pins) {
        const saved = await service.saveSkillLibrary(
          authority,
          {
            ...draft("new", "renamed-procedure"),
            skillId: pin.skillId,
            expectedRevision: pin.revision,
          },
          options,
        );
        service.mutateSkillLibrary(
          authority,
          { skillId: pin.skillId, expectedRevision: saved.entry.revision, action: "remove" },
          options,
        );
      }
      return { kind: "complete" };
    }
    const originalOpen = fs.open;
    const originalRename = fs.rename;
    let renamedDestination: string | undefined;
    if (command.action === "publish-hold") {
      const expectedDestination = bundle.skillLibraryRevisionDir(
        command.pin.skillId,
        bundle.prepareSkillLibraryBundle(persistenceFiles(command.version)).revision,
        process.env,
      );
      fs.rename = async (source, destination) => {
        await originalRename(source, destination);
        if (destination === expectedDestination) {
          renamedDestination = expectedDestination;
        }
      };
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        if (renamedDestination && args[0] === root && args[1] === "r") {
          const originalClose = handle.close.bind(handle);
          handle.close = async () => {
            handle.close = originalClose;
            await originalClose();
            // The real rename, file syncs, and final ancestor-directory sync/close
            // have completed. Holding here keeps the service before its DB commit.
            await send({ kind: "published", directory: renamedDestination! });
            await hold();
          };
        }
        return handle;
      };
    }
    try {
      await phase("save-operation");
      await service.saveSkillLibrary(
        authority,
        {
          ...draft(command.version, "revised-procedure"),
          skillId: command.pin.skillId,
          expectedRevision: command.pin.revision,
        },
        options,
      );
    } finally {
      fs.open = originalOpen;
      fs.rename = originalRename;
    }
    return { kind: "complete" };
  } finally {
    agent?.closeOpenClawAgentDatabases();
    state.closeOpenClawStateDatabase();
  }
}

process.once("message", (command: PersistenceCommand) => {
  void (async () => {
    try {
      await phase("command-received");
      const root = process.env.OPENCLAW_STATE_DIR;
      assert.ok(root);
      const reply =
        command.action === "older-reader"
          ? await runOlderReader(command.entrypoint, command.profileId, root)
          : await runCandidate(command, root);
      await send(reply);
    } catch (error) {
      process.exitCode = 1;
      await send({
        kind: "error",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    } finally {
      assert.ok(typeof process.disconnect === "function");
      process.disconnect();
    }
  })();
});
await send({ kind: "booted" });
