import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { ChannelAccountSnapshot } from "../../../../src/channels/plugins/types.core.js";
import { GatewayClientRequestError } from "../../../../src/gateway/client.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";

type Peer = { socket: Socket; nick: string; lines: string[]; sequence: number };

export async function proveHotReloadIrcAccounts({
  repoRoot,
  outputDir,
  appendLog,
}: {
  repoRoot: string;
  outputDir: string;
  appendLog: (text: string) => void;
}) {
  const owner = createQaGatewayChild();
  const peers: Peer[] = [];
  const evidence: Array<{ prefix: string; observation: string; bootId: string; pid: number }> = [];
  const failures: Array<{ prefix: string; message: string }> = [];
  const observations: Array<Record<string, unknown>> = [];
  let connection: HotReloadConnection | undefined;
  const server = createServer((socket) => {
    const peer: Peer = { socket, nick: "", lines: [], sequence: peers.length + 1 };
    peers.push(peer);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        peer.lines.push(line);
        if (line.startsWith("NICK ")) {
          peer.nick = line.slice(5);
        }
        if (line.startsWith("USER ")) {
          socket.write(`:qa-server 001 ${peer.nick} :welcome\r\n`);
        }
      }
    });
  });
  await runQaGatewayFixture(
    async () => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert(address && typeof address !== "string");
      const gateway = await owner.start({
        repoRoot,
        useRepoCli: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(repoRoot, "dist/index.js")],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        enabledPluginIds: ["irc"],
        providerMode: "mock-openai",
        forcedRuntime: "openclaw",
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerBaseUrl: "http://127.0.0.1:1/v1",
        transportBaseUrl: "http://127.0.0.1:1",
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          channels: {
            ...cfg.channels,
            irc: {
              host: "127.0.0.1",
              port: address.port,
              tls: false,
              accounts: {
                alpha: { nick: "qa-alpha", channels: ["#alpha"] },
                beta: { nick: "qa-beta", channels: ["#beta"] },
                parked: { nick: "qa-parked" },
              },
            },
          },
        }),
      });
      connection = await connectHotReloadClient(gateway);
      const primary = connection;
      const { pid } = gateway;
      const { bootId } = primary;
      assert(pid && bootId);
      const rpc = async <T>(method: string, params: unknown = {}): Promise<T> => {
        const request = () => primary.client.request<T>(method, params, { timeoutMs: 40_000 });
        try {
          return await request();
        } catch (error) {
          if (
            !(error instanceof GatewayClientRequestError) ||
            !error.retryable ||
            typeof error.retryAfterMs !== "number" ||
            !error.message.startsWith(`rate limit exceeded for ${method}`)
          ) {
            throw error;
          }
          await delay(error.retryAfterMs);
          return await request();
        }
      };
      const accounts = async () =>
        (
          await rpc<{ channelAccounts: Record<string, ChannelAccountSnapshot[]> }>(
            "channels.status",
            { probe: false },
          )
        ).channelAccounts.irc ?? [];
      const ready = async (id: string, nick: string, after = 0) =>
        await waitForHotReloadFact(`IRC ${id} ready as ${nick}`, async () => {
          const account = (await accounts()).find(
            (row) =>
              row.accountId === id &&
              row.running &&
              row.lifecycle === "ready" &&
              !row.restartPending,
          );
          const peer = peers.findLast(
            (row) => row.nick === nick && row.sequence > after && !row.socket.destroyed,
          );
          return account && peer ? peer : undefined;
        });
      const patch = async (change: unknown, replacePaths?: string[]) => {
        const { hash } = await rpc<{ hash: string }>("config.get");
        const result = await rpc<{
          sentinel: { payload: { stats: { requiresRestart: boolean } } };
        }>("config.patch", { baseHash: hash, raw: JSON.stringify(change), replacePaths });
        assert.equal(result.sentinel.payload.stats.requiresRestart, false);
      };
      let ping = 0;
      const witness = async (peer: Peer) => {
        assert.equal(peer.socket.destroyed, false);
        const marker = `qa-continuity-${++ping}`;
        peer.socket.write(`PING :${marker}\r\n`);
        await waitForHotReloadFact("same IRC socket PONG", () =>
          peer.lines.includes(`PONG :${marker}`) ? true : undefined,
        );
      };
      const record = async (prefix: string, observation: string) => {
        assert.equal((await rpc<{ pid: number }>("system.info")).pid, pid);
        assert.equal(primary.hellos, 1);
        assert.equal(primary.closes, 0);
        const fresh = await connectHotReloadClient(gateway);
        try {
          assert.equal(fresh.bootId, bootId);
        } finally {
          await fresh.client.stopAndWait();
        }
        const parked = (await accounts()).find((row) => row.accountId === "parked");
        assert(parked && parked.running === false && parked.lifecycle === "stopped");
        assert.equal(peers.filter((peer) => peer.nick === "qa-parked").length, 1);
        observations.push({
          prefix,
          parked,
          peers: peers.map(({ nick, sequence, lines, socket }) => ({
            nick,
            sequence,
            lines: [...lines],
            closed: socket.destroyed,
          })),
        });
        evidence.push({ prefix, observation, bootId, pid });
        appendLog(`PASS ${prefix}: ${observation}\n`);
      };
      try {
        let alpha = await ready("alpha", "qa-alpha");
        const beta = await ready("beta", "qa-beta");
        const parked = await ready("parked", "qa-parked");
        await rpc("channels.stop", { channel: "irc", accountId: "parked" });
        await waitForHotReloadFact("parked IRC socket closed", () =>
          parked.socket.destroyed ? true : undefined,
        );
        for (const [nick, channel] of [
          ["qa-alpha-next", "#next"],
          ["qa-alpha", "#alpha"],
        ] as const) {
          await patch(
            { channels: { irc: { accounts: { alpha: { nick, channels: [channel] } } } } },
            ["channels.irc.accounts.alpha.channels"],
          );
          const previous = alpha;
          alpha = await ready("alpha", nick, previous.sequence);
          await waitForHotReloadFact("old IRC socket retired", () =>
            previous.socket.destroyed ? true : undefined,
          );
          assert(alpha.lines.includes(`JOIN ${channel}`));
          await witness(beta);
        }
        await record(
          "channels.irc.accounts.edit",
          "Named account nick and JOIN settings changed A→B→A on new TCP connections; the sibling socket kept answering PING and the manually stopped account stayed stopped",
        );
        await patch({
          channels: { irc: { accounts: { gamma: { nick: "qa-gamma", channels: ["#gamma"] } } } },
        });
        const gamma = await ready("gamma", "qa-gamma");
        await witness(alpha);
        await witness(beta);
        await record(
          "channels.irc.accounts.add",
          "Adding a named account opened one new IRC socket while both existing account sockets and the Gateway connection remained live",
        );
        await patch({ channels: { irc: { accounts: { gamma: null } } } }, [
          "channels.irc.accounts.gamma.channels",
        ]);
        await ready("alpha", "qa-alpha", alpha.sequence);
        await ready("beta", "qa-beta", beta.sequence);
        await waitForHotReloadFact("removed IRC account disconnected", () =>
          gamma.socket.destroyed ? true : undefined,
        );
        assert(!(await accounts()).some((row) => row.accountId === "gamma"));
        await record(
          "channels.irc.accounts.remove",
          "Removing an account used the whole-channel restart boundary, disconnected the removed account, preserved the manual stop, and kept the Gateway boot and operator socket",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ prefix: "channels.irc.accounts", message });
        appendLog(`FAIL channels.irc.accounts: ${message}\n`);
      }
    },
    () => connection?.client.stopAndWait(),
    () => stopQaGatewayFixture(owner, { preserveToDir: path.join(outputDir, "irc-gateway") }),
    async () => {
      for (const peer of peers) {
        peer.socket.destroy();
      }
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
  return { evidence, failures, observations };
}
