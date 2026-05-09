import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorRuntime, mockDoctorConfigSnapshot } from "./doctor.e2e-harness.js";
import { loadDoctorCommandForTest, terminalNoteMock } from "./doctor.note-test-helpers.js";
import "./doctor.fast-path-mocks.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command", () => {
  beforeEach(async () => {
    doctorCommand = await loadDoctorCommandForTest({
      unmockModules: ["./doctor-sandbox.js", "../flows/doctor-health-contributions.js"],
    });
  });

  it("warns when per-agent sandbox docker/browser/prune overrides are ignored under shared scope", async () => {
    mockDoctorConfigSnapshot({
      config: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              scope: "shared",
            },
          },
          list: [
            {
              id: "work",
              workspace: "~/openclaw-work",
              sandbox: {
                mode: "all",
                scope: "shared",
                docker: {
                  setupCommand: "echo work",
                },
              },
            },
          ],
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), { nonInteractive: true });

    const matchingSandboxNotes = terminalNoteMock.mock.calls.filter(([message, title]) => {
      if (title !== "Sandbox" || typeof message !== "string") {
        return false;
      }
      const normalized = message.replace(/\s+/g, " ").trim();
      return (
        normalized.includes('agents.list (id "work") sandbox docker') &&
        normalized.includes('scope resolves to "shared"')
      );
    });
    expect(matchingSandboxNotes.length).toBeGreaterThan(0);
  }, 30_000);

  it("does not warn when only the active workspace is present", async () => {
    mockDoctorConfigSnapshot({
      config: {
        agents: { defaults: { workspace: "/Users/steipete/openclaw" } },
      },
    });

    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/Users/steipete");
    const realExists = fs.existsSync;
    const legacyPath = path.join("/Users/steipete", "openclaw");
    const legacyAgentsPath = path.join(legacyPath, "AGENTS.md");
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((value) => {
      if (
        value === "/Users/steipete/openclaw" ||
        value === legacyPath ||
        value === legacyAgentsPath
      ) {
        return true;
      }
      return realExists(value as never);
    });

    await doctorCommand(createDoctorRuntime(), { nonInteractive: true });

    const noteTitles = terminalNoteMock.mock.calls.map(([_, title]) => title);
    expect(noteTitles).not.toContain("Extra workspace");

    homedirSpy.mockRestore();
    existsSpy.mockRestore();
  });
});
