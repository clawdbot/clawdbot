import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveImapConfig, type ImapAccountConfig } from "./config.js";
import { createImapAuthResult, createImapTestRuntime } from "./imap-test-support.js";
import { ImapAccountWatcher } from "./watcher.js";

type MailFixture = { uid: number; raw: string };

class ScriptedImapServer {
  readonly sockets = new Set<Socket>();
  readonly commands: string[] = [];
  readonly messages: MailFixture[] = [];
  uidValidity = "17";
  connectionCount = 0;
  rejectAuthentication = false;
  fetchGate: Promise<void> | undefined;
  private readonly server: Server;

  constructor(private readonly supportsIdle = true) {
    this.server = createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<number> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("scripted IMAP server did not bind a TCP port");
    }
    return address.port;
  }

  append(raw: string): void {
    const uid = (this.messages.at(-1)?.uid ?? 0) + 1;
    this.messages.push({ uid, raw });
    this.announce();
  }

  announce(): void {
    for (const socket of this.sockets) {
      socket.write(`* ${this.messages.length} EXISTS\r\n`);
    }
  }

  disconnect(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  async close(): Promise<void> {
    this.disconnect();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private accept(socket: Socket): void {
    this.connectionCount++;
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    const capabilities = `IMAP4rev1${this.supportsIdle ? " IDLE" : ""}`;
    socket.write(`* OK [CAPABILITY ${capabilities}] scripted IMAP ready\r\n`);
    let buffered = "";
    let idleTag: string | undefined;
    socket.on("data", (data: Buffer) => {
      buffered += data.toString("utf8");
      let separator: number;
      while ((separator = buffered.indexOf("\r\n")) >= 0) {
        const line = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        this.commands.push(line);
        if (line === "DONE" && idleTag) {
          socket.write(`${idleTag} OK IDLE completed\r\n`);
          idleTag = undefined;
          continue;
        }
        const [tag, command, subcommand] = line.split(" ");
        const upper = command?.toUpperCase();
        if (upper === "CAPABILITY") {
          socket.write(`* CAPABILITY ${capabilities}\r\n${tag} OK CAPABILITY completed\r\n`);
        } else if (upper === "LOGIN") {
          socket.write(
            this.rejectAuthentication
              ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`
              : `${tag} OK LOGIN completed\r\n`,
          );
        } else if (upper === "LIST" || upper === "LSUB") {
          socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST completed\r\n`);
        } else if (upper === "EXAMINE" || upper === "SELECT") {
          socket.write(
            `* FLAGS (\\Seen)\r\n* ${this.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${this.uidValidity}] valid\r\n* OK [UIDNEXT ${(this.messages.at(-1)?.uid ?? 0) + 1}] next\r\n${tag} OK [READ-ONLY] opened\r\n`,
          );
        } else if (upper === "IDLE") {
          idleTag = tag;
          socket.write("+ idling\r\n");
        } else if (upper === "UID" && subcommand?.toUpperCase() === "FETCH") {
          const minimum = Number(line.split(" ")[3]?.split(":")[0]);
          // Snapshot the response at command time: a held response must not absorb
          // messages appended while the fetch is in flight.
          const selected = this.messages.filter((entry) => entry.uid >= minimum);
          const matches = selected.length ? selected : this.messages.slice(-1);
          const respond = () => {
            for (const mail of matches) {
              const date = new Date()
                .toUTCString()
                .slice(5)
                .replace(/ /u, "-")
                .replace(/ /u, "-")
                .replace(" GMT", " +0000");
              socket.write(
                `* ${mail.uid} FETCH (UID ${mail.uid} INTERNALDATE "${date}" RFC822.SIZE ${Buffer.byteLength(mail.raw)} BODY[]<0> {${Buffer.byteLength(mail.raw)}}\r\n${mail.raw})\r\n`,
              );
            }
            socket.write(`${tag} OK FETCH completed\r\n`);
          };
          const gate = this.fetchGate;
          if (gate) {
            void gate.then(respond);
          } else {
            respond();
          }
        } else {
          socket.write(`${tag} OK completed\r\n`);
        }
      }
    });
  }
}

const activeServers: ScriptedImapServer[] = [];
const activeWatchers: ImapAccountWatcher[] = [];

afterEach(async () => {
  await Promise.all(activeWatchers.splice(0).map((watcher) => watcher.stop()));
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

async function startWatcher(
  options: {
    supportsIdle?: boolean;
    rejectAuthentication?: boolean;
    account?: Partial<ImapAccountConfig>;
  } = {},
) {
  const server = new ScriptedImapServer(options.supportsIdle);
  server.rejectAuthentication = options.rejectAuthentication ?? false;
  activeServers.push(server);
  server.append("From: trusted@example.com\r\nSubject: Existing\r\n\r\nExisting email");
  const port = await server.listen();
  const account = resolveImapConfig({
    accounts: {
      inbox: {
        host: "127.0.0.1",
        port,
        secure: false,
        user: "reader@example.com",
        password: "fixture-password",
        agentId: "mail_reader",
        allowedSenders: ["trusted@example.com"],
      },
    },
  }).accounts.inbox;
  if (!account) {
    throw new Error("fixture account was not configured");
  }
  Object.assign(account, options.account);
  const { runtime, state, dispatchHookAgentTurn } = createImapTestRuntime();
  const context: OpenClawPluginServiceContext = {
    config: {},
    stateDir: "/unused-imap-test-state",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    serviceHealth: { clearFailure: vi.fn(), reportFailure: vi.fn() },
  };
  const authenticator = vi.fn(async () => createImapAuthResult("pass"));
  const watcher = new ImapAccountWatcher({
    accountId: "inbox",
    account,
    runtime,
    state,
    context,
    authenticator,
  });
  activeWatchers.push(watcher);
  watcher.start();
  return { server, watcher, state, context, authenticator, dispatchHookAgentTurn };
}

describe("IMAP watcher protocol boundary", () => {
  it("sweeps a pushed message through the real IMAP connection into one isolated hook dispatch", async () => {
    const { server, state, dispatchHookAgentTurn } = await startWatcher();
    await vi.waitFor(async () => {
      expect(await state.cursors.lookup("inbox")).toMatchObject({
        uidValidity: "17",
        lastSeenUid: 1,
      });
    });
    server.append(
      "From: trusted@example.com\r\nTo: reader@example.com\r\nSubject: New mail\r\nMessage-ID: <new@example.com>\r\n\r\nHello safely",
    );
    await vi.waitFor(() => expect(dispatchHookAgentTurn).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(dispatchHookAgentTurn).toHaveBeenCalledWith({
      name: "IMAP inbox",
      agentId: "mail_reader",
      sessionKey: "hook:imap:inbox:17:2",
      message: expect.stringContaining("Hello safely"),
      externalContentSource: "email",
      deliver: false,
      idempotencyKey: "hook:imap:inbox:17:2",
    });
    expect(server.commands.some((command) => /UID FETCH/u.test(command))).toBe(true);
    expect(server.commands.every((command) => !/STORE|BODY\[/u.test(command))).toBe(true);
    await vi.waitFor(async () =>
      expect(await state.cursors.lookup("inbox")).toMatchObject({ lastSeenUid: 2 }),
    );
    const previousFetches = server.commands.filter((command) => /UID FETCH/u.test(command)).length;
    server.disconnect();
    await vi.waitFor(
      () =>
        expect(server.commands.filter((command) => /UID FETCH/u.test(command))).toHaveLength(
          previousFetches + 1,
        ),
      { timeout: 5_000 },
    );
    expect(dispatchHookAgentTurn).toHaveBeenCalledTimes(1);
  });

  it("delivers mail that arrived during an IDLE connection interruption", async () => {
    const { server, state, dispatchHookAgentTurn } = await startWatcher();
    await vi.waitFor(async () =>
      expect(await state.cursors.lookup("inbox")).toMatchObject({ lastSeenUid: 1 }),
    );
    server.disconnect();
    server.messages.push({
      uid: 2,
      raw: "From: trusted@example.com\r\nSubject: During disconnect\r\n\r\nRecovered",
    });
    await vi.waitFor(() => expect(dispatchHookAgentTurn).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(server.connectionCount).toBe(2);
    expect(dispatchHookAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "hook:imap:inbox:17:2" }),
    );
  });

  it("coalesces a wakeup that arrives during an active sweep", async () => {
    const { server, state, dispatchHookAgentTurn } = await startWatcher();
    await vi.waitFor(async () =>
      expect(await state.cursors.lookup("inbox")).toMatchObject({ lastSeenUid: 1 }),
    );
    let releaseFetch = () => {};
    server.fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    server.append("From: trusted@example.com\r\nSubject: First\r\n\r\nHeld sweep");
    await vi.waitFor(() =>
      expect(server.commands.some((command) => /UID FETCH/u.test(command))).toBe(true),
    );
    server.append("From: trusted@example.com\r\nSubject: Second\r\n\r\nDuring sweep");
    server.fetchGate = undefined;
    releaseFetch();
    await vi.waitFor(() => expect(dispatchHookAgentTurn).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    expect(dispatchHookAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "hook:imap:inbox:17:3" }),
    );
  });

  it("re-baselines a rotated UIDVALIDITY without replaying existing mail", async () => {
    const { server, state, dispatchHookAgentTurn } = await startWatcher();
    await vi.waitFor(async () =>
      expect(await state.cursors.lookup("inbox")).toMatchObject({ uidValidity: "17" }),
    );
    server.uidValidity = "18";
    server.disconnect();
    server.messages.push({
      uid: 2,
      raw: "From: trusted@example.com\r\nSubject: Old validity\r\n\r\nNever replay",
    });
    await vi.waitFor(
      async () =>
        expect(await state.cursors.lookup("inbox")).toMatchObject({
          uidValidity: "18",
          lastSeenUid: 2,
        }),
      { timeout: 5_000 },
    );
    expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
  });

  it("polls when the IMAP server does not advertise IDLE", async () => {
    const { server, state, dispatchHookAgentTurn } = await startWatcher({
      supportsIdle: false,
      account: { watch: { mode: "auto", pollSeconds: 0.02 } },
    });
    await vi.waitFor(async () => expect(await state.cursors.lookup("inbox")).toBeDefined());
    server.messages.push({
      uid: 2,
      raw: "From: trusted@example.com\r\nSubject: Poll\r\n\r\nPolled",
    });
    await vi.waitFor(() => expect(dispatchHookAgentTurn).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    expect(server.commands.some((command) => command.includes(" IDLE"))).toBe(false);
  });

  it("stops an account after three authentication failures", async () => {
    const { server, context } = await startWatcher({ rejectAuthentication: true });
    await vi.waitFor(
      () => {
        expect(context.serviceHealth?.reportFailure).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("needs reauthentication") }),
        );
      },
      { timeout: 8_000 },
    );
    expect(server.connectionCount).toBe(3);
  });
});
