import { afterEach, describe, expect, it, vi } from "vitest";

const { configureFsSafePython } = vi.hoisted(() => ({
  configureFsSafePython: vi.fn(),
}));

vi.mock("@openclaw/fs-safe/config", () => ({
  configureFsSafePython,
}));

async function importDefaults() {
  vi.resetModules();
  await import("./fs-safe-defaults.js");
}

describe("fs-safe defaults", () => {
  afterEach(() => {
    configureFsSafePython.mockReset();
    delete process.env.FS_SAFE_PYTHON_MODE;
    delete process.env.OPENCLAW_FS_SAFE_PYTHON_MODE;
  });

  it("disables the Python helper by default in OpenClaw", async () => {
    await importDefaults();

    expect(configureFsSafePython).toHaveBeenCalledWith({ mode: "off" });
  });

  it("lets fs-safe env mode overrides opt back into the helper", async () => {
    process.env.FS_SAFE_PYTHON_MODE = "require";

    await importDefaults();

    expect(configureFsSafePython).not.toHaveBeenCalled();
  });

  it("honors the OpenClaw-specific env mode override", async () => {
    process.env.OPENCLAW_FS_SAFE_PYTHON_MODE = "auto";

    await importDefaults();

    expect(configureFsSafePython).not.toHaveBeenCalled();
  });
});
