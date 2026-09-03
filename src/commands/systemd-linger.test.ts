import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  ensureSystemdUserLingerInteractive,
  ensureSystemdUserLingerNonInteractive,
} from "./systemd-linger.js";

const mocks = vi.hoisted(() => ({
  enableSystemdUserLinger: vi.fn(),
  isSystemdUserServiceAvailable: vi.fn(),
  readSystemdUserLingerStatus: vi.fn(),
  resolveSystemdUserServiceAccount: vi.fn(),
}));

vi.mock("../daemon/systemd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/systemd.js")>();
  return {
    ...actual,
    enableSystemdUserLinger: mocks.enableSystemdUserLinger,
    isSystemdUserServiceAvailable: mocks.isSystemdUserServiceAvailable,
    readSystemdUserLingerStatus: mocks.readSystemdUserLingerStatus,
    resolveSystemdUserServiceAccount: mocks.resolveSystemdUserServiceAccount,
  };
});

async function withLinux<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    return await run();
  } finally {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  }
}

describe("systemd linger setup", () => {
  beforeEach(() => {
    mocks.isSystemdUserServiceAvailable.mockReset().mockResolvedValue(true);
    mocks.resolveSystemdUserServiceAccount.mockReset().mockReturnValue("debian");
    mocks.readSystemdUserLingerStatus
      .mockReset()
      .mockImplementation(async (params) =>
        params.user === "debian" ? { user: "debian", linger: "no" as const } : null,
      );
    mocks.enableSystemdUserLinger.mockReset().mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "permission denied",
      code: 1,
    });
  });

  it("prompts for the Gateway service owner under sudo-to-root", async () => {
    const confirm = vi.fn(async () => false);
    const note = vi.fn();
    const runtime = { error: vi.fn() } as unknown as RuntimeEnv;
    const env = { USER: "root", LOGNAME: "root", SUDO_USER: "debian" };

    await withLinux(async () => {
      await ensureSystemdUserLingerInteractive({
        runtime,
        prompter: { confirm, note },
        env,
        requireConfirm: true,
      });
    });

    expect(confirm).toHaveBeenCalledWith({
      message: "Enable systemd lingering for debian?",
      initialValue: true,
    });
  });

  it("reports the Gateway service owner in non-interactive recovery guidance", async () => {
    const log = vi.fn();
    const runtime = { log } as unknown as RuntimeEnv;
    const env = { USER: "root", LOGNAME: "root", SUDO_USER: "debian" };

    await withLinux(async () => {
      await ensureSystemdUserLingerNonInteractive({ runtime, env });
    });

    expect(log).toHaveBeenCalledWith(
      "Systemd lingering is disabled for debian. Run: sudo loginctl enable-linger debian",
    );
  });
});
