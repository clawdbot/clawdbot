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
  it("keeps one process for commands and streamed formatting edits", async () => {
    const scriptPath = path.join(tempRoot(), "fake-user-driver.py");
    const text = "😀 a   b x";
    const entities = [
      { offset: 3, length: 5, type: { "@type": "textEntityTypeCode" } },
      {
        offset: 9,
        length: 1,
        type: { "@type": "textEntityTypeTextUrl", url: "https://example.com/qa" },
      },
    ];
    const editedEntities = [{ offset: 3, length: 5, type: { "@type": "textEntityTypeBold" } }];
    fs.writeFileSync(
      scriptPath,
      [
        "import json",
        "import sys",
        `entities = json.loads(${JSON.stringify(JSON.stringify(entities))})`,
        `edited_entities = json.loads(${JSON.stringify(JSON.stringify(editedEntities))})`,
        "print(json.dumps({'type':'ready','chatId':-1001,'user':{'id':100}}), flush=True)",
        "for line in sys.stdin:",
        "    request = json.loads(line)",
        "    message_id = 10 + int(request['id'])",
        "    update = {'kind':'message','chatId':-1001,'messageId':message_id + 1,'senderId':200,'timestamp':1000,'text':request['text'],'entities':entities,'contentType':'messagePhoto'}",
        "    print(json.dumps({'type':'update','update':update}), flush=True)",
        "    for replacement in [edited_entities, []]:",
        "        update = {**update, 'kind':'edit', 'entities':replacement, 'contentType':'messageVideo'}",
        "        print(json.dumps({'type':'update','update':update}), flush=True)",
        "    result = {'chatId':-1001,'messageId':message_id,'senderId':100,'timestamp':1000,'text':request['text'],'entities':entities,'contentType':'messageText'}",
        "    print(json.dumps({'type':'response','id':request['id'],'result':result}), flush=True)",
      ].join("\n"),
    );
    const updates: TelegramUserbotUpdate[] = [];
    const leaseFailure = new Promise<Error>(() => {});
    const driver = await TelegramUserbotDriver.start({
      chatId: "-1001",
      driverEnv: {},
      leaseHealth: { assertHealthy() {}, whenUnhealthy: leaseFailure },
      userDriverPath: scriptPath,
      onUpdate(update) {
        updates.push(update);
      },
    });
    expect(driver.chatId).toBe(-1001);
    try {
      await expect(driver.send({ text })).resolves.toMatchObject({
        messageId: 11,
        senderId: 100,
        contentType: "messageText",
        text,
        entities,
      });
      await vi.waitFor(() => expect(updates).toHaveLength(3));
      expect(updates).toMatchObject([
        {
          kind: "message",
          messageId: 12,
          senderId: 200,
          contentType: "messagePhoto",
          text,
          entities,
        },
        {
          kind: "edit",
          messageId: 12,
          contentType: "messageVideo",
          text,
          entities: editedEntities,
        },
        { kind: "edit", messageId: 12, contentType: "messageVideo", text, entities: [] },
      ]);
      expect(() => driver.assertHealthy()).not.toThrow();
    } finally {
      await driver.close();
    }
  });

  it.each([
    { name: "missing entities", entities: undefined, streamed: false },
    { name: "non-array entities", entities: {}, streamed: false },
    { name: "non-object entity", entities: [null], streamed: false },
    {
      name: "negative offset",
      entities: [{ offset: -1, length: 1, type: { "@type": "textEntityTypeCode" } }],
      streamed: false,
    },
    {
      name: "fractional length",
      entities: [{ offset: 3, length: 1.5, type: { "@type": "textEntityTypeCode" } }],
      streamed: false,
    },
    {
      name: "empty range",
      entities: [{ offset: 3, length: 0, type: { "@type": "textEntityTypeCode" } }],
      streamed: false,
    },
    {
      name: "range past the text",
      entities: [{ offset: 3, length: 8, type: { "@type": "textEntityTypeCode" } }],
      streamed: true,
    },
    {
      name: "start inside a surrogate pair",
      entities: [{ offset: 1, length: 1, type: { "@type": "textEntityTypeCode" } }],
      streamed: true,
    },
    {
      name: "end inside a surrogate pair",
      entities: [{ offset: 0, length: 1, type: { "@type": "textEntityTypeCode" } }],
      streamed: false,
    },
    {
      name: "missing entity type",
      entities: [{ offset: 3, length: 1, type: {} }],
      streamed: true,
    },
  ])("rejects $name at the child protocol boundary", async ({ entities, streamed }) => {
    const scriptPath = path.join(tempRoot(), "invalid-entity-driver.py");
    const message = {
      chatId: -1001,
      messageId: 11,
      senderId: 100,
      timestamp: 1000,
      text: "😀 a   b x",
      entities,
    };
    fs.writeFileSync(
      scriptPath,
      [
        "import json",
        "import sys",
        `result = json.loads(${JSON.stringify(JSON.stringify(message))})`,
        "print(json.dumps({'type':'ready','chatId':-1001,'user':{'id':100}}), flush=True)",
        "for line in sys.stdin:",
        "    request = json.loads(line)",
        ...(streamed
          ? [
              "    print(json.dumps({'type':'update','update':{**result, 'kind':'message'}}), flush=True)",
              "    result = {**result, 'entities':[]}",
            ]
          : []),
        "    print(json.dumps({'type':'response','id':request['id'],'result':result}), flush=True)",
      ].join("\n"),
    );
    const onUpdate = vi.fn();
    const driver = await TelegramUserbotDriver.start({
      chatId: "-1001",
      driverEnv: {},
      leaseHealth: { assertHealthy() {}, whenUnhealthy: new Promise<Error>(() => {}) },
      userDriverPath: scriptPath,
      onUpdate,
    });
    try {
      await expect(driver.send({ text: message.text })).rejects.toThrow(/invalid entit/u);
      expect(onUpdate).not.toHaveBeenCalled();
    } finally {
      await driver.close();
    }
  });

  it("stops a delayed TDLib send before its final effect after lease loss", async () => {
    const root = tempRoot();
    const markerPath = path.join(root, "sent.txt");
    const scriptPath = path.join(root, "delayed-user-driver.py");
    fs.writeFileSync(
      scriptPath,
      [
        "import json",
        "import pathlib",
        "import sys",
        "import time",
        "print(json.dumps({'type':'ready','chatId':-1001,'user':{'id':100}}), flush=True)",
        "for line in sys.stdin:",
        "    request = json.loads(line)",
        "    time.sleep(1)",
        `    pathlib.Path(${JSON.stringify(markerPath)}).write_text('sent')`,
      ].join("\n"),
    );
    let revoke: (error: Error) => void = () => {};
    const whenUnhealthy = new Promise<Error>((resolve) => {
      revoke = resolve;
    });
    const driver = await TelegramUserbotDriver.start({
      chatId: "-1001",
      driverEnv: {},
      leaseHealth: { assertHealthy() {}, whenUnhealthy },
      userDriverPath: scriptPath,
      onUpdate() {},
    });

    const sending = driver.send({ text: "must not send" });
    revoke(new Error("lease revoked"));

    await expect(sending).rejects.toThrow("lease revoked");
    await new Promise((resolve) => {
      setTimeout(resolve, 1_100);
    });
    expect(fs.existsSync(markerPath)).toBe(false);
    await driver.close();
  });

  it("loads the selected repository skill from a different working directory", async () => {
    const repoRoot = tempRoot();
    const skillPath = path.join(repoRoot, ".agents", "skills", "telegram-e2e-userbot");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.cpSync(path.join(process.cwd(), ".agents", "skills", "telegram-e2e-userbot"), skillPath, {
      recursive: true,
    });
    const runtime = await loadTelegramUserbotSkillRuntime({ repoRoot, env: {} });

    expect(runtime.userDriverPath).toBe(
      path.join(repoRoot, ".agents", "skills", "telegram-e2e-userbot", "scripts", "user-driver.py"),
    );
    expect(() => runtime.parseCredential({})).toThrow("unsupported schema or environment");
    const stateRoot = runtime.createStateRoot();
    expect(fs.statSync(stateRoot).isDirectory()).toBe(true);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});
