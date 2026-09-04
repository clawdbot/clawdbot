import { afterEach, describe, expect, it, vi } from "vitest";

const promptYesNo = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./prompt.js", () => ({ promptYesNo }));

const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

function restoreTty(): void {
  if (ORIGINAL_STDIN_TTY) {
    Object.defineProperty(process.stdin, "isTTY", ORIGINAL_STDIN_TTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  if (ORIGINAL_STDOUT_TTY) {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_STDOUT_TTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

describe("resolveClawHubInstallConfirmation", () => {
  afterEach(() => {
    promptYesNo.mockClear();
    restoreTty();
  });

  it("prompts a human terminal with a generic install confirmation", async () => {
    setTty(true);
    const { resolveClawHubInstallConfirmation } = await import("./clawhub-install-confirmation.js");

    const confirm = resolveClawHubInstallConfirmation();

    expect(confirm).toBeTypeOf("function");
    await expect(confirm?.()).resolves.toBe(true);
    expect(promptYesNo).toHaveBeenCalledWith("Proceed with installation?");
  });

  it("does not prompt non-interactive callers", async () => {
    setTty(false);
    const { resolveClawHubInstallConfirmation } = await import("./clawhub-install-confirmation.js");

    expect(resolveClawHubInstallConfirmation()).toBeUndefined();
  });
});
