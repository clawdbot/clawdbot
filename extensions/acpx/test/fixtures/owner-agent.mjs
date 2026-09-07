#!/usr/bin/env node
// Synthetic ACP peer: persists its own conversation so restart tests must really load it.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const directory = process.argv[2];
const sessions = new Map();
const configOptions = (state) => [
  {
    id: "tone",
    name: "Tone",
    type: "select",
    currentValue: state.tone,
    options: [
      { value: "plain", name: "Plain" },
      { value: "brief", name: "Brief" },
    ],
  },
];
const describe = (state) => ({
  modes: {
    currentModeId: state.mode,
    availableModes: [
      { id: "normal", name: "Normal" },
      { id: "review", name: "Review" },
    ],
  },
  configOptions: configOptions(state),
});
const file = (id) => path.join(directory, `${id}.json`);
const save = (id) => fs.writeFile(file(id), JSON.stringify(sessions.get(id)));
const connection = new AgentSideConnection(
  (client) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
        authMethods: [],
      };
    },
    async newSession({ mcpServers }) {
      const sessionId = randomUUID();
      const state = {
        history: [],
        tone: "plain",
        mode: "normal",
        mcpServers,
        argv: process.argv.slice(3),
      };
      sessions.set(sessionId, state);
      await save(sessionId);
      return { sessionId, ...describe(state) };
    },
    async loadSession({ sessionId }) {
      const state = JSON.parse(await fs.readFile(file(sessionId), "utf8"));
      sessions.set(sessionId, state);
      return describe(state);
    },
    async setSessionMode({ sessionId, modeId }) {
      sessions.get(sessionId).mode = modeId;
      await save(sessionId);
      return {};
    },
    async setSessionConfigOption({ sessionId, configId, value }) {
      if (configId !== "tone") {
        throw new Error("unknown option");
      }
      const state = sessions.get(sessionId);
      state.tone = value;
      await save(sessionId);
      return { configOptions: configOptions(state) };
    },
    async prompt({ sessionId, prompt }) {
      const state = sessions.get(sessionId);
      state.history.push(
        prompt
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      );
      await save(sessionId);
      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ sessionId, ...state }) },
        },
      });
      return { stopReason: "end_turn" };
    },
    async closeSession({ sessionId }) {
      sessions.delete(sessionId);
      await fs.rm(file(sessionId), { force: true });
      return {};
    },
    async cancel() {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
void connection;
