"""Offline TDLib adapter fixture exercising the canonical recorder main path."""
import importlib.util
import json
from pathlib import Path
import sys

source, root, prompt, reply = sys.argv[1:]
spec = importlib.util.spec_from_file_location("recorder", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(root)

class Clock:
    now = 1000.0
    def time(self):
        return self.now
    def sleep(self, seconds):
        self.now += seconds

# The offline adapter owns elapsed time; host scheduling must not consume the
# scenario before its first action. Keep the real recorder's deadline logic.
module.time = Clock()

class Client:
    users = {}
    pending = []
    def request(self, request, **kwargs):
        if request["@type"] == "getChat":
            return {"id": 42, "type": {"@type": "chatTypePrivate", "user_id": 42}}
        raise RuntimeError("Unexpected offline TDLib operation")
    def next_update(self, **kwargs):
        if self.pending:
            return self.pending.pop(0)
        module.time.sleep(0.001)
        return None

class Driver:
    client = Client()
    def resolve_chat(self, value):
        return 42
    def send_text(self, chat, text):
        if text != prompt:
            raise RuntimeError("Unexpected sent action")
        self.client.pending.append({"@type": "updateNewMessage", "message": {"id": 2 << 20, "chat_id": 42, "sender_id": {"@type": "messageSenderUser", "user_id": 42}, "is_outgoing": False, "content": {"@type": "messageText", "text": {"text": reply, "entities": []}}}})
        return {"id": 1 << 20}

module.build_driver = lambda: ({}, {}, Driver())
module.driver.resolve_sut = lambda *args: {"id": 42, "username": "fixture_sut"}
scenario = root / "scenario.json"
scenario.write_text(json.dumps({"actions": [{"type": "send", "atMs": 0, "text": prompt}]}))
sys.argv = [source, "--scenario", str(scenario), "--ready-file", str(root / "ready.json"), "--proof-dm-peer", "--seconds", "0.1", "--record", str(root / "events.ndjson"), "--output", str(root / "summary.json")]
module.main()
