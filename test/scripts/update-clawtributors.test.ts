// Update Clawtributors tests cover update clawtributors script behavior.
import { execFileSync as realExecFileSync } from "node:child_process";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();

type GhRunner = (args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../scripts/lib/plain-gh.mjs");
  vi.resetModules();
});

function mockClawtributorsFixture({
  ensureLogins = [],
  seedEntry,
  accountLookup,
  accountLookupError,
  accountLookupStatus = 404,
  loginLookupError,
  runGh,
}: {
  ensureLogins?: string[];
  seedEntry?: string;
  accountLookup?: {
    id: number;
    login: string;
    html_url: string;
    avatar_url: string;
  } | null;
  accountLookupError?: Error;
  accountLookupStatus?: 404 | 410;
  loginLookupError?: Error;
  runGh?: GhRunner;
} = {}) {
  const readme = [
    "# Fixture",
    "",
    "Thanks to all clawtributors:",
    "",
    "<!-- clawtributors:start -->",
    "<!-- clawtributors:end -->",
    "",
  ].join("\n");
  let writtenReadme = "";
  vi.doMock("node:fs", () => ({
    readFileSync: vi.fn((path: string) => {
      if (path.endsWith("scripts/clawtributors-map.json")) {
        return `${JSON.stringify({ ensureLogins, seedCommit: seedEntry ? "seed-sha" : undefined })}\n`;
      }
      if (path.endsWith("README.md")) {
        return readme;
      }
      throw new Error(`unexpected read: ${path}`);
    }),
    writeFileSync: vi.fn((path: string, data: string) => {
      if (path.endsWith("README.md")) {
        writtenReadme = data;
        return;
      }
      throw new Error(`unexpected write: ${path}`);
    }),
  }));
  const contributor = {
    id: 1,
    login: "octo",
    name: "Octo",
    html_url: "https://github.com/octo",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    contributions: 3,
  };
  const execSync = vi.fn((cmd: string) => {
    if (cmd === "git log --reverse --format=%aN%x1f%aE%x1f%aI --numstat") {
      return "";
    }
    if (cmd === "git show seed-sha:README.md" && seedEntry) {
      return readme.replace(
        "<!-- clawtributors:start -->\n<!-- clawtributors:end -->",
        `<!-- clawtributors:start -->\n${seedEntry}\n<!-- clawtributors:end -->`,
      );
    }
    if (cmd === "git rev-list --max-parents=0 HEAD") {
      return "root-sha\n";
    }
    if (cmd === "git log --format=%aI -1 root-sha") {
      return "2024-01-01T00:00:00Z\n";
    }
    throw new Error(`unexpected command: ${cmd}`);
  });
  const execPlainGh = vi.fn(
    (args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
      if (runGh) {
        return runGh(args, options);
      }
      if (
        args.join("\0") ===
        ["api", "repos/openclaw/openclaw/contributors?per_page=100&anon=1", "--paginate"].join("\0")
      ) {
        return `${JSON.stringify([contributor])}\n`;
      }
      if (
        args.join("\0") ===
        [
          "pr",
          "list",
          "-R",
          "openclaw/openclaw",
          "--state",
          "merged",
          "--limit",
          "5000",
          "--json",
          "author",
          "--jq",
          ".[].author.login",
        ].join("\0")
      ) {
        return "";
      }
      if (args[0] === "api" && args[1]?.startsWith("users/")) {
        if (loginLookupError) {
          throw loginLookupError;
        }
        const login = args[1].slice("users/".length);
        return JSON.stringify({
          id: 2,
          login,
          html_url: `https://github.com/${login}`,
          avatar_url: "https://avatars.githubusercontent.com/u/2?v=4",
        });
      }
      if (args[0] === "api" && args[1]?.startsWith("user/")) {
        if (accountLookupError) {
          throw accountLookupError;
        }
        if (!accountLookup) {
          throw Object.assign(new Error("gh api failed"), {
            stderr: Buffer.from(`gh: account missing (HTTP ${accountLookupStatus})\n`),
          });
        }
        return JSON.stringify(accountLookup);
      }
      throw new Error(`unexpected gh arguments: ${args.join(" ")}`);
    },
  );
  vi.doMock("../../scripts/lib/plain-gh.mjs", () => ({ execPlainGh }));
  vi.doMock("node:child_process", () => ({
    execSync,
  }));
  return {
    execPlainGh,
    readWrittenReadme: () => writtenReadme,
  };
}

async function importUpdateClawtributors() {
  const scriptUrl = pathToFileURL(resolve(originalCwd, "scripts/update-clawtributors.ts")).href;
  await import(`${scriptUrl}?case=${Date.now()}`);
}

