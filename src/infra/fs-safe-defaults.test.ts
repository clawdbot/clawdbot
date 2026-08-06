// Covers OpenClaw's default fs-safe native helper configuration.
import { afterEach, describe, expect, it, vi } from "vitest";

const { configureFsSafeNative } = vi.hoisted(() => ({
  configureFsSafeNative: vi.fn(),
}));

vi.mock("@openclaw/fs-safe/config", () => ({
  configureFsSafeNative,
}));

async function importDefaults() {
  vi.resetModules();
  await import("./fs-safe-defaults.js");
}

describe("fs-safe defaults", () => {
  afterEach(() => {
    configureFsSafeNative.mockReset();
    delete process.env.FS_SAFE_NATIVE_MODE;
    delete process.env.OPENCLAW_FS_SAFE_NATIVE_MODE;
    delete process.env.openclaw_fs_safe_native_mode;
    delete process.env.FS_SAFE_PYTHON_MODE;
    delete process.env.OPENCLAW_FS_SAFE_PYTHON_MODE;
    delete process.env.FS_SAFE_PYTHON;
    delete process.env.OPENCLAW_FS_SAFE_PYTHON;
    delete process.env.OPENCLAW_PINNED_PYTHON;
    delete process.env.OPENCLAW_PINNED_WRITE_PYTHON;
  });

  it("disables the native helper by default in OpenClaw", async () => {
    await importDefaults();

    expect(configureFsSafeNative).toHaveBeenCalledWith({ mode: "off" });
  });

  it("lets fs-safe env mode overrides opt back into the helper", async () => {
    process.env.FS_SAFE_NATIVE_MODE = "require";

    await importDefaults();

    expect(configureFsSafeNative).not.toHaveBeenCalled();
  });

  it("honors the OpenClaw-specific env mode override", async () => {
    process.env.OPENCLAW_FS_SAFE_NATIVE_MODE = "auto";

    await importDefaults();

    expect(configureFsSafeNative).not.toHaveBeenCalled();
  });

  it("honors case-insensitive mode overrides on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    process.env.openclaw_fs_safe_native_mode = "require";

    await importDefaults();

    expect(configureFsSafeNative).not.toHaveBeenCalled();
  });

  it("lets fs-safe migrate legacy require mode without overriding it", async () => {
    process.env.OPENCLAW_FS_SAFE_PYTHON_MODE = "require";

    await importDefaults();

    expect(configureFsSafeNative).not.toHaveBeenCalled();
  });

  it("does not treat a retired interpreter path as a native mode override", async () => {
    process.env.OPENCLAW_FS_SAFE_PYTHON = "/usr/bin/python3";

    await importDefaults();

    expect(configureFsSafeNative).toHaveBeenCalledWith({ mode: "off" });
  });
});
