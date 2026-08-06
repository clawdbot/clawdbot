import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClawHubRiskAcknowledgementCliOptions } from "./clawhub-risk-acknowledgement.js";

const promptYesNoMock = vi.hoisted(() => vi.fn());
const promptTextMock = vi.hoisted(() => vi.fn());

vi.mock("./prompt.js", () => ({
  promptYesNo: promptYesNoMock,
  promptText: promptTextMock,
}));

const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
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

describe("resolveClawHubRiskAcknowledgementCliOptions", () => {
  afterEach(() => {
    promptYesNoMock.mockReset();
    promptTextMock.mockReset();
    restoreTty();
  });

  it("does not create a prompt handler when ClawHub risk is already acknowledged", () => {
    setTty(true);

    const options = resolveClawHubRiskAcknowledgementCliOptions({
      acknowledgeClawHubRisk: true,
      action: "installing",
    });

    expect(options.acknowledgeClawHubRisk).toBe(true);
    expect(options.onClawHubRisk).toBeUndefined();
  });

  it("does not create a prompt handler outside an interactive terminal", () => {
    setTty(false);

    const options = resolveClawHubRiskAcknowledgementCliOptions({
      action: "updating",
    });

    expect(options.acknowledgeClawHubRisk).toBeUndefined();
    expect(options.onClawHubRisk).toBeUndefined();
  });

  it("does not create a prompt handler when prompting is disabled", () => {
    setTty(true);

    const options = resolveClawHubRiskAcknowledgementCliOptions({
      action: "updating",
      allowPrompt: false,
    });

    expect(options.acknowledgeClawHubRisk).toBeUndefined();
    expect(options.onClawHubRisk).toBeUndefined();
  });

  it("sanitizes ClawHub package labels before prompting", async () => {
    promptTextMock.mockResolvedValueOnce("demo\\npkg");
    setTty(true);

    const options = resolveClawHubRiskAcknowledgementCliOptions({
      action: "installing",
    });

    if (!options.onClawHubRisk) {
      throw new Error("expected ClawHub risk prompt handler");
    }
    await options.onClawHubRisk({
      packageName: "demo\npkg",
      version: "1.2.3\u001b[2K",
      trust: {
        scanStatus: "suspicious",
        moderationState: null,
        blockedFromDownload: false,
        reasons: ["payload_strings"],
        pending: false,
        stale: false,
      },
      acknowledgementKind: "type-package",
      warning: "warning",
    });

    const prompt = promptTextMock.mock.calls[0]?.[0];
    expect(prompt).toContain("type: 'demo\\npkg' to install anyway");
    expect(prompt).not.toContain("demo\npkg");
    expect(prompt).not.toContain("\u001b");
  });

  it("requires typing the package name for review-required releases", async () => {
    promptTextMock.mockResolvedValueOnce("demo");
    setTty(true);

    const options = resolveClawHubRiskAcknowledgementCliOptions({
      action: "installing",
    });

    if (!options.onClawHubRisk) {
      throw new Error("expected ClawHub risk prompt handler");
    }
    await expect(
      options.onClawHubRisk({
        packageName: "demo",
        version: "1.2.3",
        trust: {
          scanStatus: "suspicious",
          moderationState: null,
          blockedFromDownload: false,
          reasons: ["payload_strings"],
          pending: false,
          stale: false,
        },
        acknowledgementKind: "type-package",
        warning: "warning",
      }),
    ).resolves.toBe(true);

    expect(promptTextMock).toHaveBeenCalledWith(
      expect.stringContaining("type: 'demo' to install anyway"),
    );
    expect(promptYesNoMock).not.toHaveBeenCalled();
  });

  it("uses yes/no confirmation for review-recommended releases", async () => {
    promptYesNoMock.mockResolvedValueOnce(true);
    setTty(true);

    const options = resolveClawHubRiskAcknowledgementCliOptions({
      action: "installing",
    });

    if (!options.onClawHubRisk) {
      throw new Error("expected ClawHub risk prompt handler");
    }
    await expect(
      options.onClawHubRisk({
        packageName: "demo",
        version: "1.2.3",
        trust: {
          scanStatus: "pending",
          moderationState: null,
          blockedFromDownload: false,
          reasons: ["scan:pending"],
          pending: true,
          stale: false,
        },
        acknowledgementKind: "confirm",
        warning: "warning",
      }),
    ).resolves.toBe(true);

    expect(promptYesNoMock).toHaveBeenCalledWith(
      'Install ClawHub package "demo@1.2.3" after reviewing the warning above?',
    );
    expect(promptTextMock).not.toHaveBeenCalled();
  });

  it("uses update wording for update confirmations", async () => {
    promptYesNoMock.mockResolvedValueOnce(true);
    setTty(true);

    const options = resolveClawHubRiskAcknowledgementCliOptions({
      action: "updating",
    });

    if (!options.onClawHubRisk) {
      throw new Error("expected ClawHub risk prompt handler");
    }
    await options.onClawHubRisk({
      packageName: "demo",
      version: "1.2.3",
      trust: {
        scanStatus: "pending",
        moderationState: null,
        blockedFromDownload: false,
        reasons: ["scan:pending"],
        pending: true,
        stale: false,
      },
      acknowledgementKind: "confirm",
      warning: "warning",
    });

    expect(promptYesNoMock).toHaveBeenCalledWith(
      'Update ClawHub package "demo@1.2.3" after reviewing the warning above?',
    );
  });
});
