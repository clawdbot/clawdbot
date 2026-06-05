// Daemon install runtime warning tests cover Node runtime compatibility notices during service install.
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSystemNodeInfo: vi.fn(),
  renderSystemNodeWarning: vi.fn(),
}));

vi.mock("../daemon/runtime-paths.js", () => ({
  resolveSystemNodeInfo: mocks.resolveSystemNodeInfo,
  renderSystemNodeWarning: mocks.renderSystemNodeWarning,
}));

import { emitNodeRuntimeWarning } from "./daemon-install-runtime-warning.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("emitNodeRuntimeWarning", () => {
  it("skips lookup when runtime is not node", async () => {
    const warn = vi.fn();
    await emitNodeRuntimeWarning({
      env: {},
      runtime: "bun",
      warn,
      title: "Gateway runtime",
    });
    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(mocks.renderSystemNodeWarning).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits warning when system node check returns one", async () => {
    const warn = vi.fn();
    mocks.resolveSystemNodeInfo.mockResolvedValue({ path: "/usr/bin/node", version: "18.0.0" });
    mocks.renderSystemNodeWarning.mockReturnValue("Node too old");

    await emitNodeRuntimeWarning({
      env: { PATH: "/usr/bin" },
      runtime: "node",
      nodeProgram: "/opt/node",
      warn,
      title: "Node daemon runtime",
    });

    expect(mocks.resolveSystemNodeInfo).toHaveBeenCalledWith({
      env: { PATH: "/usr/bin" },
    });
    expect(mocks.renderSystemNodeWarning).toHaveBeenCalledWith(
      { path: "/usr/bin/node", version: "18.0.0" },
      "/opt/node",
    );
    expect(warn).toHaveBeenCalledWith("Node too old", "Node daemon runtime");
  });

  it("does not emit when warning helper returns null", async () => {
    const warn = vi.fn();
    mocks.resolveSystemNodeInfo.mockResolvedValue(null);
    mocks.renderSystemNodeWarning.mockReturnValue(null);

    await emitNodeRuntimeWarning({
      env: {},
      runtime: "node",
      nodeProgram: "node",
      warn,
      title: "Gateway runtime",
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
