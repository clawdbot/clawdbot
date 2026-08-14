import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveIMessageChatDbLookupPath } from "../cli-path.js";
import { getCachedIMessageRemoteHost, resolveIMessageRemoteHost } from "../remote-host.js";

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

    await expect(resolveIMessageRemoteHost({ cliPath: "~/.openclaw/imsg-remote" })).resolves.toBe(
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

  it("detects only the documented user-qualified and host-only SSH wrappers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-wrapper-"));
    tempDirs.push(dir);
    const userWrapper = path.join(dir, "user-wrapper");
    const hostWrapper = path.join(dir, "host-wrapper");
    await fs.writeFile(userWrapper, '#!/bin/sh\nexec ssh user@example.test imsg "$@"\n', "utf8");
    await fs.writeFile(hostWrapper, '#!/bin/sh\nexec ssh -T messages-mac imsg "$@"\n', "utf8");

    await expect(resolveIMessageRemoteHost({ cliPath: userWrapper })).resolves.toBe(
      "user@example.test",
    );
    await expect(resolveIMessageRemoteHost({ cliPath: hostWrapper })).resolves.toBe("messages-mac");
  });

  it("detects absolute and simply quoted ssh and imsg executable paths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-wrapper-paths-"));
    tempDirs.push(dir);
    const absoluteWrapper = path.join(dir, "absolute-wrapper");
    const quotedWrapper = path.join(dir, "quoted-wrapper");
    await fs.writeFile(
      absoluteWrapper,
      '#!/bin/sh\nexec /usr/bin/ssh bot@messages-mac /opt/homebrew/bin/imsg "$@"\n',
    );
    await fs.writeFile(
      quotedWrapper,
      `#!/bin/sh\nexec "/usr/bin/ssh" -T messages-mac '/opt/homebrew/bin/imsg' "$@"\n`,
    );

    await expect(resolveIMessageRemoteHost({ cliPath: absoluteWrapper })).resolves.toBe(
      "bot@messages-mac",
    );
    await expect(resolveIMessageRemoteHost({ cliPath: quotedWrapper })).resolves.toBe(
      "messages-mac",
    );
  });

  it.each([
    ['exec ssh -J jump@bastion bot@messages-mac imsg "$@"', "jump host"],
    ['exec ssh -o ProxyJump=jump@bastion bot@messages-mac imsg "$@"', "ProxyJump"],
    ['exec ssh -o ProxyCommand=jump@bastion bot@messages-mac imsg "$@"', "ProxyCommand"],
    ['exec ssh -F jump@bastion bot@messages-mac imsg "$@"', "config option"],
    ['exec ssh -W jump@bastion bot@messages-mac imsg "$@"', "stdio forward"],
    ['exec ssh -L jump@bastion bot@messages-mac imsg "$@"', "port forward"],
    ["exec ssh bot@messages-mac imsg", "missing argument forwarding"],
  ])("rejects an ambiguous %s wrapper (%s)", async (command) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-ambiguous-"));
    tempDirs.push(dir);
    const wrapperPath = path.join(dir, "imsg-remote");
    await fs.writeFile(wrapperPath, `#!/bin/sh\n${command}\n`);
    const readFile = vi.spyOn(fs, "readFile");

    await expect(resolveIMessageRemoteHost({ cliPath: wrapperPath })).rejects.toThrow(
      "configure channels.imessage.remoteHost explicitly",
    );
    await expect(resolveIMessageRemoteHost({ cliPath: wrapperPath })).rejects.toThrow(
      "configure channels.imessage.remoteHost explicitly",
    );
    expect(readFile).toHaveBeenCalledOnce();
    expect(getCachedIMessageRemoteHost({ cliPath: wrapperPath })).toBeUndefined();
  });

  it("rejects multiline backslash command construction", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-multiline-"));
    tempDirs.push(dir);
    const wrapperPath = path.join(dir, "imsg-remote");
    await fs.writeFile(
      wrapperPath,
      ["#!/bin/sh", "exec ssh -J jump@bastion \\", '  bot@messages-mac imsg "$@"', ""].join("\n"),
    );

    await expect(resolveIMessageRemoteHost({ cliPath: wrapperPath })).rejects.toThrow(
      "configure channels.imessage.remoteHost explicitly",
    );
    expect(getCachedIMessageRemoteHost({ cliPath: wrapperPath })).toBeUndefined();
  });

  it.each([
    [
      "continued exec",
      ["#!/bin/sh", "exec \\", 'ssh -J jump@bastion bot@messages-mac imsg "$@"', ""].join("\n"),
    ],
    [
      "continued simple ssh",
      ["#!/bin/sh", "exec \\", 'ssh bot@messages-mac imsg "$@"', ""].join("\n"),
    ],
    [
      "bare ssh in a complex script",
      ["#!/bin/sh", "if true; then", '  ssh bot@messages-mac imsg "$@"', "fi", ""].join("\n"),
    ],
    [
      "absolute ssh in a complex script",
      ["#!/bin/sh", "if true; then", '  /usr/bin/ssh bot@messages-mac imsg "$@"', "fi", ""].join(
        "\n",
      ),
    ],
    [
      "quoted ssh in a complex script",
      ["#!/bin/sh", "if true; then", '  "/usr/bin/ssh" bot@messages-mac imsg "$@"', "fi", ""].join(
        "\n",
      ),
    ],
  ])("caches %s as ambiguous", async (_label, content) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-complex-"));
    tempDirs.push(dir);
    const wrapperPath = path.join(dir, "imsg-remote");
    await fs.writeFile(wrapperPath, content);
    const readFile = vi.spyOn(fs, "readFile");

    await expect(resolveIMessageRemoteHost({ cliPath: wrapperPath })).rejects.toThrow(
      "configure channels.imessage.remoteHost explicitly",
    );
    await expect(resolveIMessageRemoteHost({ cliPath: wrapperPath })).rejects.toThrow(
      "configure channels.imessage.remoteHost explicitly",
    );
    expect(readFile).toHaveBeenCalledOnce();
    expect(getCachedIMessageRemoteHost({ cliPath: wrapperPath })).toBeUndefined();
  });

  it("lets explicit remoteHost override an ambiguous wrapper without reading it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-explicit-"));
    tempDirs.push(dir);
    const wrapperPath = path.join(dir, "imsg-remote");
    await fs.writeFile(
      wrapperPath,
      '#!/bin/sh\nexec ssh -J jump@bastion bot@messages-mac imsg "$@"\n',
    );
    const readFile = vi.spyOn(fs, "readFile");

    await expect(
      resolveIMessageRemoteHost({ cliPath: wrapperPath, remoteHost: "bot@messages-mac" }),
    ).resolves.toBe("bot@messages-mac");
    expect(readFile).not.toHaveBeenCalled();
    expect(
      getCachedIMessageRemoteHost({ cliPath: wrapperPath, remoteHost: "bot@messages-mac" }),
    ).toBe("bot@messages-mac");
  });

  it("returns undefined when the wrapper does not exist", async () => {
    const missingWrapper = path.join(os.tmpdir(), `openclaw-imessage-missing-${randomUUID()}`);

    await expect(resolveIMessageRemoteHost({ cliPath: missingWrapper })).resolves.toBeUndefined();
  });

  it("coalesces concurrent wrapper reads and keys the cache by expanded cliPath", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-cache-"));
    tempDirs.push(home);
    vi.stubEnv("HOME", home);
    const wrapperPath = path.join(home, ".openclaw", "imsg-remote");
    await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
    await fs.writeFile(wrapperPath, '#!/bin/sh\nexec ssh bot@messages-mac imsg "$@"\n');
    const readFile = vi.spyOn(fs, "readFile");

    await expect(
      Promise.all([
        resolveIMessageRemoteHost({ cliPath: "~/.openclaw/imsg-remote" }),
        resolveIMessageRemoteHost({ cliPath: wrapperPath }),
      ]),
    ).resolves.toEqual(["bot@messages-mac", "bot@messages-mac"]);
    expect(readFile).toHaveBeenCalledOnce();
    expect(getCachedIMessageRemoteHost({ cliPath: wrapperPath })).toBe("bot@messages-mac");

    await fs.writeFile(wrapperPath, '#!/bin/sh\nexec ssh changed@other-mac imsg "$@"\n');
    await expect(resolveIMessageRemoteHost({ cliPath: wrapperPath })).resolves.toBe(
      "bot@messages-mac",
    );
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("caches a non-SSH wrapper as local across concurrent callers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-local-wrapper-"));
    tempDirs.push(dir);
    const wrapperPath = path.join(dir, "imsg-local");
    await fs.writeFile(wrapperPath, '#!/bin/sh\nexec /opt/homebrew/bin/imsg "$@"\n');
    const readFile = vi.spyOn(fs, "readFile");

    await expect(
      Promise.all([
        resolveIMessageRemoteHost({ cliPath: wrapperPath }),
        resolveIMessageRemoteHost({ cliPath: wrapperPath }),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("never resolves a remote dbPath against the Gateway home", () => {
    vi.stubEnv("HOME", "/Users/gateway");

    expect(
      resolveIMessageChatDbLookupPath({
        cliPath: "/gateway/imsg-ssh",
        dbPath: "~/Library/Messages/chat.db",
        remoteHost: "messages-mac",
      }),
    ).toBeUndefined();
    expect(
      resolveIMessageChatDbLookupPath({
        cliPath: "imsg",
        dbPath: "~/Library/Messages/chat.db",
      }),
    ).toBe("/Users/gateway/Library/Messages/chat.db");
  });
});
