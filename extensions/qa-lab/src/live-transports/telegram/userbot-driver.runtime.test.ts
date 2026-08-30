import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramUserbotDriver, type TelegramUserbotUpdate } from "./userbot-driver.runtime.js";
import { loadTelegramUserbotSkillRuntime } from "./userbot-skill.runtime.js";

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
