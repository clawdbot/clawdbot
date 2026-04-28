import { afterEach, describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "./doctor-prompter.js";

const confirmMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@clack/prompts", () => ({
  confirm: (options: unknown) => confirmMock(options),
  select: (options: unknown) => selectMock(options),
}));

function setNonInteractiveTerminal() {
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
}

function createRepairPrompter(params?: { force?: boolean }) {
  setNonInteractiveTerminal();
  return createDoctorPrompter({
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    options: {
      repair: true,
      nonInteractive: true,
      ...(params?.force ? { force: true } : {}),
    },
  });
}

describe("createDoctorPrompter", () => {
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;

  afterEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      configurable: true,
    });
    if (originalUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
  });

  it("auto-accepts repairs in non-interactive fix mode", async () => {
    const prompter = createRepairPrompter();

    await expect(
      prompter.confirm({
        message: "Apply general repair?",
        initialValue: false,
      }),
    ).resolves.toBe(true);
    await expect(
      prompter.confirmAutoFix({
        message: "Repair gateway service config?",
        initialValue: false,
      }),
    ).resolves.toBe(true);
    await expect(
      prompter.confirmRuntimeRepair({
        message: "Repair launch agent bootstrap?",
        initialValue: false,
      }),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("requires --force for aggressive repairs in non-interactive fix mode", async () => {
    const prompter = createRepairPrompter();

    await expect(
      prompter.confirmAggressiveAutoFix({
        message: "Overwrite gateway service config?",
        initialValue: true,
      }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("does not auto-accept runtime repairs that require interactive confirmation", async () => {
    const prompter = createRepairPrompter();

    await expect(
      prompter.confirmRuntimeRepair({
        message: "Archive orphan transcripts?",
        initialValue: false,
        requiresInteractiveConfirmation: true,
      }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("does not accept interactive-only runtime repairs through --yes defaults", async () => {
    setNonInteractiveTerminal();
    const prompter = createDoctorPrompter({
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      options: {
        yes: true,
      },
    });

    await expect(
      prompter.confirmRuntimeRepair({
        message: "Archive orphan transcripts?",
        initialValue: true,
        requiresInteractiveConfirmation: true,
      }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("keeps skip-in-non-interactive prompts disabled during update-mode repairs", async () => {
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    const prompter = createRepairPrompter();

    await expect(
      prompter.confirmAutoFix({
        message: "Repair gateway service config?",
        initialValue: false,
      }),
    ).resolves.toBe(true);
    await expect(
      prompter.confirmRuntimeRepair({
        message: "Restart gateway service now?",
        initialValue: true,
      }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("auto-accepts aggressive repairs only with --force in non-interactive fix mode", async () => {
    const prompter = createRepairPrompter({ force: true });

    await expect(
      prompter.confirmAggressiveAutoFix({
        message: "Overwrite gateway service config?",
        initialValue: false,
      }),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
