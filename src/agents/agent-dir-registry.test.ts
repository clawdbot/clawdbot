import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathOwnedByAnotherRegisteredAgent,
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "./agent-dir-registry.js";

describe("agent directory registry", () => {
  it("unregisters only the requested owner", () => {
    const agentDir = path.join("/tmp", `openclaw-agent-dir-registry-${process.pid}`);
    registerResolvedAgentDir({ agentId: "first", agentDir });
    registerResolvedAgentDir({ agentId: "second", agentDir });

    expect(resolveRegisteredAgentIdForDir(agentDir)).toBeUndefined();
    expect(unregisterResolvedAgentDir({ agentId: "first", agentDir })).toBe(true);
    expect(resolveRegisteredAgentIdForDir(agentDir)).toBe("second");
    expect(unregisterResolvedAgentDir({ agentId: "second", agentDir })).toBe(true);
    expect(resolveRegisteredAgentIdForDir(agentDir)).toBeUndefined();
  });

  it("detects registered ownership on either side of a cleanup boundary", () => {
    const root = path.join("/tmp", `openclaw-agent-dir-overlap-${process.pid}`);
    const agentDir = path.join(root, "agent");
    registerResolvedAgentDir({ agentId: "current", agentDir });

    expect(
      isPathOwnedByAnotherRegisteredAgent({
        agentId: "deleted",
        pathname: root,
      }),
    ).toBe(true);
    expect(
      isPathOwnedByAnotherRegisteredAgent({
        agentId: "deleted",
        pathname: path.join(agentDir, "openclaw-agent.sqlite"),
      }),
    ).toBe(true);
    expect(
      isPathOwnedByAnotherRegisteredAgent({
        agentId: "current",
        pathname: root,
      }),
    ).toBe(false);

    unregisterResolvedAgentDir({ agentId: "current", agentDir });
  });

  it("keeps ownership stable through a symlinked parent after the agent dir is removed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-dir-registry-"));
    const realRoot = path.join(root, "real");
    const linkedRoot = path.join(root, "linked");
    const realAgentDir = path.join(realRoot, "agent");
    const linkedAgentDir = path.join(linkedRoot, "agent");
    fs.mkdirSync(realAgentDir, { recursive: true });
    fs.symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    try {
      registerResolvedAgentDir({ agentId: "current", agentDir: realAgentDir });
      expect(resolveRegisteredAgentIdForDir(linkedAgentDir)).toBe("current");
      registerResolvedAgentDir({ agentId: "deleted", agentDir: linkedAgentDir });
      expect(resolveRegisteredAgentIdForDir(realAgentDir)).toBeUndefined();
      expect(
        isPathOwnedByAnotherRegisteredAgent({
          agentId: "deleted",
          pathname: linkedAgentDir,
        }),
      ).toBe(true);
      expect(unregisterResolvedAgentDir({ agentId: "deleted", agentDir: linkedAgentDir })).toBe(
        true,
      );
      expect(resolveRegisteredAgentIdForDir(realAgentDir)).toBe("current");

      fs.rmSync(realAgentDir, { recursive: true });
      expect(unregisterResolvedAgentDir({ agentId: "current", agentDir: linkedAgentDir })).toBe(
        true,
      );
      expect(resolveRegisteredAgentIdForDir(realAgentDir)).toBeUndefined();
    } finally {
      unregisterResolvedAgentDir({ agentId: "current", agentDir: linkedAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
