import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramUserbotDriver, type TelegramUserbotUpdate } from "./userbot-driver.runtime.js";
import {
  flushTelegramTestBotUpdates,
  loadTelegramUserbotSkillRuntime,
} from "./userbot-skill.runtime.js";

const tempRoots: string[] = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-userbot-runtime-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Telegram userbot driver runtime", () => {
  it("keeps one process for commands and streamed updates", async () => {
    const scriptPath = path.join(tempRoot(), "fake-user-driver.py");
    fs.writeFileSync(
      scriptPath,
      [
        "import json",
        "import sys",
        "print(json.dumps({'type':'ready','chatId':-1001,'user':{'id':100}}), flush=True)",
        "for line in sys.stdin:",
        "    request = json.loads(line)",
        "    message_id = 10 + int(request['id'])",
        "    update = {'kind':'message','chatId':-1001,'messageId':message_id + 1,'senderId':200,'timestamp':1000,'text':'reply'}",
        "    print(json.dumps({'type':'update','update':update}), flush=True)",
        "    result = {'chatId':-1001,'messageId':message_id,'senderId':100,'timestamp':1000,'text':request['text']}",
        "    print(json.dumps({'type':'response','id':request['id'],'result':result}), flush=True)",
      ].join("\n"),
    );
    const updates: TelegramUserbotUpdate[] = [];
    const driver = await TelegramUserbotDriver.start({
      chatId: "-1001",
      driverEnv: {},
      userDriverPath: scriptPath,
      onUpdate(update) {
        updates.push(update);
      },
    });

    await expect(driver.send({ text: "hello" })).resolves.toMatchObject({
      messageId: 11,
      senderId: 100,
      text: "hello",
    });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ messageId: 12, senderId: 200, text: "reply" });
    expect(() => driver.assertHealthy()).not.toThrow();

    await driver.close();
  });

  it("drains every pending Test Bot API update", async () => {
    const bodies: unknown[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      bodies.push(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          result: bodies.length === 1 ? [{ update_id: 7 }] : [],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected server address");
    }
    try {
      await flushTelegramTestBotUpdates(`http://127.0.0.1:${address.port}`, "token");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(bodies).toEqual([
      { offset: 0, timeout: 0, allowed_updates: ["message", "edited_message"] },
      { offset: 8, timeout: 0, allowed_updates: ["message", "edited_message"] },
    ]);
  });

  it("loads the repository skill as the runtime source of truth", async () => {
    const runtime = await loadTelegramUserbotSkillRuntime({ repoRoot: process.cwd(), env: {} });

    expect(runtime.userDriverPath).toBe(
      path.join(
        process.cwd(),
        ".agents",
        "skills",
        "telegram-e2e-userbot",
        "scripts",
        "user-driver.py",
      ),
    );
    expect(() => runtime.parseCredential({})).toThrow("unsupported schema or environment");
    const stateRoot = runtime.createStateRoot();
    expect(fs.statSync(stateRoot).isDirectory()).toBe(true);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});
