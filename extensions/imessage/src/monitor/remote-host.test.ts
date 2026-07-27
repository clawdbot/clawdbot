import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectRemoteHostFromCliPath } from "./remote-host.js";

const execFileAsync = promisify(execFile);
const cliPathModuleUrl = new URL("../cli-path.ts", import.meta.url).href;
const userPathProbeSource = [
  'import fs from "node:fs/promises";',
  'import os from "node:os";',
  'import path from "node:path";',
  "const { expandIMessageUserPath } = await import(process.argv[1]);",
  "const expanded = expandIMessageUserPath(process.argv[2]);",
  "const content = await fs.readFile(expanded, 'utf8').catch(() => null);",
  "process.stdout.write(JSON.stringify({",
  "  accountHome: os.userInfo().homedir,",
  "  expanded,",
  "  content,",
  "  systemHome: os.homedir(),",
  "}));",
].join("\n");

type UserPathProbeResult = {
  accountHome: string;
  expanded: string;
  content: string | null;
  systemHome: string;
};

async function runUserPathProbe(params: {
  cliPath: string;
  home: string | undefined;
  cwd?: string;
}): Promise<UserPathProbeResult> {
  const env = { ...process.env };
  if (params.home === undefined) {
    delete env.HOME;
  } else {
    env.HOME = params.home;
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", userPathProbeSource, cliPathModuleUrl, params.cliPath],
    { cwd: params.cwd, env },
  );
  return JSON.parse(stdout) as UserPathProbeResult;
}

describe("detectRemoteHostFromCliPath", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it("uses the system home when HOME is blank", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-home-"));
    tempDirs.push(home);
    vi.stubEnv("HOME", "");
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
    const wrapperDir = path.join(home, ".openclaw");
    const wrapperPath = path.join(wrapperDir, "imsg-remote");
    await fs.mkdir(wrapperDir, { recursive: true });
    await fs.writeFile(wrapperPath, '#!/bin/sh\nexec ssh user@example.test imsg "$@"\n', "utf8");

    await expect(detectRemoteHostFromCliPath("~/.openclaw/imsg-remote")).resolves.toBe(
      "user@example.test",
    );
  });

  it.each([
    { label: "blank", home: "" },
    { label: "whitespace-only", home: "   " },
  ])("uses the real OS account home when HOME is $label", async ({ home }) => {
    const cliPath = `~/.openclaw/imsg-${randomUUID()}`;
    const result = await runUserPathProbe({ cliPath, home });

    expect(result.expanded).toBe(path.join(result.accountHome, cliPath.slice(2)));
    expect(path.isAbsolute(result.expanded)).toBe(true);
  });

  it("preserves the system home when HOME is unset", async () => {
    const cliPath = `~/.openclaw/imsg-${randomUUID()}`;
    const result = await runUserPathProbe({ cliPath, home: undefined });

    expect(result.expanded).toBe(path.join(result.systemHome, cliPath.slice(2)));
  });

  it("preserves an explicitly configured nonblank HOME", async () => {
    const configuredHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-home-"));
    tempDirs.push(configuredHome);
    const cliPath = `~/.openclaw/imsg-${randomUUID()}`;
    const result = await runUserPathProbe({ cliPath, home: configuredHome });

    expect(result.expanded).toBe(path.join(configuredHome, cliPath.slice(2)));
  });

  it("never selects a working-directory tilde shadow when HOME is blank", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-shadow-"));
    tempDirs.push(cwd);
    const basename = `imsg-${randomUUID()}`;
    const shadowPath = path.join(cwd, "~", ".openclaw", basename);
    await fs.mkdir(path.dirname(shadowPath), { recursive: true });
    await fs.writeFile(shadowPath, "#!/bin/sh\nexec ssh rogue@example.test imsg\n", "utf8");

    const result = await runUserPathProbe({
      cliPath: `~/.openclaw/${basename}`,
      home: "",
      cwd,
    });

    expect(result.expanded).toBe(path.join(result.accountHome, ".openclaw", basename));
    expect(result.content).toBeNull();
  });

  it("preserves user-qualified and host-only SSH wrapper detection", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-wrapper-"));
    tempDirs.push(dir);
    const userWrapper = path.join(dir, "user-wrapper");
    const hostWrapper = path.join(dir, "host-wrapper");
    await fs.writeFile(userWrapper, "#!/bin/sh\nexec ssh user@example.test imsg\n", "utf8");
    await fs.writeFile(hostWrapper, "#!/bin/sh\nexec ssh -T messages-mac imsg\n", "utf8");

    await expect(detectRemoteHostFromCliPath(userWrapper)).resolves.toBe("user@example.test");
    await expect(detectRemoteHostFromCliPath(hostWrapper)).resolves.toBe("messages-mac");
  });

  it("returns undefined when the wrapper does not exist", async () => {
    const missingWrapper = path.join(os.tmpdir(), `openclaw-imessage-missing-${randomUUID()}`);

    await expect(detectRemoteHostFromCliPath(missingWrapper)).resolves.toBeUndefined();
  });
});
