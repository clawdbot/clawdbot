import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { createGatewaySession } from "../../gateway/session-create-service.js";
import {
  interruptSessionWorkAdmissions,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function assertRecoveryInitializerTypeContract(
  create: ReturnType<typeof createRuntimeAgent>["session"]["createSessionEntry"],
): void {
  // @ts-expect-error Recovery must return the final trusted plugin extension patch.
  void create({
    cfg: {},
    key: "type-contract-only",
    recoverMatchingInitialEntry: true,
    initialEntry: { agentHarnessId: "codex" },
    afterCreate: async () => {},
  });
}
void assertRecoveryInitializerTypeContract;

describe("plugin runtime session creation", () => {
  it("creates a canonical transcript with trusted initial session state", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-session-create" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:harness:codex:supervision:codex-native-thread";
      const initialPluginExtensions = {
        codex: {
          supervision: {
            initializing: true,
            modelLocked: true,
          },
        },
      };
      const finalPluginExtensions = {
        codex: {
          supervision: {
            nativeThreadId: "thread-native-1",
            modelLocked: true,
          },
        },
      };
      let callbackSessionId: string | undefined;

      const created = await runtime.session.createSessionEntry({
        cfg: {},
        key,
        label: "Native Codex thread",
        initialEntry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: initialPluginExtensions,
        },
        afterCreate: async (initialized) => {
          callbackSessionId = initialized.sessionId;
          expect(initialized.entry.initializationPending).toBe(true);
          return { pluginExtensions: finalPluginExtensions };
        },
      });
      initialPluginExtensions.codex.supervision.initializing = false;
      finalPluginExtensions.codex.supervision.nativeThreadId = "mutated-after-create";

      expect(callbackSessionId).toBe(created.sessionId);
      expect(created.entry.initializationPending).toBeUndefined();
      expect(created).toMatchObject({
        key,
        agentId: "main",
        sessionId: created.entry.sessionId,
        entry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          label: "Native Codex thread",
          pluginExtensions: {
            codex: {
              supervision: {
                nativeThreadId: "thread-native-1",
                modelLocked: true,
              },
            },
          },
        },
      });
      const stored = runtime.session.getSessionEntry({
        sessionKey: key,
        readConsistency: "latest",
      });
      expect(stored).toEqual(created.entry);
      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: { agentHarnessId: "other" },
        }),
      ).rejects.toThrow("Session key namespace is reserved for agent harness-owned sessions.");
      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: { agentHarnessId: "codex" },
        }),
      ).rejects.toThrow("trusted initial session state requires a new session");
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toEqual(created.entry);
      expect(stored?.sessionFile).toBeTruthy();
      expect(stored?.sessionFile).toContain(`sqlite:main:${created.sessionId}:`);
    });
  });

  it("creates a plugin-owned locked CLI session with a seeded fork binding", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-cli-session-create" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:catalog-adopt:claude:source";
      const created = await runtime.session.createSessionEntry({
        cfg: {},
        key,
        initialEntry: {
          cliBackendId: "claude-cli",
          model: "claude-opus-4-8",
          modelSelectionLocked: true,
          pluginOwnerId: "anthropic",
          cliSessionBinding: {
            sessionId: "claude-source",
            forceReuse: true,
            forkNextResume: true,
          },
        },
      });
      expect(created.entry).toMatchObject({
        pluginOwnerId: "anthropic",
        providerOverride: "claude-cli",
        modelOverride: "claude-opus-4-8",
        modelSelectionLocked: true,
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "claude-source",
            forceReuse: true,
            forkNextResume: true,
          },
        },
      });
    });
  });

  it("rolls back the exact created entry and transcript when initialization fails", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-session-create-rollback" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:dashboard:codex-binding-failure";
      let sessionFile: string | undefined;

      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: {
            agentHarnessId: "codex",
            modelSelectionLocked: true,
          },
          afterCreate: async (created) => {
            sessionFile = created.entry.sessionFile;
            throw new Error("native binding failed");
          },
        }),
      ).rejects.toThrow("native binding failed");

      expect(runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" })).toBe(
        undefined,
      );
      expect(sessionFile).toBeTruthy();
      expect(fs.existsSync(sessionFile ?? "")).toBe(false);
    });
  });

  it("rolls back a plugin-owned locked CLI session when initialization fails", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-cli-session-rollback" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:catalog-adopt:claude:rollback";
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
      let sessionId: string | undefined;
      let sessionFile: string | undefined;

      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: {
            cliBackendId: "claude-cli",
            model: "claude-opus-4-8",
            modelSelectionLocked: true,
            pluginOwnerId: "anthropic",
            cliSessionBinding: {
              sessionId: "claude-source",
              forceReuse: true,
              forkNextResume: true,
            },
          },
          afterCreate: async (created) => {
            sessionId = created.sessionId;
            sessionFile = created.entry.sessionFile;
            throw new Error("history import failed");
          },
        }),
      ).rejects.toThrow("history import failed");

      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toBeUndefined();
      expect(sessionFile).toBeTruthy();
      expect(sessionFile).toContain(`sqlite:main:${sessionId}:`);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          sessionId: sessionId ?? "",
          sessionKey: key,
          storePath,
        }),
      ).resolves.toEqual([]);
    });
  });

  it("rolls back an unlocked harness entry through the ordinary lifecycle path", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-unlocked-session-create-rollback" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:unlocked-binding-failure";
        let sessionFile: string | undefined;

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: { agentHarnessId: "codex" },
            afterCreate: async (created) => {
              sessionFile = created.entry.sessionFile;
              throw new Error("unlocked native binding failed");
            },
          }),
        ).rejects.toThrow("unlocked native binding failed");

        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toBeUndefined();
        expect(sessionFile).toBeTruthy();
        expect(fs.existsSync(sessionFile ?? "")).toBe(false);
      },
    );
  });

  it("does not run initialization when the durable initial row cannot be written", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-initial-write-failure" },
      async (state) => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-initial-write-failure";
        fs.mkdirSync(path.join(state.agentDir(), "openclaw-agent.sqlite"), { recursive: true });
        let initializerRan = false;

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: {
              agentHarnessId: "codex",
              pluginExtensions: {
                codex: { supervision: { initializing: true } },
              },
            },
            afterCreate: async () => {
              initializerRan = true;
              return { pluginExtensions: {} };
            },
          }),
        ).rejects.toThrow();

        expect(initializerRan).toBe(false);
      },
    );
  });

  it("rolls back the original entry and transcript when final patch persistence fails", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-final-patch-rollback" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-final-patch-failure";
        let sessionFile: string | undefined;

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
              pluginExtensions: {
                codex: { supervision: { initializing: true } },
              },
            },
            afterCreate: async (created) => {
              sessionFile = created.entry.sessionFile;
              return {
                pluginExtensions: {
                  codex: { supervision: { invalidJsonValue: 1n as never } },
                },
              };
            },
          }),
        ).rejects.toThrow();

        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toBeUndefined();
        expect(sessionFile).toBeTruthy();
        expect(fs.existsSync(sessionFile ?? "")).toBe(false);
      },
    );
  });

  it("rolls back an unlocked harness entry when final patch persistence fails", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-unlocked-final-patch-rollback" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:unlocked-final-patch-failure";
        let sessionFile: string | undefined;

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: { agentHarnessId: "codex" },
            afterCreate: async (created) => {
              sessionFile = created.entry.sessionFile;
              return {
                pluginExtensions: {
                  codex: { supervision: { invalidJsonValue: 1n as never } },
                },
              };
            },
          }),
        ).rejects.toThrow();

        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toBeUndefined();
        expect(sessionFile).toBeTruthy();
        expect(fs.existsSync(sessionFile ?? "")).toBe(false);
      },
    );
  });

  it("fences work admission until trusted initialization completes", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-session-create-fence" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:dashboard:codex-binding-fence";
      const callbackStarted = createDeferred();
      const releaseCallback = createDeferred();
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });

      const creation = runtime.session.createSessionEntry({
        cfg: {},
        key,
        initialEntry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: { supervision: { initializing: true } },
          },
        },
        afterCreate: async () => {
          callbackStarted.resolve();
          await releaseCallback.promise;
          return {
            pluginExtensions: {
              codex: { supervision: { modelLocked: true } },
            },
          };
        },
      });
      await callbackStarted.promise;
      expect(isSessionLifecycleMutationActive(storePath, [key])).toBe(true);
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toMatchObject({
        initializationPending: true,
        pluginExtensions: {
          codex: { supervision: { initializing: true } },
        },
      });

      let workRan = false;
      const work = runtime.session.runWithWorkAdmission(
        { storePath, sessionKey: key },
        async () => {
          workRan = true;
        },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(workRan).toBe(false);

      releaseCallback.resolve();
      const created = await creation;
      await work;
      expect(workRan).toBe(true);
      expect(isSessionLifecycleMutationActive(storePath, [key])).toBe(false);
      expect(created.entry.pluginExtensions).toEqual({
        codex: { supervision: { modelLocked: true } },
      });
      expect(created.entry.initializationPending).toBeUndefined();
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toEqual(created.entry);
    });
  });

  it("rejects an ordinary same-key create while trusted initialization is pending", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-ordinary-race" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-initialization-race";
        const callbackStarted = createDeferred();
        const releaseCallback = createDeferred();
        const creation = runtime.session.createSessionEntry({
          cfg: {},
          key,
          label: "Trusted initializer",
          initialEntry: {
            agentHarnessId: "codex",
            pluginExtensions: { codex: { supervision: { initializing: true } } },
          },
          afterCreate: async () => {
            callbackStarted.resolve();
            await releaseCallback.promise;
            return {
              pluginExtensions: { codex: { supervision: { modelLocked: true } } },
            };
          },
        });
        await callbackStarted.promise;

        const raced = await createGatewaySession({
          cfg: {},
          key,
          label: "Public overwrite",
          commandSource: "test",
        });

        expect(raced).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("is still initializing") },
        });
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toMatchObject({
          initializationPending: true,
          label: "Trusted initializer",
          pluginExtensions: { codex: { supervision: { initializing: true } } },
        });

        releaseCallback.resolve();
        const created = await creation;
        expect(created.entry.initializationPending).toBeUndefined();
        expect(created.entry).toMatchObject({
          label: "Trusted initializer",
          pluginExtensions: { codex: { supervision: { modelLocked: true } } },
        });
      },
    );
  });

  it("rejects creation while pre-existing session work is admitted", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-session-create-active" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:dashboard:codex-binding-active";
      const workStarted = createDeferred();
      const releaseWork = createDeferred();
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
      const work = runtime.session.runWithWorkAdmission(
        { storePath, sessionKey: key },
        async () => {
          workStarted.resolve();
          await releaseWork.promise;
        },
      );
      await workStarted.promise;

      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: {
            agentHarnessId: "codex",
            modelSelectionLocked: true,
          },
        }),
      ).rejects.toThrow(`Session "${key}" is still active; retry creation later.`);
      expect(runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" })).toBe(
        undefined,
      );

      releaseWork.resolve();
      await work;
    });
  });

  it("recovers an exact persisted initializer and returns its finalized generation", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-recovery" },
      async (state) => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-recovery";
        const sessionId = "interrupted-initializer";
        const sessionFile = path.join(state.sessionsDir(), `${sessionId}.jsonl`);
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        const initialPluginExtensions = {
          codex: { supervision: { sourceThreadId: "source-1", initializing: true } },
        };
        const persistedPluginExtensions = {
          codex: { supervision: { initializing: true, sourceThreadId: "source-1" } },
        };
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(
          sessionFile,
          `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`,
        );
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: {
            sessionId,
            sessionFile,
            updatedAt: Date.now(),
            initializationPending: true,
            agentHarnessId: "codex",
            modelSelectionLocked: true,
            pluginExtensions: persistedPluginExtensions,
            spawnedCwd: "/workspace/project",
          },
        });

        const recovered = await runtime.session.createSessionEntry({
          cfg: {},
          key,
          spawnedCwd: "/workspace/project",
          recoverMatchingInitialEntry: true,
          initialEntry: {
            agentHarnessId: "codex",
            modelSelectionLocked: true,
            pluginExtensions: initialPluginExtensions,
          },
          afterCreate: async (created) => {
            expect(created.sessionId).toBe(sessionId);
            expect(created.entry.initializationPending).toBe(true);
            return {
              pluginExtensions: {
                codex: { supervision: { sourceThreadId: "source-1", modelLocked: true } },
              },
            };
          },
        });

        expect(recovered.sessionId).toBe(sessionId);
        expect(recovered.entry.initializationPending).toBeUndefined();
        expect(recovered.entry.pluginExtensions).toEqual({
          codex: { supervision: { sourceThreadId: "source-1", modelLocked: true } },
        });
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toEqual(recovered.entry);
      },
    );
  });

  it("does not recover an initializer from a different spawned workspace", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-recovery-cwd-mismatch" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-recovery-cwd-mismatch";
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        const existing = {
          sessionId: "foreign-workspace-initializer",
          updatedAt: Date.now(),
          initializationPending: true as const,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: { supervision: { sourceThreadId: "source-1", initializing: true } },
          },
          spawnedCwd: "/workspace/other",
        };
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: existing,
        });

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            spawnedCwd: "/workspace/project",
            recoverMatchingInitialEntry: true,
            initialEntry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
              pluginExtensions: {
                codex: { supervision: { sourceThreadId: "source-1", initializing: true } },
              },
            },
            afterCreate: async () => ({ pluginExtensions: {} }),
          }),
        ).rejects.toThrow("does not match its trusted recovery state");
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toEqual(existing);
      },
    );
  });

  it("does not recover an initializing row with different trusted ownership", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-recovery-mismatch" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-recovery-mismatch";
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        const existing = {
          sessionId: "foreign-initializer",
          updatedAt: Date.now(),
          initializationPending: true as const,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: { supervision: { sourceThreadId: "different-source", initializing: true } },
          },
        };
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: existing,
        });

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            recoverMatchingInitialEntry: true,
            initialEntry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
              pluginExtensions: {
                codex: { supervision: { sourceThreadId: "source-1", initializing: true } },
              },
            },
            afterCreate: async () => ({ pluginExtensions: {} }),
          }),
        ).rejects.toThrow("does not match its trusted recovery state");
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toEqual(existing);
      },
    );
  });

  it("does not recover or roll back a locked CLI row owned by another plugin", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-cli-recovery-owner" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:catalog-adopt:claude:foreign";
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
      const cliSessionBinding = {
        sessionId: "claude-source",
        forceReuse: true,
        forkNextResume: true,
      } as const;
      const existing = {
        sessionId: "foreign-initializer",
        updatedAt: Date.now(),
        initializationPending: true as const,
        modelSelectionLocked: true,
        pluginOwnerId: "other-plugin",
        providerOverride: "claude-cli",
        modelOverride: "claude-opus-4-8",
        cliSessionBindings: { "claude-cli": cliSessionBinding },
      };
      await runtime.session.upsertSessionEntry({ storePath, sessionKey: key, entry: existing });

      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          recoverMatchingInitialEntry: true,
          initialEntry: {
            cliBackendId: "claude-cli",
            model: "claude-opus-4-8",
            modelSelectionLocked: true,
            pluginOwnerId: "anthropic",
            cliSessionBinding,
          },
          afterCreate: async () => {
            throw new Error("must not run");
          },
        }),
      ).rejects.toThrow("does not match its trusted recovery state");
      expect(
        runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
      ).toEqual(existing);
    });
  });

  it("rejects work for a persisted initializer without an active process fence", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-restart-admission" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-restart-pending";
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: {
            sessionId: "interrupted-initializer",
            updatedAt: Date.now(),
            initializationPending: true,
          },
        });
        expect(isSessionLifecycleMutationActive(storePath, [key])).toBe(false);
        let workRan = false;

        await expect(
          runtime.session.runWithWorkAdmission({ storePath, sessionKey: key }, async () => {
            workRan = true;
          }),
        ).rejects.toThrow("is still initializing");
        expect(workRan).toBe(false);
      },
    );
  });

  it("preserves a created entry claimed before finalization", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-rollback-race" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:dashboard:codex-binding-race";
        let sessionId: string | undefined;

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
            },
            afterCreate: async (created) => {
              sessionId = created.sessionId;
              await runtime.session.patchSessionEntry({
                sessionKey: created.key,
                update: () => ({ label: "claimed concurrently" }),
              });
              return {
                pluginExtensions: {
                  codex: { supervision: { modelLocked: true } },
                },
              };
            },
          }),
        ).rejects.toThrow("guarded rollback did not complete");

        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toMatchObject({
          sessionId,
          label: "claimed concurrently",
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        });
      },
    );
  });

  it("rejects an empty harness initializer without leaving a session entry", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-session-create-invalid" }, async () => {
      const runtime = createRuntimeAgent();
      const key = "agent:main:dashboard:invalid-harness";

      await expect(
        runtime.session.createSessionEntry({
          cfg: {},
          key,
          initialEntry: { agentHarnessId: " " },
        }),
      ).rejects.toThrow("initial agentHarnessId must be non-empty");
      expect(runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" })).toBe(
        undefined,
      );
    });
  });

  it("does not initialize over an existing placeholder entry", async () => {
    await withOpenClawTestState(
      { label: "plugin-runtime-session-create-placeholder" },
      async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:metadata";
        const updatedAt = Date.now();
        const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
        await runtime.session.upsertSessionEntry({
          storePath,
          sessionKey: key,
          entry: { sessionId: key, updatedAt, groupActivation: "always" },
        });
        expect(
          runtime.session.getSessionEntry({
            sessionKey: key,
            storePath,
            readConsistency: "latest",
          }),
        ).toMatchObject({ sessionId: key, updatedAt, groupActivation: "always" });

        await expect(
          runtime.session.createSessionEntry({
            cfg: {},
            key,
            initialEntry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
            },
          }),
        ).rejects.toThrow("trusted initial session state requires a new session");
        expect(
          runtime.session.getSessionEntry({
            sessionKey: key,
            storePath,
            readConsistency: "latest",
          }),
        ).toMatchObject({ sessionId: key, updatedAt, groupActivation: "always" });
      },
    );
  });
});

