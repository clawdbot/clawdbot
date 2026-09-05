import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.ts";

const promptTextMock = vi.hoisted(() => vi.fn());

vi.mock("./prompt.js", () => ({
  promptText: promptTextMock,
}));

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

describe("resolveInstallPolicyWarningAcknowledgementCliOptions", () => {
  afterEach(() => {
    promptTextMock.mockReset();
    restoreTty();
  });

  it.each([
    { requestMode: "install", action: "install" },
    { requestMode: "update", action: "update" },
  ] as const)("uses the ClawHub suspicious-warning copy for $requestMode", async (fixture) => {
    setTty(true);
    promptTextMock.mockResolvedValueOnce("demo\\npkg");

    const options = resolveInstallPolicyWarningAcknowledgementCliOptions({});
    await expect(
      options.onInstallPolicyWarning?.({
        targetName: "demo\npkg",
        targetType: "plugin",
        requestMode: fixture.requestMode,
        reason: "Policy warning",
      }),
    ).resolves.toEqual({ status: "approved" });

    expect(promptTextMock).toHaveBeenCalledWith(
      `type: 'demo\\npkg' to ${fixture.action} anyway\n> `,
    );
  });

  it("requires the exact target name", async () => {
    setTty(true);
    promptTextMock.mockResolvedValueOnce("another-package");

    const options = resolveInstallPolicyWarningAcknowledgementCliOptions({});

    await expect(
      options.onInstallPolicyWarning?.({
        targetName: "demo",
        targetType: "skill",
        requestMode: "install",
        reason: "Policy warning",
      }),
    ).resolves.toEqual({ status: "declined" });
  });

  it("does not prompt outside a TTY", () => {
    setTty(false);
    expect(resolveInstallPolicyWarningAcknowledgementCliOptions({})).toEqual({});
  });

  it("does not infer prompt authority from an attached TTY", () => {
    setTty(true);
    expect(resolveInstallPolicyWarningAcknowledgementCliOptions({ allowPrompt: false })).toEqual(
      {},
    );
    expect(promptTextMock).not.toHaveBeenCalled();
  });

  it("keeps the deprecated unsafe flag inert without suppressing an interactive prompt", () => {
    setTty(true);
    const options = resolveInstallPolicyWarningAcknowledgementCliOptions({
      dangerouslyForceUnsafeInstall: true,
    });

    expect(options.dangerouslyForceUnsafeInstall).toBe(true);
    expect(options.onInstallPolicyWarning).toBeTypeOf("function");
  });

  it("uses the dedicated acknowledgement flag for every warning without prompting", async () => {
    setTty(false);
    const options = resolveInstallPolicyWarningAcknowledgementCliOptions({
      acknowledgeInstallPolicyWarning: true,
    });

    await expect(
      options.onInstallPolicyWarning?.({
        targetName: "demo",
        targetType: "plugin",
        requestMode: "install",
        reason: "Policy warning",
      }),
    ).resolves.toEqual({ status: "approved" });
    await expect(
      options.onInstallPolicyWarning?.({
        targetName: "demo-dependency",
        targetType: "plugin",
        requestMode: "install",
        reason: "Dependency policy warning",
      }),
    ).resolves.toEqual({ status: "approved" });
    expect(promptTextMock).not.toHaveBeenCalled();
  });
});
