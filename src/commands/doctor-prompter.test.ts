// Doctor prompter tests cover confirmation prompt behavior and cancellation paths.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "./doctor-prompter.js";

const confirmMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: (options: unknown) => confirmMock(options),
  select: (options: unknown) => selectMock(options),
}));

function setTerminal(isTTY: boolean) {
  Object.defineProperty(process.stdin, "isTTY", {
    value: isTTY,
    configurable: true,
  });
}

function createRepairPrompter(params?: { force?: boolean }) {
  setTerminal(false);
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
  const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;

  afterEach(() => {
    vi.resetAllMocks();
    if (originalStdinIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
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

  it.each([{ repair: true }, { repair: true, force: true }, { yes: true }, { force: true }])(
    "refuses interactive-only repairs without a terminal for %j",
    async (options) => {
      setTerminal(false);
      const prompter = createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options,
      });

      await expect(
        prompter.confirmRuntimeRepair({
          message: "Overwrite gateway service config?",
          initialValue: true,
          requiresInteractiveConfirmation: true,
        }),
      ).resolves.toBe(false);
      expect(confirmMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("honors interactive consent with force alone: %s", async (approved) => {
    setTerminal(true);
    confirmMock.mockResolvedValueOnce(approved);
    const prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { force: true },
    });

    expect(prompter.shouldRepair).toBe(false);
    expect(prompter.shouldForce).toBe(true);
    await expect(
      prompter.confirmRuntimeRepair({
        message: "Overwrite gateway service config?",
        initialValue: true,
        requiresInteractiveConfirmation: true,
      }),
    ).resolves.toBe(approved);
    expect(confirmMock).toHaveBeenCalledOnce();
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
