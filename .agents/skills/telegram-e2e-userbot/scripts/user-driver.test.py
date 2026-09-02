import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


DRIVER_PATH = Path(__file__).with_name("user-driver.py")
SPEC = importlib.util.spec_from_file_location("tg_user_driver_test_target", DRIVER_PATH)
driver = importlib.util.module_from_spec(SPEC)
sys.modules["tg_user_driver_test_target"] = driver
SPEC.loader.exec_module(driver)


class PhotoContentTest(unittest.TestCase):
    def test_rejects_unsafe_prebuilt_archive_members(self):
        class FakeTar:
            extracted = False

            def getmembers(self):
                return [driver.tarfile.TarInfo("../escape")]

            def extractall(self, _destination):
                self.extracted = True

        archive = FakeTar()
        with self.assertRaisesRegex(driver.DriverError, "unsafe member"):
            driver.extract_prebuilt_archive(archive, tempfile.mkdtemp())
        self.assertFalse(archive.extracted)

    def test_uses_current_tdlib_photo_shape(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {}
        instance.bot_config = {}
        with tempfile.NamedTemporaryFile(suffix=".jpg") as photo:
            content = instance.photo_content(photo.name, "caption")

        self.assertEqual(content["@type"], "inputMessagePhoto")
        self.assertEqual(content["photo"]["@type"], "inputPhoto")
        self.assertEqual(content["photo"]["photo"]["@type"], "inputFileLocal")
        self.assertEqual(content["show_caption_above_media"], False)
        self.assertIsNone(content["self_destruct_type"])
        self.assertEqual(content["has_spoiler"], False)
        self.assertNotIn("ttl", content)

    def test_uses_test_dc_for_test_session(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {
            "apiId": 123,
            "apiHash": "api-hash",
            "databaseEncryptionKey": "database-key",
            "testDc": True,
        }
        params = instance.td_params()
        self.assertEqual(params["parameters"]["use_test_dc"], True)
        current = instance.td_params_current()
        self.assertEqual(current["use_test_dc"], True)
        self.assertEqual(current["database_encryption_key"], "database-key")

    def test_refreshes_main_chat_list_for_a_new_numeric_chat(self):
        class FakeClient:
            def __init__(self):
                self.requests = []
                self.get_chat_calls = 0

            def request(self, payload, timeout=20):
                self.requests.append((payload, timeout))
                if payload["@type"] == "getChat":
                    self.get_chat_calls += 1
                    if self.get_chat_calls == 1:
                        raise driver.DriverError("getChat failed (400): Chat not found")
                    return {"id": -1001}
                return {"@type": "ok"}

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(instance.resolve_chat("-1001"), -1001)
        self.assertEqual(
            [payload["@type"] for payload, _timeout in instance.client.requests],
            ["getChat", "loadChats", "getChat"],
        )

    def test_marks_sut_mentions_and_commands_with_utf16_entities(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {"sutUsername": "sut_bot", "sutId": 101}
        instance.bot_config = {}
        formatted = instance.formatted_text("😀 @sut_bot hi /status@sut_bot")
        self.assertEqual(
            [entity["type"]["@type"] for entity in formatted["entities"]],
            ["textEntityTypeMention", "textEntityTypeBotCommand"],
        )
        self.assertEqual(formatted["entities"][0]["offset"], 3)
        self.assertEqual(formatted["entities"][0]["length"], 8)

    def test_normalizes_serve_messages_and_edits(self):
        known = {}
        message_id = 42 << 20
        text = "😀 a   b x"
        entities = [
            {"offset": 3, "length": 5, "type": {"@type": "textEntityTypeCode"}},
            {
                "offset": 9,
                "length": 1,
                "type": {"@type": "textEntityTypeTextUrl", "url": "https://example.com/qa"},
            },
        ]
        message = {
            "id": message_id,
            "chat_id": -1001,
            "sender_id": {"user_id": 101},
            "date": 123,
            "reply_to": {"message_id": 7},
            "content": {
                "@type": "messageText",
                "text": {"@type": "formattedText", "text": text, "entities": entities},
            },
        }
        users = {101: {"username": "sut_bot"}}
        created = driver.serve_update(
            {"@type": "updateNewMessage", "message": message}, users, known
        )
        self.assertEqual(created["kind"], "message")
        self.assertEqual(created["botApiMessageId"], 42)
        self.assertEqual(created["senderUsername"], "sut_bot")
        self.assertEqual(created["replyToMessageId"], 7)
        self.assertEqual(created["timestamp"], 123000)
        self.assertEqual(created["text"], text)
        self.assertEqual(created["entities"], entities)

        for edited_text, edited_entities in [
            (text, [{"offset": 3, "length": 5, "type": {"@type": "textEntityTypeBold"}}]),
            (text, []),
            ("final", [{"offset": 0, "length": 5, "type": {"@type": "textEntityTypePre"}}]),
        ]:
            with self.subTest(text=edited_text, entities=edited_entities):
                edited = driver.serve_update(
                    {
                        "@type": "updateMessageContent",
                        "chat_id": -1001,
                        "message_id": message_id,
                        "new_content": {
                            "@type": "messageText",
                            "text": {
                                "@type": "formattedText",
                                "text": edited_text,
                                "entities": edited_entities,
                            },
                        },
                    },
                    users,
                    known,
                )
                self.assertEqual(edited["kind"], "edit")
                self.assertEqual(edited["text"], edited_text)
                self.assertEqual(edited["entities"], edited_entities)
                self.assertEqual(edited["senderId"], 101)
                self.assertEqual(known[message_id]["entities"], edited_entities)

    def test_preserves_caption_entities_in_messages_and_edits(self):
        entities = [{"offset": 3, "length": 5, "type": {"@type": "textEntityTypeCode"}}]
        message = {
            "id": 43 << 20,
            "chat_id": -1001,
            "sender_id": {"user_id": 101},
            "date": 123,
            "content": {
                "@type": "messagePhoto",
                "caption": {"@type": "formattedText", "text": "😀 a   b", "entities": entities},
            },
        }
        known = {}
        created = driver.serve_update(
            {"@type": "updateNewMessage", "message": message}, {}, known
        )
        normalized = driver.normalize_message(message)
        self.assertEqual(created["text"], "😀 a   b")
        self.assertEqual(created["entities"], entities)
        self.assertEqual(normalized["entities"], entities)
        self.assertIs(normalized["raw"], message)
        edited = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "message_id": message["id"],
                "new_content": {
                    "@type": "messagePhoto",
                    "caption": {"@type": "formattedText", "text": "😀 a   b", "entities": []},
                },
            },
            {},
            known,
        )
        self.assertEqual(edited["text"], "😀 a   b")
        self.assertEqual(edited["entities"], [])

    def test_requires_explicit_entity_vectors_for_text_and_captions(self):
        for content_type, field in [("messageText", "text"), ("messagePhoto", "caption")]:
            for kind in ("message", "edit"):
                with self.subTest(content_type=content_type, kind=kind):
                    formatted = {"@type": "formattedText", "text": "plain", "entities": []}
                    content = {"@type": content_type, field: formatted}
                    message = {
                        "id": 44 << 20,
                        "chat_id": -1001,
                        "sender_id": {"user_id": 101},
                        "content": content,
                    }
                    known = {}
                    created = driver.serve_update(
                        {"@type": "updateNewMessage", "message": message}, {}, known
                    )
                    self.assertEqual(created["text"], "plain")
                    self.assertEqual(created["entities"], [])

                    del formatted["entities"]
                    update = (
                        {"@type": "updateNewMessage", "message": message}
                        if kind == "message"
                        else {
                            "@type": "updateMessageContent",
                            "chat_id": -1001,
                            "message_id": message["id"],
                            "new_content": content,
                        }
                    )
                    with self.assertRaisesRegex(KeyError, "entities"):
                        driver.serve_update(update, {}, known)
                    self.assertEqual(known[message["id"]]["entities"], [])

    def test_ignores_unknown_edit_in_serve_mode(self):
        event = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "chat_id": -1001,
                "message_id": 99,
                "new_content": {},
            },
            {},
            {},
        )

        self.assertIsNone(event)


if __name__ == "__main__":
    unittest.main()
