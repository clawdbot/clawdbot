/** Reusable turn-level fixtures for isolated cron agent regression tests. */
import "./isolated-agent.mocks.js";
import { vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import type { CliDeps } from "../cli/deps.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome as withTempHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import type { CronJob } from "./types.js";

export { withTempHome };

export function makeDeps(): CliDeps {
  return {
    sendMessageSlack: vi.fn(),
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
}

function mockEmbeddedPayloads(payloads: Array<{ text?: string; isError?: boolean }>) {
  vi.mocked(runEmbeddedAgent).mockResolvedValue({
    payloads,
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
}

function mockEmbeddedTexts(texts: string[]) {
  mockEmbeddedPayloads(texts.map((text) => ({ text })));
}

export function mockEmbeddedOk() {
  mockEmbeddedTexts(["ok"]);
}

export async function readSessionEntry(storePath: string, key: string) {
  return loadSessionEntry({ storePath, sessionKey: key });
}

export const DEFAULT_MESSAGE = "do it";
const DEFAULT_SESSION_KEY = "cron:job-1";
export const DEFAULT_AGENT_TURN_PAYLOAD: CronJob["payload"] = {
  kind: "agentTurn",
  message: DEFAULT_MESSAGE,
};
export const GMAIL_MODEL = "openrouter/meta-llama/llama-3.3-70b:free";

type RunCronTurnOptions = {
  cfgOverrides?: Parameters<typeof makeCfg>[2];
  deps?: CliDeps;
  delivery?: CronJob["delivery"];
  jobPayload?: CronJob["payload"];
  message?: string;
  mockTexts?: string[] | null;
  sessionKey?: string;
  storeEntries?: Record<string, Record<string, unknown>>;
  storePath?: string;
};

export async function runCronTurn(home: string, options: RunCronTurnOptions = {}) {
  const storePath =
    options.storePath ??
    (await writeSessionStoreEntries(home, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now(),
        lastProvider: "webchat",
        lastTo: "",
      },
      ...options.storeEntries,
    }));
  const deps = options.deps ?? makeDeps();
  if (options.mockTexts === null) {
    vi.mocked(runEmbeddedAgent).mockClear();
  } else {
    mockEmbeddedTexts(options.mockTexts ?? ["ok"]);
  }

  const jobPayload = options.jobPayload ?? DEFAULT_AGENT_TURN_PAYLOAD;
  const res = await runCronIsolatedAgentTurn({
    cfg: makeCfg(home, storePath, options.cfgOverrides),
    deps,
    job: {
      ...makeJob(jobPayload),
      delivery: options.delivery ?? { mode: "none" },
    },
    message:
      options.message ?? (jobPayload.kind === "agentTurn" ? jobPayload.message : DEFAULT_MESSAGE),
    sessionKey: options.sessionKey ?? DEFAULT_SESSION_KEY,
    lane: "cron",
  });

  return { deps, res, storePath };
}
