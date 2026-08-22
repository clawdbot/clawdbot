/**
 * Owner-boundary proof that paste with an existing global auth.order does not
 * persist a per-agent stored override. Stored order wins over config, so a
 * paste-created copy would freeze that agent against later auth.order edits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExplicitAuthOrderSelection } from "../../agents/auth-profiles/order.js";
import { loadAuthProfileStoreForRuntime } from "../../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
  callGateway: vi.fn(),
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

const { modelsAuthPasteApiKeyCommand, modelsAuthPasteTokenCommand } = await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function withPipedStdin(input: string) {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.hasOwn(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  const previousAsyncIteratorDescriptor = Object.getOwnPropertyDescriptor(
    stdin,
    Symbol.asyncIterator,
  );
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    enumerable: true,
    get: () => false,
  });
  Object.defineProperty(stdin, Symbol.asyncIterator, {
    configurable: true,
    async *value() {
      yield input;
    },
  });
  return () => {
    if (previousAsyncIteratorDescriptor) {
      Object.defineProperty(stdin, Symbol.asyncIterator, previousAsyncIteratorDescriptor);
    } else {
      Reflect.deleteProperty(stdin, Symbol.asyncIterator);
    }
    if (previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else if (!hadOwnIsTTY) {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  };
}

describe("paste auth order ownership", () => {
  let restoreStdin: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGateway.mockResolvedValue({});
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => mutator({}),
    );
  });

  afterEach(() => {
    restoreStdin?.();
    restoreStdin = null;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    {
      label: "paste-api-key",
      secret: "sk-openai-chatgpt-api-key-value",
      run: (runtime: RuntimeEnv) =>
        modelsAuthPasteApiKeyCommand({ provider: "openai", agent: "coder" }, runtime),
    },
    {
      label: "paste-token",
      secret: "openai-token",
      run: (runtime: RuntimeEnv) =>
        modelsAuthPasteTokenCommand({ provider: "openai", agent: "coder" }, runtime),
    },
  ])(
    "$label with existing auth.order leaves later global-order edits in charge",
    async ({ secret, run }) => {
      const stateDir = await fs.promises.realpath(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-paste-order-")),
      );
      const coderAgentDir = path.join(stateDir, "agents", "coder", "agent");
      const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
      fs.mkdirSync(coderAgentDir, { recursive: true });
      fs.mkdirSync(mainAgentDir, { recursive: true });

      const initialOrder = ["openai:old-login"];
      const laterOrder = ["openai:new-first", "openai:old-login"];
      const config: OpenClawConfig = {
        agents: {
          list: [{ id: "main" }, { id: "coder" }],
        },
        auth: {
          order: {
            openai: initialOrder,
          },
        },
      };
      mocks.loadValidConfigOrThrow.mockImplementation(async () => config);
      restoreStdin = withPipedStdin(`${secret}\n`);

      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, HOME: stateDir }, async () => {
          await run(createRuntime());

          const store = loadAuthProfileStoreForRuntime(coderAgentDir);
          expect(store.profiles["openai:manual"]).toBeDefined();
          expect(store.order?.openai).toBeUndefined();
          expect(
            loadAuthProfileStoreForRuntime(mainAgentDir).profiles["openai:manual"],
          ).toBeUndefined();
          expect(mocks.updateConfig).not.toHaveBeenCalled();

          expect(
            resolveExplicitAuthOrderSelection({
              storeOrder: store.order,
              configuredOrder: config.auth?.order,
              providerKey: "openai",
              providerAuthKey: "openai",
            }),
          ).toEqual({ order: initialOrder, fromStore: false });

          expect(
            resolveExplicitAuthOrderSelection({
              storeOrder: store.order,
              configuredOrder: { openai: laterOrder },
              providerKey: "openai",
              providerAuthKey: "openai",
            }),
          ).toEqual({ order: laterOrder, fromStore: false });
        });
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );
});