describe("update-clawtributors", () => {
  it("bounds every GitHub CLI lookup", async () => {
    const fixture = mockClawtributorsFixture({ ensureLogins: ["extra"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await importUpdateClawtributors();

    const options = {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 200,
      timeout: 120_000,
      killSignal: "SIGKILL",
    };
    expect(fixture.execPlainGh).toHaveBeenNthCalledWith(
      1,
      ["api", "repos/openclaw/openclaw/contributors?per_page=100&anon=1", "--paginate"],
      options,
    );
    expect(fixture.execPlainGh).toHaveBeenNthCalledWith(2, ["api", "users/extra"], options);
    expect(fixture.execPlainGh).toHaveBeenNthCalledWith(
      3,
      [
        "pr",
        "list",
        "-R",
        "openclaw/openclaw",
        "--state",
        "merged",
        "--limit",
        "5000",
        "--json",
        "author",
        "--jq",
        ".[].author.login",
      ],
      options,
    );
  });

  it("kills a sleeping GitHub CLI process at the deadline", async () => {
    const fixture = mockClawtributorsFixture({
      runGh: (_args, options) => {
        expect(options).toMatchObject({ timeout: 120_000, killSignal: "SIGKILL" });
        return realExecFileSync(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
          ...options,
          timeout: 50,
        });
      },
    });

    await expect(importUpdateClawtributors()).rejects.toMatchObject({
      code: "ETIMEDOUT",
      signal: "SIGKILL",
    });
    expect(fixture.execPlainGh).toHaveBeenCalledTimes(1);
  });

  it("aborts on transient login lookup failures", async () => {
    const fixture = mockClawtributorsFixture({
      ensureLogins: ["extra"],
      loginLookupError: new Error("GitHub login lookup unavailable"),
    });

    await expect(importUpdateClawtributors()).rejects.toThrow("GitHub login lookup unavailable");

    expect(fixture.readWrittenReadme()).toBe("");
  });

  it("resolves renamed seed profiles by stable account id", async () => {
    const fixture = mockClawtributorsFixture({
      seedEntry:
        '<a href="https://github.com/old-handle"><img src="https://avatars.githubusercontent.com/u/42?v=4&s=48" width="48" height="48" alt="Original credit"></a>',
      accountLookup: {
        id: 42,
        login: "new-handle",
        html_url: "https://github.com/new-handle",
        avatar_url: "https://avatars.githubusercontent.com/u/42?v=4",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await importUpdateClawtributors();

    expect(fixture.execPlainGh).toHaveBeenCalledWith(
      ["api", "user/42"],
      expect.objectContaining({ timeout: 120_000, killSignal: "SIGKILL" }),
    );
    expect(fixture.readWrittenReadme()).toContain(
      '<a href="https://github.com/new-handle"><img src="https://avatars.githubusercontent.com/u/42?v=4&s=48" width="48" height="48" alt="Original credit"></a>',
    );
    expect(fixture.readWrittenReadme()).not.toContain('href="https://github.com/old-handle"');
  });

  it.each([404, 410] as const)(
    "keeps deleted seed profiles as unlinked credit on HTTP %s",
    async (accountLookupStatus) => {
      const fixture = mockClawtributorsFixture({
        seedEntry:
          '<a href="https://github.com/gone-handle"><img src="https://avatars.githubusercontent.com/u/42?v=4&s=48" width="48" height="48" alt="Gone contributor"></a>',
        accountLookup: null,
        accountLookupStatus,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 404 })),
      );
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await importUpdateClawtributors();

      expect(fixture.readWrittenReadme()).toContain(
        '<img src="https://avatars.githubusercontent.com/u/42?v=4&s=48" width="48" height="48" alt="Gone contributor">',
      );
      expect(fixture.readWrittenReadme()).not.toContain('href="https://github.com/gone-handle"');
    },
  );

  it("aborts instead of unlinking credit on transient account lookup failures", async () => {
    const fixture = mockClawtributorsFixture({
      seedEntry:
        '<a href="https://github.com/current-handle"><img src="https://avatars.githubusercontent.com/u/42?v=4&s=48" width="48" height="48" alt="Current contributor"></a>',
      accountLookupError: new Error("GitHub API unavailable"),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(importUpdateClawtributors()).rejects.toThrow("GitHub API unavailable");

    expect(fixture.readWrittenReadme()).toBe("");
  });

  it("rejects unsafe avatar probe content lengths before reading the body", async () => {
    const fixture = mockClawtributorsFixture();
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    vi.stubGlobal("fetch", (() =>
      Promise.resolve({
        ok: true,
        headers: new Headers({ "content-length": "9007199254740992" }),
        arrayBuffer,
      } as unknown as Response)) as typeof fetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await importUpdateClawtributors();

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fixture.readWrittenReadme()).toContain("https://github.com/octo");
  });

  it("cancels stalled avatar probe body reads at the probe timeout", async () => {
    const fixture = mockClawtributorsFixture();
    let signal: AbortSignal | undefined;
    let canceled = false;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      markFetchStarted = resolveStarted;
    });
    vi.stubGlobal("fetch", ((_url, init) => {
      signal = init?.signal ?? undefined;
      markFetchStarted();
      return Promise.resolve(
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              canceled = true;
            },
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.useFakeTimers();
    const imported = importUpdateClawtributors();

    await fetchStarted;
    await vi.advanceTimersByTimeAsync(8000);
    await imported;
    await Promise.resolve();

    expect(signal?.aborted).toBe(true);
    expect(canceled).toBe(true);
    expect(fixture.readWrittenReadme()).toContain("https://github.com/octo");
  });
});
