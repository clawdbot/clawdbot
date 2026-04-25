import { vi, type Mock } from "vitest";

type AnyMock = Mock<(...args: unknown[]) => unknown>;

const programMocks = vi.hoisted(() => {
  const setupWizardCommand = vi.fn();
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(() => {
      throw new Error("exit");
    }),
    writeStdout: vi.fn((value: string) => {
      runtime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
  };
  return {
    messageCommand: vi.fn(),
    statusCommand: vi.fn(),
    configureCommand: vi.fn(),
    configureCommandWithSections: vi.fn(),
    setupCommand: vi.fn(),
    setupWizardCommand,
    onboardCommand: setupWizardCommand,
    callGateway: vi.fn(),
    runChannelLogin: vi.fn(),
    runChannelLogout: vi.fn(),
    runTui: vi.fn(),
    runCrestodian: vi.fn(),
    loadAndMaybeMigrateDoctorConfig: vi.fn(),
    ensureConfigReady: vi.fn(),
    ensurePluginRegistryLoaded: vi.fn(),
    runtime,
  };
});

export const messageCommand = programMocks.messageCommand as AnyMock;
export const statusCommand = programMocks.statusCommand as AnyMock;
export const configureCommand = programMocks.configureCommand as AnyMock;
export const configureCommandWithSections = programMocks.configureCommandWithSections as AnyMock;
export const setupCommand = programMocks.setupCommand as AnyMock;
export const onboardCommand = programMocks.onboardCommand as AnyMock;
export const setupWizardCommand = programMocks.setupWizardCommand as AnyMock;
export const callGateway = programMocks.callGateway as AnyMock;
export const runChannelLogin = programMocks.runChannelLogin as AnyMock;
export const runChannelLogout = programMocks.runChannelLogout as AnyMock;
export const runTui = programMocks.runTui as AnyMock;
export const runCrestodian = programMocks.runCrestodian as AnyMock;
export const loadAndMaybeMigrateDoctorConfig =
  programMocks.loadAndMaybeMigrateDoctorConfig as AnyMock;
export const ensureConfigReady = programMocks.ensureConfigReady as AnyMock;
export const ensurePluginRegistryLoaded = programMocks.ensurePluginRegistryLoaded as AnyMock;

export const runtime = programMocks.runtime as {
  log: Mock<(...args: unknown[]) => void>;
  error: Mock<(...args: unknown[]) => void>;
  exit: Mock<(...args: unknown[]) => never>;
  writeStdout: Mock<(...args: [string]) => void>;
  writeJson: Mock<(...args: [unknown, number?]) => void>;
};

// Keep these mocks at top level so Vitest does not warn about hoisted nested mocks.
vi.mock("../commands/message.js", () => ({ messageCommand: programMocks.messageCommand }));
vi.mock("../commands/status.js", () => ({ statusCommand: programMocks.statusCommand }));
vi.mock("../commands/configure.js", () => ({
  CONFIGURE_WIZARD_SECTIONS: [
    "workspace",
    "model",
    "web",
    "gateway",
    "daemon",
    "channels",
    "skills",
    "health",
  ],
  configureCommand: programMocks.configureCommand,
  configureCommandWithSections: programMocks.configureCommandWithSections,
  configureCommandFromSectionsArg: (sections: unknown, runtime: unknown) => {
    const resolved = Array.isArray(sections) ? sections : [];
    if (resolved.length > 0) {
      return programMocks.configureCommandWithSections(resolved, runtime);
    }
    return programMocks.configureCommand({}, runtime);
  },
}));
vi.mock("../commands/setup.js", () => ({ setupCommand: programMocks.setupCommand }));
vi.mock("../commands/onboard.js", () => ({
  onboardCommand: programMocks.onboardCommand,
  setupWizardCommand: programMocks.setupWizardCommand,
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: programMocks.runtime }));
vi.mock("./channel-auth.js", () => ({
  runChannelLogin: programMocks.runChannelLogin,
  runChannelLogout: programMocks.runChannelLogout,
}));
vi.mock("../tui/tui.js", () => ({ runTui: programMocks.runTui }));
vi.mock("../crestodian/crestodian.js", () => ({ runCrestodian: programMocks.runCrestodian }));
vi.mock("../gateway/call.js", () => ({
  callGateway: programMocks.callGateway,
  randomIdempotencyKey: () => "idem-test",
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:1234",
    urlSource: "test",
    message: "Gateway target: ws://127.0.0.1:1234",
  }),
}));
vi.mock("./deps.js", () => ({ createDefaultDeps: () => ({}) }));
vi.mock("./plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: programMocks.ensurePluginRegistryLoaded,
}));
vi.mock("../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: programMocks.loadAndMaybeMigrateDoctorConfig,
}));
vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: programMocks.ensureConfigReady,
}));
vi.mock("./preaction.js", () => ({ registerPreActionHooks: () => {} }));

export function installBaseProgramMocks() {}

export function installSmokeProgramMocks() {}
