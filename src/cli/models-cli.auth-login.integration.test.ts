// Exercises the shipped models auth login command across shared credential and local order owners.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { setAuthProfileOrder } from "../agents/auth-profiles/profiles.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import { testing as authStoreTesting } from "../agents/auth-profiles/store.test-support.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerModelsCli } from "./models-cli.js";
import { defaultRuntime } from "./models-cli.runtime.js";

const FRESH_PROFILE_ID = "openai:fresh-login";
const ORDER_BUSY_MESSAGE =
  "The auth profile was saved, but its order could not be updated because the auth store is busy. Wait a moment, then retry the login.";
const STALE_PROFILE_ID = "openai:stale-login";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(async () => ({})),
  runAuth: vi.fn(async () => ({
    profiles: [
      {
        profileId: "openai:fresh-login",
        credential: {
          type: "oauth" as const,
          provider: "openai" as const,
          access: "fresh-access",
          refresh: "fresh-refresh",
          expires: Date.now() + 60_000,
        },
      },
    ],
  })),
}));

vi.mock("../gateway/call.js", () => ({ callGateway: mocks.callGateway }));
vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: () => undefined,
  resolvePluginSetupRegistry: () => ({ providers: [] }),
}));
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: () =>
    [
      {
        id: "openai",
        label: "OpenAI",
        auth: [
          {
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            run: mocks.runAuth,
          },
        ],
      },
    ] satisfies ProviderPlugin[],
}));

function makeStdinInteractive(): () => void {
  // Piped stdin has no own isTTY property; the fixture owns only its temporary override.
  const stdin: { isTTY?: boolean } = process.stdin;
  const descriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", { configurable: true, get: () => true });
  return () => {
    if (descriptor) {
      Object.defineProperty(stdin, "isTTY", descriptor);
    } else {
      delete stdin.isTTY;
    }
  };
}

describe("models auth login owner integration", () => {
  let restoreStdin: (() => void) | undefined;
  let lock: DatabaseSync | undefined;

  const releaseLock = () => {
    authStoreTesting.resetRuntimeSnapshotPublisherForTest();
    if (lock?.isOpen) {
      if (lock.isTransaction) {
        lock.exec("ROLLBACK");
      }
      lock.close();
    }
    lock = undefined;
  };

  afterEach(() => {
    releaseLock();
    restoreStdin?.();
    restoreStdin = undefined;
    vi.clearAllMocks();
  });

  it("promotes a relocated shared login through the shipped CLI command", async () => {
    await withOpenClawTestState(
      { label: "models-auth-login-owner", scenario: "minimal" },
      async (state) => {
        await state.writeConfig({
          agents: { list: [{ id: "main" }] },
          auth: { order: { openai: [STALE_PROFILE_ID] } },
        });
        writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
        restoreStdin = makeStdinInteractive();

        await runRegisteredCli({
          register: registerModelsCli,
          argv: ["models", "auth", "login", "--provider", "openai", "--agent", "main"],
        });

        expect(mocks.runAuth).toHaveBeenCalledOnce();
        expect(loadPersistedAuthProfileStore()?.profiles[FRESH_PROFILE_ID]).toMatchObject({
          type: "oauth",
          provider: "openai",
        });
        expect(
          loadPersistedAuthProfileStore(state.agentDir())?.profiles[FRESH_PROFILE_ID],
        ).toBeUndefined();
        expect(loadAuthProfileStoreForRuntime(state.agentDir()).order?.openai).toEqual([
          FRESH_PROFILE_ID,
          STALE_PROFILE_ID,
        ]);
      },
    );
  });

  it("reports partial success when the local order owner is busy", async () => {
    await withOpenClawTestState(
      { label: "models-auth-login-order-busy", scenario: "minimal" },
      async (state) => {
        await state.writeConfig({
          agents: { list: [{ id: "main" }] },
          auth: { order: { openai: [STALE_PROFILE_ID] } },
        });
        writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
        expect(
          await setAuthProfileOrder({
            agentDir: state.agentDir(),
            provider: "openai",
            order: [STALE_PROFILE_ID],
          }),
        ).not.toBeNull();
        restoreStdin = makeStdinInteractive();
        const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
        const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
        const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
          throw new Error(`exit:${code}`);
        });
        authStoreTesting.setRuntimeSnapshotPublisherForTest((publish) => {
          publish();
          if (lock) {
            return;
          }
          lock = new DatabaseSync(resolveAuthProfileDatabasePath(state.agentDir()));
          lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
        });

        try {
          await expect(
            runRegisteredCli({
              register: registerModelsCli,
              argv: ["models", "auth", "login", "--provider", "openai", "--agent", "main"],
            }),
          ).rejects.toThrow("exit:1");

          expect(error).toHaveBeenCalledWith(ORDER_BUSY_MESSAGE);
          expect(exit).toHaveBeenCalledWith(1);
          expect(log).not.toHaveBeenCalledWith(
            expect.stringContaining(`Auth profile: ${FRESH_PROFILE_ID}`),
          );
          expect(mocks.callGateway).not.toHaveBeenCalled();
          expect(loadPersistedAuthProfileStore()?.profiles[FRESH_PROFILE_ID]).toMatchObject({
            type: "oauth",
            provider: "openai",
          });
          expect(loadPersistedAuthProfileStore(state.agentDir())?.order?.openai).toEqual([
            STALE_PROFILE_ID,
          ]);
        } finally {
          releaseLock();
          error.mockRestore();
          log.mockRestore();
          exit.mockRestore();
        }
      },
    );
  });
});
