// Console settings tests cover console logger configuration behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { captureConsoleSnapshot, type ConsoleSnapshot } from "./test-helpers/console-snapshot.js";

const shouldSkipMutatingLoggingConfigReadMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("./config.js", () => ({
  readLoggingConfig: () => undefined,
  shouldSkipMutatingLoggingConfigRead: () => shouldSkipMutatingLoggingConfigReadMock(),
}));

vi.mock("./logger.js", () => ({
  getLogger: () => ({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  }),
}));

let loadConfigCalls = 0;
let originalIsTty: boolean | undefined;
let envSnapshot: ReturnType<typeof captureEnv> | undefined;
let snapshot: ConsoleSnapshot;
let logging: typeof import("../logging.js");
let state: typeof import("./state.js");

beforeAll(async () => {
  logging = await import("../logging.js");
  state = await import("./state.js");
});

beforeEach(() => {
  loadConfigCalls = 0;
  shouldSkipMutatingLoggingConfigReadMock.mockReset();
  shouldSkipMutatingLoggingConfigReadMock.mockReturnValue(false);
  snapshot = captureConsoleSnapshot();
  originalIsTty = process.stdout.isTTY;
  envSnapshot = captureEnv(["OPENCLAW_TEST_CONSOLE"]);
  process.env.OPENCLAW_TEST_CONSOLE = "1";
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  console.debug = snapshot.debug;
  console.trace = snapshot.trace;
  envSnapshot?.restore();
  envSnapshot = undefined;
  Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
  logging.setConsoleConfigLoaderForTests();
  vi.restoreAllMocks();
});

function loadLogging() {
  state.loggingState.cachedConsoleSettings = null;
  logging.setConsoleConfigLoaderForTests(() => {
    loadConfigCalls += 1;
    if (loadConfigCalls > 5) {
      return {};
    }
    console.error("config load failed");
    return {};
  });
  return { logging, state };
}

describe("getConsoleSettings", () => {
  it("does not recurse when loadConfig logs during resolution", () => {
    const { logging: loggingValue } = loadLogging();
    loggingValue.setConsoleTimestampPrefix(true);
    loggingValue.enableConsoleCapture();
    const { getConsoleSettings } = loggingValue;
    getConsoleSettings();
    expect(loadConfigCalls).toBe(1);
  });

  it("skips config fallback during re-entrant resolution", () => {
    const { logging: loggingLocal, state: stateLocal } = loadLogging();
    stateLocal.loggingState.resolvingConsoleSettings = true;
    loggingLocal.setConsoleTimestampPrefix(true);
    loggingLocal.enableConsoleCapture();
    loggingLocal.getConsoleSettings();
    expect(loadConfigCalls).toBe(0);
    stateLocal.loggingState.resolvingConsoleSettings = false;
  });
});
