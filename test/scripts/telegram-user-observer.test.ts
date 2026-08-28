import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const pythonTest = String.raw`
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

module_path = Path("scripts/e2e/telegram-user-driver.py").resolve()
spec = importlib.util.spec_from_file_location("telegram_user_driver", module_path)
module = importlib.util.module_from_spec(spec)
sys.modules["telegram_user_driver"] = module
spec.loader.exec_module(module)

class Client:
    def __init__(self):
        self.requests = []
        self.updates = []
    def next_update(self, timeout=0):
        return self.updates.pop(0) if self.updates else None
    def request(self, payload, timeout=20):
        self.requests.append(payload)
        return {"@type": "ok"}

class Driver:
    def __init__(self):
        self.client = Client()
    def send_text(self, chat_id, text, reply_to=None, thread_id=0, file_path=None):
        self.client.updates.append({
            "@type": "updateNewMessage",
            "message": {
                "id": 127 << 20,
                "chat_id": chat_id,
                "sender_id": {"@type": "messageSenderUser", "user_id": 99},
                "content": {"@type": "messageText", "text": {"text": "fast reply"}},
            },
        })
        return {
            "id": 124 << 20,
            "chat_id": chat_id,
            "is_outgoing": True,
            "sender_id": {"@type": "messageSenderUser", "user_id": 77},
            "content": {"@type": "messageText", "text": {"text": text}},
        }

with tempfile.TemporaryDirectory() as root:
    public = Path(root) / "public"
    private = Path(root) / "private"
    public.mkdir()
    private.mkdir()
    driver = Driver()
    observer = module.UserObserver(driver, -100123, 99, "qa_sut", private / "events.ndjson", public)
    (public / "proof.txt").write_text("visible media")
    staged_media = Path(observer.resolve_media("proof.txt"))
    staged_media_content = staged_media.read_text()
    staged_media_private = staged_media.parent.parent == private / "media"
    staged_media_name = staged_media.name
    (private / "credential.txt").write_text("do not upload")
    (public / "credential-link").symlink_to(private / "credential.txt")
    try:
        observer.resolve_media("credential-link")
        media_error = ""
    except module.DriverError as error:
        media_error = str(error)
    (public / "escape").symlink_to(private)
    try:
        observer.resolve_media("escape/credential.txt")
        directory_escape_error = ""
    except module.DriverError as error:
        directory_escape_error = str(error)
    observer.ingest({
        "@type": "updateNewMessage",
        "message": {
            "id": -123456,
            "chat_id": -100123,
            "is_outgoing": True,
            "sending_state": {"@type": "messageSendingStatePending"},
            "sender_id": {"@type": "messageSenderUser", "user_id": 77},
            "content": {"@type": "messageText", "text": {"text": "pending duplicate"}},
        },
    })
    observer.ingest({
        "@type": "updateNewMessage",
        "message": {
            "id": 123 << 20,
            "chat_id": -100123,
            "sender_id": {"@type": "messageSenderUser", "user_id": 99},
            "content": {"@type": "messageText", "text": {"text": "draft"}},
            "reply_markup": {
                "@type": "replyMarkupInlineKeyboard",
                "rows": [[{
                    "text": "Continue",
                    "type": {"@type": "inlineKeyboardButtonTypeCallback", "data": "opaque"},
                }]],
            },
        },
    })
    observer.ingest({
        "@type": "updateMessageContent",
        "chat_id": -100123,
        "message_id": 123 << 20,
        "new_content": {
            "@type": "messageRichMessage",
            "message": {"blocks": [{"@type": "richTextPlain", "text": "final"}]},
        },
    })
    observer.ingest({
        "@type": "updateChatAction",
        "chat_id": -100123,
        "sender_id": {"@type": "messageSenderUser", "user_id": 99},
        "action": {"@type": "chatActionTyping"},
    })
    observer.ingest({
        "@type": "updateMessageEdited",
        "chat_id": -100123,
        "message_id": 123 << 20,
        "edit_date": 1234,
        "reply_markup": {
            "@type": "replyMarkupInlineKeyboard",
            "rows": [[{
                "text": "Updated",
                "type": {"@type": "inlineKeyboardButtonTypeCallback", "data": "updated-opaque"},
            }]],
        },
    })
    observer.ingest({
        "@type": "updateNewMessage",
        "message": {
            "id": 125 << 20,
            "chat_id": -100123,
            "sender_id": {"@type": "messageSenderUser", "user_id": 1000},
            "content": {"@type": "messageText", "text": {"text": "private bystander text"}},
        },
    })
    sent = observer.call({"command": "send", "text": "@{sut} /stop"})
    pressed = observer.call({"command": "press", "messageId": "123", "button": 0})
    deleted = observer.call({"command": "delete", "messageId": "124"})
    try:
        observer.call({"command": "press", "messageId": "125", "button": 0})
        bystander_error = ""
    except module.DriverError as error:
        bystander_error = str(error)
    observer.ingest({
        "@type": "updateDeleteMessages",
        "chat_id": -100123,
        "message_ids": [123 << 20, 126 << 20],
        "is_permanent": True,
        "from_cache": False,
    })
    observer.MAX_EVENTS = len(observer.events)
    observer.ingest({
        "@type": "updateChatAction",
        "chat_id": -100123,
        "sender_id": {"@type": "messageSenderUser", "user_id": 99},
        "action": {"@type": "chatActionTyping"},
    })
    observer.close()
    socket_path = str(Path(root) / "observer.sock")
    pid_file = Path(root) / "observer.pid.json"
    terminate_args = type("Args", (), {"pid_file": str(pid_file), "socket": socket_path})()

    terminal = subprocess.Popen(
        [sys.executable, "-c", "pass", "telegram-user-driver", "serve", socket_path],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    pid_file.write_text(json.dumps({"pid": terminal.pid, "pgid": terminal.pid, "socket": socket_path}))
    pid_file.chmod(0o600)
    os.waitid(os.P_PID, terminal.pid, os.WEXITED | os.WNOWAIT)
    try:
        module.command_terminate_observer(terminate_args)
        terminal_marker_removed = not pid_file.exists()
        module.command_terminate_observer(terminate_args)
    finally:
        terminal.wait(timeout=10)
        pid_file.unlink(missing_ok=True)

    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import json, os, sys, time; "
            "marker = os.fdopen(os.open(sys.argv[1], os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w'); "
            "json.dump({'pid': os.getpid(), 'pgid': os.getpgrp(), 'socket': sys.argv[2]}, marker); "
            "marker.close(); print('ready', flush=True); time.sleep(60)",
            str(pid_file),
            socket_path,
            "telegram-user-driver",
            "serve",
        ],
        start_new_session=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        if child.stdout.readline() != "ready\n":
            raise AssertionError("The observer did not publish its owned marker.")
        owned_marker = json.loads(pid_file.read_text())
        pid_file.write_text(json.dumps({**owned_marker, "pid": os.getpid()}))
        try:
            module.command_terminate_observer(terminate_args)
            raise AssertionError("Cleanup signaled a process with a mismatched identity.")
        except module.DriverError as error:
            foreign_error = str(error)
        foreign_alive = child.poll() is None
        foreign_marker_retained = pid_file.exists()
        pid_file.write_text(json.dumps(owned_marker))
        module.command_terminate_observer(terminate_args)
        child.wait(timeout=10)
        module.command_terminate_observer(terminate_args)
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
        child.stdout.close()
    print(json.dumps({
        "bystanderError": bystander_error,
        "deleted": deleted,
        "directoryEscapeError": directory_escape_error,
        "documentContent": module.UserDriver.document_content(None, "/tmp/proof.txt", "proof"),
        "events": observer.events,
        "foreignAlive": foreign_alive,
        "foreignError": foreign_error,
        "foreignMarkerRetained": foreign_marker_retained,
        "mediaError": media_error,
        "pressed": pressed,
        "requests": driver.client.requests,
        "sent": sent,
        "stagedMediaContent": staged_media_content,
        "stagedMediaPrivate": staged_media_private,
        "stagedMediaName": staged_media_name,
        "truncated": observer.truncated,
        "terminalMarkerRemoved": terminal_marker_removed,
        "terminated": child.returncode is not None,
    }))
`;

