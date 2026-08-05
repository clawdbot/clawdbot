import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTelegramBotTokenRuntime, testing } from "./telegram-bot-token-runtime.js";

const tempDirs: string[] = [];

function createCredentialDependencies(token: string, source: "convex" | "env" = "env") {
  const release = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  return {
    dependencies: {
      acquireCredential: async () => ({
        heartbeat: async () => undefined,
        heartbeatIntervalMs: source === "convex" ? 30_000 : 0,
        kind: "telegram",
        payload: { sutToken: token },
        release,
        source,
      }),
      startCredentialHeartbeat: () => ({
        stop,
        throwIfFailed: () => undefined,
      }),
    },
    release,
    stop,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("telegram bot token runtime evidence", () => {
  it("resolves only dedicated leased credentials", () => {
    expect(
      testing.resolveLeasedToken({
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "leased-token",
        TELEGRAM_E2E_SUT_BOT_TOKEN: "secondary-leased-token",
        TELEGRAM_BOT_TOKEN: "generic-token",
      }),
    ).toEqual({ key: "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN", token: "leased-token" });
  });

  it("writes blocked evidence without a dedicated credential", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-bot-token-"));
    tempDirs.push(artifactBase);
    const evidence = await runTelegramBotTokenRuntime(
      { artifactBase, repoRoot: process.cwd(), startupTimeoutMs: 100 },
      { OPENCLAW_QA_CREDENTIAL_SOURCE: "env", TELEGRAM_BOT_TOKEN: "generic-token" },
    );

    expect(evidence.entries[0]?.result.status).toBe("blocked");
    const log = await fs.readFile(
      path.join(artifactBase, "telegram-startup-getme-live.log"),
      "utf8",
    );
    expect(log).toContain("blocked");
    expect(log).not.toContain("generic-token");
  });

  it("launches the real Gateway shape and redacts the leased token from evidence", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-startup-getme-"));
    tempDirs.push(artifactBase);
    const leasedToken = "123456:leased-secret";
    const cleanup = vi.fn(async () => undefined);
    const startGateway = vi.fn(async () => undefined);
    const credential = createCredentialDependencies(leasedToken);
    let instanceOptions: Record<string, unknown> | undefined;

    const evidence = await runTelegramBotTokenRuntime(
      { artifactBase, repoRoot: process.cwd(), startupTimeoutMs: 100 },
      { OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: leasedToken },
      {
        ...credential.dependencies,
        createInstance: async (options) => {
          instanceOptions = options as unknown as Record<string, unknown>;
          return {
            cleanup,
            startGateway,
            logs: () =>
              `[qa-live] starting provider (@qa_test_bot) token=${leasedToken}\n` +
              "[telegram][diag] polling cycle started\n",
          };
        },
      },
    );

    expect(evidence.entries[0]?.result.status).toBe("pass");
    expect(startGateway).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(credential.stop).toHaveBeenCalledOnce();
    expect(credential.release).toHaveBeenCalledOnce();
    expect(instanceOptions).toMatchObject({
      config: {
        channels: {
          telegram: {
            defaultAccount: "qa-live",
            accounts: { "qa-live": { botToken: leasedToken } },
          },
        },
      },
      env: {
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    const log = await fs.readFile(
      path.join(artifactBase, "telegram-startup-getme-live.log"),
      "utf8",
    );
    expect(log).toContain("product startAccount resolved getMe bot identity before polling");
    expect(log).toContain("[REDAC");
    expect(log).not.toContain(leasedToken);
  });

  it("requires product startup to precede polling and bounds the wait", async () => {
    await expect(
      testing.waitForProductStartup(
        {
          cleanup: async () => undefined,
          startGateway: async () => undefined,
          logs: () =>
            "[telegram][diag] polling cycle started\n" +
            "[qa-live] starting provider (@qa_test_bot)\n",
        },
        10,
      ),
    ).rejects.toThrow("product startup getMe timed out");
  });

  it("redacts leased tokens from startup failure evidence", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-startup-failure-"));
    tempDirs.push(artifactBase);
    const leasedToken = "123456:leased-secret";
    const credential = createCredentialDependencies(leasedToken);

    const evidence = await runTelegramBotTokenRuntime(
      { artifactBase, repoRoot: process.cwd(), startupTimeoutMs: 100 },
      { OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: leasedToken },
      {
        ...credential.dependencies,
        createInstance: async () => ({
          cleanup: async () => undefined,
          logs: () => "",
          startGateway: async () => {
            throw new Error(
              `Telegram startup failed for https://api.telegram.org/bot${leasedToken}/getMe`,
            );
          },
        }),
      },
    );

    expect(evidence.entries[0]?.result.status).toBe("fail");
    expect(JSON.stringify(evidence)).not.toContain(leasedToken);
    const log = await fs.readFile(
      path.join(artifactBase, "telegram-startup-getme-live.log"),
      "utf8",
    );
    expect(log).not.toContain(leasedToken);
    expect(credential.release).toHaveBeenCalledOnce();
  });

  it("uses the configured shared lease when no dedicated token env is present", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-bot-lease-"));
    tempDirs.push(artifactBase);
    const leasedToken = "123456:convex-secret";
    const credential = createCredentialDependencies(leasedToken, "convex");
    const createInstance = vi.fn(async () => ({
      cleanup: async () => undefined,
      startGateway: async () => undefined,
      logs: () =>
        `[qa-live] starting provider (@qa_test_bot) token=${leasedToken}\n` +
        "[telegram][diag] polling cycle started\n",
    }));

    const evidence = await runTelegramBotTokenRuntime(
      { artifactBase, repoRoot: process.cwd(), startupTimeoutMs: 100 },
      { OPENCLAW_QA_CREDENTIAL_SOURCE: "convex" },
      { ...credential.dependencies, createInstance },
    );

    expect(evidence.entries[0]?.result.status).toBe("pass");
    expect(createInstance).toHaveBeenCalledOnce();
    expect(credential.stop).toHaveBeenCalledOnce();
    expect(credential.release).toHaveBeenCalledOnce();
  });
});
