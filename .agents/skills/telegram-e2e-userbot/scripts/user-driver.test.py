import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


DRIVER_PATH = Path(__file__).with_name("user-driver.py")
SPEC = importlib.util.spec_from_file_location("tg_user_driver_test_target", DRIVER_PATH)
driver = importlib.util.module_from_spec(SPEC)
sys.modules["tg_user_driver_test_target"] = driver
SPEC.loader.exec_module(driver)


class FakeTdlibClient:
    def __init__(self, responses):
        self.responses = responses
        self.requests = []

    def request(self, payload, timeout=20):
        self.requests.append((payload, timeout))
        response = self.responses.get(payload["@type"])
        if response is None:
            raise AssertionError(payload)
        return response(payload) if callable(response) else response


class PhotoContentTest(unittest.TestCase):
    def inspect_chat(self, chat, responses, chat_id=-1001):
        client = FakeTdlibClient({"getChat": chat, **responses})
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = client
        return instance.inspect_chat_writability(chat_id), client.requests

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

    def test_effective_group_writability(self):
        chat = {
            "type": {
                "@type": "chatTypeSupergroup",
                "supergroup_id": 7,
                "is_channel": False,
            },
            "permissions": {"can_send_basic_messages": True},
        }
        cases = [
            ("creator", {"@type": "chatMemberStatusCreator", "is_member": True}, True, None, True, True),
            ("detached creator", {"@type": "chatMemberStatusCreator", "is_member": False}, True, None, False, False),
            ("administrator", {"@type": "chatMemberStatusAdministrator"}, False, None, True, True),
            ("member", {"@type": "chatMemberStatusMember"}, True, None, True, True),
            (
                "paid member",
                {"@type": "chatMemberStatusMember"},
                True,
                {"outgoing_paid_message_star_count": 5},
                True,
                False,
            ),
            (
                "default restricted",
                {"@type": "chatMemberStatusMember"},
                False,
                {"my_boost_count": 0, "unrestrict_boost_count": 2},
                True,
                False,
            ),
            (
                "booster",
                {"@type": "chatMemberStatusMember"},
                False,
                {"my_boost_count": 2, "unrestrict_boost_count": 2},
                True,
                True,
            ),
            (
                "personally restricted",
                {
                    "@type": "chatMemberStatusRestricted",
                    "is_member": True,
                    "permissions": {"can_send_basic_messages": False},
                },
                True,
                None,
                True,
                False,
            ),
            ("left", {"@type": "chatMemberStatusLeft"}, True, None, False, False),
        ]

        for name, status, default_allowed, full_info, member, writable in cases:
            with self.subTest(name=name):
                chat["permissions"]["can_send_basic_messages"] = default_allowed
                responses = {"getSupergroup": {"status": status}}
                responses["getSupergroupFullInfo"] = {
                    "outgoing_paid_message_star_count": 0,
                    **(full_info or {}),
                }
                result, _requests = self.inspect_chat(chat, responses)
                self.assertEqual(
                    result,
                    driver.chat_writability(member=member, writable=writable),
                )

    def test_private_writability_uses_can_send_result(self):
        for name, permissions, result_type, writable in [
            (
                "allowed with group-style permission",
                {"can_send_basic_messages": True},
                "canSendMessageToUserResultOk",
                True,
            ),
            ("allowed without permissions", None, "canSendMessageToUserResultOk", True),
            (
                "allowed despite denied group-style permission",
                {"can_send_basic_messages": False},
                "canSendMessageToUserResultOk",
                True,
            ),
            (
                "paid messages",
                {"can_send_basic_messages": True},
                "canSendMessageToUserResultUserHasPaidMessages",
                False,
            ),
            (
                "deleted user",
                {"can_send_basic_messages": True},
                "canSendMessageToUserResultUserIsDeleted",
                False,
            ),
            (
                "restricted new chats",
                {"can_send_basic_messages": True},
                "canSendMessageToUserResultUserRestrictsNewChats",
                False,
            ),
        ]:
            with self.subTest(name=name):
                chat = {"type": {"@type": "chatTypePrivate", "user_id": 77}}
                if permissions is not None:
                    chat["permissions"] = permissions
                result, requests = self.inspect_chat(
                    chat,
                    {"canSendMessageToUser": {"@type": result_type}},
                    chat_id=42,
                )
                self.assertEqual(
                    result,
                    driver.chat_writability(member=True, writable=writable),
                )
                self.assertEqual(
                    [payload["@type"] for payload, _timeout in requests],
                    ["getChat", "canSendMessageToUser"],
                )

    def test_basic_group_and_channel_boundaries(self):
        basic, requests = self.inspect_chat(
            {
                "type": {"@type": "chatTypeBasicGroup", "basic_group_id": 7},
                "permissions": {"can_send_basic_messages": True},
            },
            {"getBasicGroup": {"status": {"@type": "chatMemberStatusMember"}}},
            chat_id=-7,
        )
        channel, channel_requests = self.inspect_chat(
            {
                "type": {
                    "@type": "chatTypeSupergroup",
                    "supergroup_id": 7,
                    "is_channel": True,
                },
                "permissions": {"can_send_basic_messages": True},
            },
            {},
        )
        self.assertEqual(basic, driver.chat_writability(member=True, writable=True))
        self.assertEqual(
            [payload["@type"] for payload, _timeout in requests],
            ["getChat", "getBasicGroup"],
        )
        self.assertEqual(channel, driver.chat_writability())
        self.assertEqual(len(channel_requests), 1)

    def test_status_preserves_chat_resolution_errors(self):
        class FakeClient:
            def request(self, payload, timeout=20):
                if payload["@type"] == "getMe":
                    return {"id": 123, "type": {"@type": "userTypeRegular"}}
                return {"value": "1.8.67"}

        class FakeDriver:
            client = FakeClient()

            def authorize(self, _args, need_ready=True):
                return True

            def resolve_chat(self, _chat):
                raise driver.DriverError("searchPublicChat failed (500): unavailable")

            def inspect_chat_writability(self, _chat_id):
                raise AssertionError("resolution must succeed before capability inspection")

        stdout = io.StringIO()
        with (
            mock.patch.object(driver, "load_config", return_value=({"testDc": True}, {})),
            mock.patch.object(driver, "UserDriver", return_value=FakeDriver()),
            mock.patch.object(driver, "save_tester_identity"),
            redirect_stdout(stdout),
            self.assertRaisesRegex(driver.DriverError, "unavailable"),
        ):
            driver.command_status(
                driver.argparse.Namespace(
                    timeout_ms=30_000,
                    chat="@unavailable",
                    json=True,
                    output="",
                )
            )
        self.assertEqual(stdout.getvalue(), "")

    def test_status_reports_resolved_unwritable_chat(self):
        class FakeClient:
            def request(self, payload, timeout=20):
                if payload["@type"] == "getMe":
                    return {"id": 123, "type": {"@type": "userTypeRegular"}}
                return {"value": "1.8.67"}

        class FakeDriver:
            client = FakeClient()

            def authorize(self, _args, need_ready=True):
                return True

            def resolve_chat(self, _chat):
                return -1001

            def inspect_chat_writability(self, chat_id):
                self.inspected = chat_id
                return driver.chat_writability(member=True)

        fake_driver = FakeDriver()
        stdout = io.StringIO()
        with (
            mock.patch.object(driver, "load_config", return_value=({"testDc": True}, {})),
            mock.patch.object(driver, "UserDriver", return_value=fake_driver),
            mock.patch.object(driver, "save_tester_identity"),
            redirect_stdout(stdout),
            self.assertRaises(SystemExit) as exit_context,
        ):
            driver.command_status(
                driver.argparse.Namespace(
                    timeout_ms=30_000,
                    chat="-1001",
                    json=True,
                    output="",
                )
            )
        self.assertEqual(exit_context.exception.code, 1)
        self.assertEqual(fake_driver.inspected, -1001)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["testerGroupMembership"], True)
        self.assertEqual(result["testerCanSendBasicMessages"], False)

    def test_command_serve_preflights_before_ready(self):
        events = []

        class FakeClient:
            users = {}

            def request(self, payload, timeout=20):
                return {"id": 123, "type": {"@type": "userTypeRegular"}}

            def next_update(self, timeout=0.1):
                return None

        class FakeDriver:
            client = FakeClient()

            def authorize(self, _args):
                events.append("authorize")

            def resolve_chat(self, _chat):
                events.append("resolve")
                return -1001

            def require_chat_writable(self, chat_id):
                events.append(("preflight", chat_id))
                raise driver.DriverError("tester chat is unwritable")

        with (
            mock.patch.object(driver, "load_config", return_value=({}, {})),
            mock.patch.object(driver, "UserDriver", return_value=FakeDriver()),
            mock.patch.object(driver, "write_ndjson") as write_ndjson,
            mock.patch.object(driver.select, "select", return_value=([sys.stdin], [], [])),
            mock.patch.object(driver.sys, "stdin", io.StringIO("")),
            self.assertRaisesRegex(driver.DriverError, "unwritable"),
        ):
            driver.command_serve(
                driver.argparse.Namespace(timeout_ms=30_000, chat="-1001")
            )

        self.assertEqual(events, ["authorize", "resolve", ("preflight", -1001)])
        write_ndjson.assert_not_called()

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
        self.assertEqual(created["contentType"], "messageText")
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
                self.assertEqual(edited["contentType"], "messageText")
                self.assertEqual(edited["text"], edited_text)
                self.assertEqual(edited["entities"], edited_entities)
                self.assertEqual(edited["senderId"], 101)
                self.assertEqual(known[message_id]["entities"], edited_entities)

    def test_preserves_native_content_type_and_caption_entities_in_messages_and_edits(self):
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
        self.assertEqual(created["contentType"], "messagePhoto")
        self.assertEqual(created["text"], "😀 a   b")
        self.assertEqual(created["entities"], entities)
        self.assertEqual(normalized["entities"], entities)
        self.assertIs(normalized["raw"], message)
        edited = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "message_id": message["id"],
                "new_content": {
                    "@type": "messageVideo",
                    "caption": {"@type": "formattedText", "text": "😀 a   b", "entities": []},
                },
            },
            {},
            known,
        )
        self.assertEqual(edited["contentType"], "messageVideo")
        self.assertEqual(known[message["id"]]["contentType"], "messageVideo")
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
