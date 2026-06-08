// SSH sandbox helper tests cover temp auth materialization, remote command
// validation, shell quoting, and upload symlink safety.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExecRemoteCommand,
  buildValidatedExecRemoteCommand,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT,
  type SshSandboxSession,
  uploadDirectoryToSshTarget,
} from "./ssh.js";

const sessions: SshSandboxSession[] = [];
const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    sessions.splice(0).map(async (session) => {
      await disposeSshSandboxSession(session);
    }),
  );
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("sandbox ssh helpers", () => {
  it("materializes inline ssh auth data into a temp config", async () => {
    // Inline key/cert/known-host material is written to private temp files and
    // referenced from the generated ssh config.
    const session = await createSshSandboxSessionFromSettings({
      command: "ssh",
      target: "peter@example.com:2222",
      strictHostKeyChecking: true,
      updateHostKeys: false,
      identityData: "PRIVATE KEY",
      certificateData: "SSH CERT",
      knownHostsData: "example.com ssh-ed25519 AAAATEST",
    });
    sessions.push(session);

    const config = await fs.readFile(session.configPath, "utf8");
    expect(config).toContain("Host openclaw-sandbox");
    expect(config).toContain("HostName example.com");
    expect(config).toContain("User peter");
    expect(config).toContain("Port 2222");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).toContain("UpdateHostKeys no");

    const configDir = session.configPath.slice(0, session.configPath.lastIndexOf("/"));
    expect(await fs.readFile(`${configDir}/identity`, "utf8")).toBe("PRIVATE KEY\n");
    expect(await fs.readFile(`${configDir}/certificate.pub`, "utf8")).toBe("SSH CERT\n");
    expect(await fs.readFile(`${configDir}/known_hosts`, "utf8")).toBe(
      "example.com ssh-ed25519 AAAATEST\n",
    );
  });

  it("normalizes CRLF and escaped-newline private keys before writing temp files", async () => {
    const session = await createSshSandboxSessionFromSettings({
      command: "ssh",
      target: "peter@example.com:2222",
      strictHostKeyChecking: true,
      updateHostKeys: false,
      identityData:
        "-----BEGIN OPENSSH PRIVATE KEY-----\\nbGluZTE=\\r\\nbGluZTI=\\r\\n-----END OPENSSH PRIVATE KEY-----",
      knownHostsData: "example.com ssh-ed25519 AAAATEST",
    });
    sessions.push(session);

    const configDir = session.configPath.slice(0, session.configPath.lastIndexOf("/"));
    expect(await fs.readFile(`${configDir}/identity`, "utf8")).toBe(
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "bGluZTE=\n" +
        "bGluZTI=\n" +
        "-----END OPENSSH PRIVATE KEY-----\n",
    );
  });

  it("normalizes mixed real and escaped newlines in private keys", async () => {
    const session = await createSshSandboxSessionFromSettings({
      command: "ssh",
      target: "peter@example.com:2222",
      strictHostKeyChecking: true,
      updateHostKeys: false,
      identityData:
        "-----BEGIN OPENSSH PRIVATE KEY-----\nline-1\\nline-2\n-----END OPENSSH PRIVATE KEY-----",
      knownHostsData: "example.com ssh-ed25519 AAAATEST",
    });
    sessions.push(session);

    const configDir = session.configPath.slice(0, session.configPath.lastIndexOf("/"));
    expect(await fs.readFile(`${configDir}/identity`, "utf8")).toBe(
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "line-1\n" +
        "line-2\n" +
        "-----END OPENSSH PRIVATE KEY-----\n",
    );
  });

  it("wraps remote exec commands with env and workdir", () => {
    const command = buildExecRemoteCommand({
      command: "pwd && printenv TOKEN",
      workdir: "/sandbox/project",
      env: {
        TOKEN: "abc 123",
      },
    });
    expect(command).toContain(`'env'`);
    expect(command).toContain(`'TOKEN=abc 123'`);
    expect(command).toContain(`'cd '"'"'/sandbox/project'"'"' && pwd && printenv TOKEN'`);
  });

  it("keeps the public exec command builder quote-only for compatibility", () => {
    const command = buildExecRemoteCommand({
      command: "workflow run <workflow-id> --ref main",
      env: {},
    });

    expect(command).toContain(`'/bin/sh'`);
    expect(command).toContain(`'workflow run <workflow-id> --ref main'`);
  });

  it.each([
    ["workflow install <name>", /unresolved placeholder token <name>/],
    ["workflow run <workflow-id> --ref main", /unresolved placeholder token <workflow-id>/],
    ["echo $(workflow run <workflow-id> --ref main)", /unresolved placeholder token <workflow-id>/],
    ["WORKFLOW_ID=<workflow-id> workflow run", /unresolved placeholder token <workflow-id>/],
    ['echo "unterminated', /unclosed double quote/],
    ["printf '%s", /unclosed single quote/],
    ["echo foo\\", /trailing backslash escape/],
    ["echo `date", /unterminated backtick command substitution/],
    ["echo $(date", /unterminated command substitution/],
    ["echo $((1 << 2)", /unterminated arithmetic expansion/],
    ["cat <<EOF", /unterminated here-doc EOF/],
    ["cat <<EOF\nstill open", /unterminated here-doc EOF/],
  ])("rejects malformed generated exec commands: %s", (rawCommand, message) => {
    expect(() =>
      buildValidatedExecRemoteCommand({
        command: rawCommand,
        env: {},
      }),
    ).toThrow(message);
  });

  it("allows shell features and quoted placeholder-looking text", () => {
    expect(() =>
      buildValidatedExecRemoteCommand({
        command: [
          "cat < input.txt > output.txt",
          "cat <in>out",
          "cat <input> output",
          "cat = <input-file> output.txt",
          'cat <input-file> "output file"',
          "cat <<'EOF' > literal.txt",
          "<workflow-id>",
          '"unterminated quote text is data here',
          "`unterminated backtick text is data here",
          "EOF",
          ": <<EOF $(printf '%s' hi\n)\nbody\nEOF",
          "echo $(cat <<EOF\ninside\nEOF\n)",
          "cat <<EOF\r\nwindows line endings\r\nEOF\r\n",
          "echo $(printf '%s' ok)",
          "echo `date`",
          "diff <(sort left.txt) <(sort right.txt)",
          "echo $((1 << 2))",
          'printf "%s\\n" "<name>"',
          "# workflow run <workflow-id>",
        ].join("\n"),
        env: {},
      }),
    ).not.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when remote upload directory validation fails",
    () => {
      expect(ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT.split("\n")[0]).toBe("set -e");
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows symlinked ancestors before the trusted remote root",
    async () => {
      const realParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-real-"));
      tempDirs.push(realParent);
      const linkParent = `${realParent}-link`;
      tempDirs.push(linkParent);
      await fs.symlink(realParent, linkParent);

      const root = path.join(linkParent, "runtime");
      const target = path.join(root, "workspace", ".openclaw", "sandbox-skills");
      await execFileAsync("/bin/sh", [
        "-c",
        ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT,
        "openclaw-remote-dir",
        target,
        root,
      ]);

      await expect(
        fs.stat(path.join(realParent, "runtime", "workspace", ".openclaw", "sandbox-skills")),
      ).resolves.toMatchObject({ dev: expect.any(Number) });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked directories inside the trusted remote root",
    async () => {
      const realParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-real-"));
      tempDirs.push(realParent);
      const root = path.join(realParent, "runtime");
      await fs.mkdir(path.join(root, "workspace"), { recursive: true });
      await fs.symlink(realParent, path.join(root, "workspace", ".openclaw"));

      await expect(
        execFileAsync("/bin/sh", [
          "-c",
          ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT,
          "openclaw-remote-dir",
          path.join(root, "workspace", ".openclaw", "sandbox-skills"),
          root,
        ]),
      ).rejects.toThrow(/unsafe remote directory symlink/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects upload trees with symlinks that escape the local workspace",
    async () => {
      const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-"));
      tempDirs.push(localDir);
      await fs.symlink("/etc", path.join(localDir, "escape"));

      await expect(
        uploadDirectoryToSshTarget({
          session: {
            command: "ssh",
            configPath: "/tmp/openclaw-test-ssh-config",
            host: "openclaw-sandbox",
          },
          localDir,
          remoteDir: "/remote/workspace",
        }),
      ).rejects.toThrow(/refuses symlink escaping the workspace: escape/i);
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows in-workspace symlinks that point to hardlinked files",
    async () => {
      const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-safe-"));
      tempDirs.push(localDir);
      const fakeSsh = path.join(localDir, "fake-ssh.sh");
      await fs.writeFile(fakeSsh, "#!/bin/sh\ncat >/dev/null\n", { mode: 0o755 });
      await fs.writeFile(path.join(localDir, "source.txt"), "hello");
      await fs.link(path.join(localDir, "source.txt"), path.join(localDir, "hardlinked.txt"));
      await fs.symlink("source.txt", path.join(localDir, "link.txt"));

      await expect(
        uploadDirectoryToSshTarget({
          session: {
            command: fakeSsh,
            configPath: "/tmp/openclaw-test-ssh-config",
            host: "openclaw-sandbox",
          },
          localDir,
          remoteDir: "/remote/workspace",
        }),
      ).resolves.toBeUndefined();
    },
  );
});
