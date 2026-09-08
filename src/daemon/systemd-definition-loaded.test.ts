// Exercise the real definition inspector with files and native query responses.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "./service.test-helpers.js";
const system = vi.hoisted(() =>
  vi.fn<typeof import("./systemd-system.js").assertNoSystemSystemdOwnership>(),
);
const busctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());
vi.mock("./systemd-system.js", async (original) => ({
  ...(await original<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: system,
}));
vi.mock("./systemd-exec.js", async (original) => ({
  ...(await original<typeof import("./systemd-exec.js")>()),
  execBusctlUser: busctl,
}));
import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32")(
  "inspects loaded-only definition authority without loading either manager",
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-definition-loaded-")),
    );
    const env = {
      HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    };
    const unitPath = path.join(env.HOME, ".config/systemd/user/openclaw-owned.service");
    try {
      await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
      await fs.mkdir(env.OPENCLAW_STATE_DIR, { mode: 0o700 });
      await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n", { mode: 0o644 });
      system.mockReset().mockResolvedValue(undefined);
      busctl.mockReset().mockImplementation(async (_env, args) => ({
        code: 0,
        termination: "exit",
        stderr: "",
        stdout:
          args.includes("GetUnit") || args.includes("LoadUnit")
            ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
            : args.includes("org.freedesktop.systemd1.Unit")
              ? buildSystemdUnitPropertyOutput({ fragmentPath: unitPath, loadState: "loaded" })
              : buildSystemdManagerPropertyOutput({
                  programArguments: ["/usr/bin/node", "gateway"],
                  environment: [],
                }),
      }));
      await expect(
        readSystemdDefinitionMutationCapability(env, { requireLoaded: true, timeoutMs: 1000 }),
      ).resolves.toEqual({ kind: "writable" });
      expect(system).toHaveBeenCalledWith("openclaw-owned.service", expect.any(Number), {
        requireLoaded: true,
      });
      expect(busctl.mock.calls.some(([, args]) => args.includes("LoadUnit"))).toBe(false);
      expect(busctl.mock.calls.every(([, args]) => args.includes("--auto-start=no"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
