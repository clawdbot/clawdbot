// Exercises the shipped models auth login command across shared credential and local order owners.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerModelsCli } from "./models-cli.js";

const FRESH_PROFILE_ID = "openai:fresh-login";
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
  const stdin = process.stdin;
  const descriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", { configurable: true, get: () => true });
  return () => {
    if (descriptor) {
      Object.defineProperty(stdin, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(stdin, "isTTY");
    }
  };
}

describe("models auth login owner integration", () => {
  let restoreStdin: (() => void) | undefined;

  afterEach(() => {
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
});
