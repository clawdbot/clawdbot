// Startup registration of configured JSON-file lane providers into the gateway service.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerConfiguredTaskLaneProviders } from "./config-registration.js";
import { createTaskLaneGatewayService } from "./service.js";

const LANE_DOC = {
  schemaVersion: 1,
  lanes: [
    {
      id: "release",
      label: "Release board",
      items: [{ id: "r-1", title: "Cut 1.2", state: "running", startedAtMs: 1_700_000_000_000 }],
    },
  ],
};

describe("registerConfiguredTaskLaneProviders", () => {
  it("makes a configured lane visible in the gateway snapshot", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-lanes-config-"));
    try {
      await fs.writeFile(path.join(rootDir, "board.json"), JSON.stringify(LANE_DOC), "utf8");
      const service = createTaskLaneGatewayService();
      registerConfiguredTaskLaneProviders(service, {
        providers: [{ id: "acme-board", rootDir, filePath: "board.json" }],
      });
      const snapshot = await service.snapshot();
      expect(snapshot.lanes.map((lane) => lane.id)).toEqual(["release"]);
      expect(snapshot.lanes[0]?.items.map((item) => item.title)).toEqual(["Cut 1.2"]);
      expect(snapshot.diagnostics).toEqual([
        { providerId: "acme-board", ok: true, laneCount: 1, itemCount: 1 },
      ]);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("resolves a relative rootDir against the state directory, not the process cwd", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-lanes-state-"));
    try {
      await fs.mkdir(path.join(stateDir, "lanes"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "lanes", "board.json"),
        JSON.stringify(LANE_DOC),
        "utf8",
      );
      const service = createTaskLaneGatewayService();
      registerConfiguredTaskLaneProviders(
        service,
        { providers: [{ id: "relative-board", rootDir: "lanes", filePath: "board.json" }] },
        { stateDir },
      );
      const snapshot = await service.snapshot();
      expect(snapshot.lanes.map((lane) => lane.id)).toEqual(["release"]);
      expect(snapshot.diagnostics).toEqual([
        { providerId: "relative-board", ok: true, laneCount: 1, itemCount: 1 },
      ]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("registers nothing when the section is absent", async () => {
    const service = createTaskLaneGatewayService();
    registerConfiguredTaskLaneProviders(service, undefined);
    const snapshot = await service.snapshot();
    expect(snapshot.lanes).toEqual([]);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it("keeps an unreadable lane file as a provider diagnostic, not a startup failure", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-lanes-config-"));
    try {
      const service = createTaskLaneGatewayService();
      registerConfiguredTaskLaneProviders(service, {
        providers: [{ id: "missing-board", rootDir, filePath: "absent.json" }],
      });
      const snapshot = await service.snapshot();
      expect(snapshot.lanes).toEqual([]);
      expect(snapshot.diagnostics).toHaveLength(1);
      expect(snapshot.diagnostics[0]).toMatchObject({ providerId: "missing-board", ok: false });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports provider presence so the UI can keep unconfigured installs absent", () => {
    const service = createTaskLaneGatewayService();
    expect(service.hasProviders()).toBe(false);
    service.addProvider({
      id: "stub",
      label: "Stub",
      load: async () => ({ lanes: [] }),
    });
    expect(service.hasProviders()).toBe(true);
  });
});
