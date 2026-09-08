import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


RECORD_PATH = Path(__file__).with_name("user-record.py")
SPEC = importlib.util.spec_from_file_location("tg_user_record", RECORD_PATH)
record = importlib.util.module_from_spec(SPEC)
sys.modules["tg_user_record"] = record
SPEC.loader.exec_module(record)


class FakeClient:
    def __init__(self):
        self.requests = []

    def request(self, payload, timeout=20):
        self.requests.append((payload, timeout))
        return {"@type": "callbackQueryAnswer", "text": ""}


class CallbackScenarioTest(unittest.TestCase):
    def test_records_partial_rich_revisions_raw_without_fetching_full_content(self):
        client = FakeClient()
        rich = {
            "@type": "richMessage", "is_full": False, "is_rtl": False,
            "blocks": [{"@type": "pageBlockParagraph", "text": {
                "@type": "richTextPlain", "text": "partial send",
            }}],
        }
        replacement = {
            **rich, "blocks": [{"@type": "pageBlockParagraph", "text": {
                "@type": "richTextPlain", "text": "partial edit",
            }}],
        }
        updates = [
            {"@type": "updateNewMessage", "message": {
                "id": 42 << 20, "chat_id": -1001,
                "sender_id": {"@type": "messageSenderUser", "user_id": 42},
                "content": {"@type": "messageRichMessage", "message": rich},
            }},
            {"@type": "updateMessageContent", "chat_id": -1001,
             "message_id": 42 << 20,
             "new_content": {"@type": "messageRichMessage", "message": replacement}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "events.jsonl"
            recorder = record.EventRecorder(client, -1001, target, 42)
            try:
                for update in updates:
                    recorder.ingest(update)
            finally:
                recorder.close()
            events = [json.loads(line) for line in target.read_text().splitlines()]
        self.assertEqual([event["kind"] for event in events], ["message", "edit"])
        self.assertEqual([event["text"] for event in events], ["partial send", "partial edit"])
        self.assertEqual([event["richMessageIsFull"] for event in events], [False, False])
        self.assertEqual([event["raw"] for event in events], updates)
        self.assertEqual(client.requests, [])

    def test_waits_for_prior_gateway_barriers(self):
        actions = [
            {"type": "patchConfig", "atMs": 0},
            {"type": "send", "atMs": 0, "text": "after patch"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(record.scenario_barriers_ready(actions, 1, directory))
            (Path(directory) / "0").touch()
            self.assertTrue(record.scenario_barriers_ready(actions, 1, directory))

    def test_publishes_atomic_recorder_ready_artifact(self):
        recorder = record.EventRecorder(FakeClient(), -1001, "", 42)
        recorder.started_at = 1_786_900_000.125
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "ready.json"
            record.publish_recorder_ready(target, recorder)
            self.assertEqual(
                json.loads(target.read_text()),
                {
                    "schemaVersion": 1,
                    "startedAtUnixMs": 1_786_900_000_125,
                    "chatId": -1001,
                },
            )
            self.assertEqual(list(target.parent.glob(".*.tmp")), [])

    def test_ignores_cached_messages_from_before_recording_window(self):
        recorder = record.EventRecorder(FakeClient(), -1001, "", 42)
        recorder.started_at = 200
        recorder.ingest(
            {
                "@type": "updateNewMessage",
                "message": {
                    "id": 1048576,
                    "chat_id": -1001,
                    "date": 100,
                    "sender_id": {"@type": "messageSenderUser", "user_id": 42},
                    "content": {
                        "@type": "messageText",
                        "text": {"@type": "formattedText", "text": "cached"},
                    },
                },
            }
        )

        self.assertEqual(recorder.events, [])
        self.assertEqual(recorder.messages, {})

    def test_finds_and_clicks_sut_callback_button(self):
        client = FakeClient()
        recorder = record.EventRecorder(client, -1001, "", 42)
        recorder.ingest(
            {
                "@type": "updateNewMessage",
                "message": {
                    "id": 1048576,
                    "chat_id": -1001,
                    "sender_id": {"@type": "messageSenderUser", "user_id": 42},
                    "content": {
                        "@type": "messageText",
                        "text": {"@type": "formattedText", "text": "Select a provider:"},
                    },
                    "reply_markup": {
                        "@type": "replyMarkupInlineKeyboard",
                        "rows": [
                            [
                                {
                                    "text": "OpenAI",
                                    "type": {
                                        "@type": "inlineKeyboardButtonTypeCallback",
                                        "data": "bW9kZWxzX3Byb3ZpZGVyX29wZW5haQ==",
                                    },
                                }
                            ]
                        ],
                    },
                },
            }
        )

        found = recorder.find_callback_button("Select a provider", "OpenAI")
        self.assertEqual(found, (1048576, "bW9kZWxzX3Byb3ZpZGVyX29wZW5haQ=="))
        recorder.click_callback_button(*found, timeout_ms=3_000)
        self.assertEqual(
            client.requests,
            [
                (
                    {
                        "@type": "getCallbackQueryAnswer",
                        "chat_id": -1001,
                        "message_id": 1048576,
                        "payload": {
                            "@type": "callbackQueryPayloadData",
                            "data": "bW9kZWxzX3Byb3ZpZGVyX29wZW5haQ==",
                        },
                    },
                    3.0,
                )
            ],
        )


if __name__ == "__main__":
    unittest.main()
