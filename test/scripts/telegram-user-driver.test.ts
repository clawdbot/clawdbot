import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Telegram user driver reply matching", () => {
  it("matches an explicitly named SUT by username when its cached numeric id is stale", () => {
    const program = String.raw`
import argparse
import importlib.util
from pathlib import Path

path = Path("scripts/e2e/telegram-user-driver.py")
spec = importlib.util.spec_from_file_location("telegram_user_driver", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

driver = module.UserDriver.__new__(module.UserDriver)
driver.config = {"sutUsername": "foremanclawbot", "sutId": "7"}
driver.bot_config = {}
message = {
    "@type": "updateNewMessage",
    "message": {
        "id": 20,
        "chat_id": 10,
        "sender_id": {"@type": "messageSenderUser", "user_id": 42},
        "content": {
            "@type": "messageText",
            "text": {"@type": "formattedText", "text": "OPENCLAW_E2E_OK", "entities": []},
        },
    },
}
class Client:
    users = {42: {"username": "foremanclawbot"}}
    def __init__(self):
        self.updates = [message]
    def next_update(self, _timeout):
        return self.updates.pop(0) if self.updates else None
driver.client = Client()
args = argparse.Namespace(
    expect=["OPENCLAW_E2E_OK"],
    from_bot="@foremanclawbot",
    reply_to=None,
    thread_id=0,
    timeout_ms=10,
)
matched, _observed = driver.wait_for_message(10, args, 0)
raise SystemExit(0 if matched else 1)
`;
    const result = spawnSync("python3", ["-c", program], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts the exact later SUT response without native reply metadata by default", () => {
    const program = String.raw`
import argparse
import importlib.util
import sys
from pathlib import Path

path = Path("scripts/e2e/telegram-user-driver.py")
spec = importlib.util.spec_from_file_location("telegram_user_driver", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

module.load_config = lambda: ({"sutUsername": "foremanclawbot", "sutId": "7"}, {})
class Driver:
    def __init__(self, _config, _bot_config):
        pass
    def authorize(self, _args):
        pass
    def resolve_chat(self, _chat):
        return 10
    def send_text(self, _chat_id, _text, _reply_to):
        return {"id": 10, "chat_id": 10, "content": {"@type": "messageText"}}
    def wait_for_message(self, _chat_id, args, _after_message_id):
        if args.reply_to is not None:
            return None, []
        return {
            "messageId": 20,
            "senderUsername": "foremanclawbot",
            "text": "OPENCLAW_E2E_OK",
        }, []
module.UserDriver = Driver
sys.argv = [str(path), "probe", "--text", "test", "--expect", "OPENCLAW_E2E_OK"]
module.main()
`;
    const result = spawnSync("python3", ["-c", program], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
  });
});