describe("plugin runtime session work admission", () => {
  let tempDir: string;
  let storePath: string;
  const sessionKey = "agent:main:voice:caller";
  const sessionId = "voice-session-id";

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-session-admission-"));
    storePath = path.join(tempDir, "sessions.json");
    await createRuntimeAgent().session.upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId, updatedAt: Date.now() },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects an archived session before running admitted work", async () => {
    const runtime = createRuntimeAgent();
    await runtime.session.patchSessionEntry({
      storePath,
      sessionKey,
      update: () => ({ archivedAt: Date.now() }),
    });
    let ran = false;

    await expect(
      runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {
        ran = true;
      }),
    ).rejects.toThrow(`Session "${sessionKey}" is archived`);
    expect(ran).toBe(false);
  });

  it("waits for a queued archive mutation and rejects the stale start", async () => {
    const runtime = createRuntimeAgent();
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
      run: async () => {
        await runtime.session.patchSessionEntry({
          storePath,
          sessionKey,
          update: () => ({ archivedAt: Date.now() }),
        });
      },
    });
    await mutationStarted.promise;

    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {});
    releaseMutation.resolve();
    await mutation;

    await expect(work).rejects.toThrow(`Session "${sessionKey}" is archived`);
  });

  it("admits fresh work and protects session creation inside the callback", async () => {
    const runtime = createRuntimeAgent();
    const freshKey = "agent:main:voice:fresh";
    const freshId = "fresh-session-id";

    await runtime.session.runWithWorkAdmission({ storePath, sessionKey: freshKey }, async () => {
      await runtime.session.upsertSessionEntry({
        storePath,
        sessionKey: freshKey,
        entry: { sessionId: freshId, updatedAt: Date.now() },
      });
    });

    expect(runtime.session.getSessionEntry({ storePath, sessionKey: freshKey })?.sessionId).toBe(
      freshId,
    );
  });

  it("holds admission through the callback and relays lifecycle interruption", async () => {
    const runtime = createRuntimeAgent();
    const workStarted = createDeferred();
    let admittedSignal: AbortSignal | undefined;
    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async (signal) => {
      admittedSignal = signal;
      workStarted.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    await workStarted.promise;

    await interruptSessionWorkAdmissions({
      scope: storePath,
      identities: [sessionKey, sessionId],
    });
    await work;

    expect(admittedSignal?.aborted).toBe(true);
  });
});