describe("Telegram user observer", () => {
  it("records streaming, actions, and wipes without exposing bystanders", () => {
    const result = spawnSync("python3", ["-"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: pythonTest,
    });
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.events).toMatchObject([
      {
        actor: "bot",
        buttons: [{ index: 0, text: "Continue", type: "Callback" }],
        kind: "message",
        messageId: "123",
        text: "draft",
      },
      { actor: "bot", kind: "edit", messageId: "123", text: "final" },
      { actor: "bot", kind: "typing" },
      {
        actor: "bot",
        buttons: [{ index: 0, text: "Updated", type: "Callback" }],
        kind: "edit-meta",
      },
      { actor: "user", kind: "message", messageId: "124", text: "@qa_sut /stop" },
      { actor: "bot", kind: "message", messageId: "127", text: "fast reply" },
      { actor: "bot", isPermanent: true, kind: "delete", messageId: "123" },
    ]);
    expect(result.stdout).not.toContain("private bystander text");
    expect(result.stdout).not.toContain("pending duplicate");
    expect(value.truncated).toBe(true);
    expect(value.terminalMarkerRemoved).toBe(true);
    expect(value.terminated).toBe(true);
    expect(value.foreignAlive).toBe(true);
    expect(value.foreignMarkerRetained).toBe(true);
    expect(value.foreignError).toBe("Telegram observer process identity changed before cleanup.");
    expect(value.bystanderError).toBe("Message 125 was not observed in this session.");
    expect(value.mediaError).toBe(
      "Media must be a regular file inside the Mantis output directory.",
    );
    expect(value.directoryEscapeError).toBe(
      "Media must be a regular file inside the Mantis output directory.",
    );
    expect(value.documentContent).toEqual({
      "@type": "inputMessageDocument",
      caption: { "@type": "formattedText", entities: [], text: "proof" },
      disable_content_type_detection: false,
      document: { "@type": "inputFileLocal", path: "/tmp/proof.txt" },
      thumbnail: null,
    });
    expect(value.stagedMediaContent).toBe("visible media");
    expect(value.stagedMediaPrivate).toBe(true);
    expect(value.stagedMediaName).toBe("proof.txt");
    expect(value.sent.sent).toMatchObject({ actor: "user", messageId: "124" });
    expect(value.sent.events).toMatchObject([
      { actor: "user", messageId: "124" },
      { actor: "bot", messageId: "127", text: "fast reply" },
    ]);
    expect(value.requests).toContainEqual({
      "@type": "getCallbackQueryAnswer",
      chat_id: -100123,
      message_id: 123 << 20,
      payload: { "@type": "callbackQueryPayloadData", data: "updated-opaque" },
    });
    expect(value.requests).toContainEqual({
      "@type": "deleteMessages",
      chat_id: -100123,
      message_ids: [124 << 20],
      revoke: true,
    });
  });
});
