import importlib.util
import io
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


DRIVER_PATH = Path(__file__).with_name("user-driver.py")
SPEC = importlib.util.spec_from_file_location("tg_user_driver_test_target", DRIVER_PATH)
driver = importlib.util.module_from_spec(SPEC)
sys.modules["tg_user_driver_test_target"] = driver
SPEC.loader.exec_module(driver)


def observation_client(users=None):
    return SimpleNamespace(
        users=users or {},
        request=Mock(side_effect=AssertionError("unexpected TDLib request")),
    )


def rich_content(text, full=True):
    return {
        "@type": "messageRichMessage",
        "message": {
            "@type": "richMessage", "is_full": full, "is_rtl": False,
            "blocks": [{"@type": "pageBlockParagraph", "text": {
                "@type": "richTextPlain", "text": text,
            }}],
        },
    }


def native_message(content, chat_id=-1001, message_id=42 << 20, sender_id=101):
    return {
        "id": message_id, "chat_id": chat_id, "sender_id": {"user_id": sender_id},
        "date": 123, "reply_to": {"message_id": 7}, "content": content,
    }


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
            driver.extract_prebuilt_archive(archive, tempfile.gettempdir())
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
        client = observation_client({101: {"username": "sut_bot"}})
        created = driver.serve_update(
            {"@type": "updateNewMessage", "message": message}, client, known
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
                    client,
                    known,
                )
                self.assertEqual(edited["kind"], "edit")
                self.assertEqual(edited["contentType"], "messageText")
                self.assertEqual(edited["text"], edited_text)
                self.assertEqual(edited["entities"], edited_entities)
                self.assertEqual(edited["senderId"], 101)
                self.assertEqual(known[(-1001, message_id)]["entities"], edited_entities)

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
        client = observation_client()
        created = driver.serve_update(
            {"@type": "updateNewMessage", "message": message}, client, known
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
                "chat_id": -1001,
                "message_id": message["id"],
                "new_content": {
                    "@type": "messageVideo",
                    "caption": {"@type": "formattedText", "text": "😀 a   b", "entities": []},
                },
            },
            client,
            known,
        )
        self.assertEqual(edited["contentType"], "messageVideo")
        self.assertEqual(known[(-1001, message["id"])]["contentType"], "messageVideo")
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
                    client = observation_client()
                    created = driver.serve_update(
                        {"@type": "updateNewMessage", "message": message}, client, known
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
                        driver.serve_update(update, client, known)
                    self.assertEqual(known[(-1001, message["id"])]["entities"], [])

    def test_ignores_unknown_edit_in_serve_mode(self):
        event = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "chat_id": -1001,
                "message_id": 99,
                "new_content": {},
            },
            observation_client(),
            {},
        )

        self.assertIsNone(event)

    def test_preserves_rich_tree_revisions_and_clears_it_on_plain_replacement(self):
        known = {}
        client = observation_client()
        message_id = 45 << 20
        rich = {
            "@type": "richMessage", "is_full": True, "is_rtl": False,
            "blocks": [{"@type": "pageBlockParagraph", "text": {
                "@type": "richTextUrl", "url": "https://example.com/qa", "is_cached": False,
                "text": {"@type": "richTextSpoiler", "text": {
                    "@type": "richTextMathematicalExpression", "expression": "x",
                }},
            }}],
        }
        content = {"@type": "messageRichMessage", "message": rich}
        created = driver.serve_update({"@type": "updateNewMessage", "message": {
            "id": message_id, "chat_id": -1001, "sender_id": {"user_id": 101},
            "content": content,
        }}, client, known)
        self.assertEqual(created["richMessage"], rich)
        self.assertEqual(created["text"], "x")
        self.assertEqual(created["entities"], [])
        replacement = {**rich, "blocks": [{
            "@type": "pageBlockParagraph", "text": {
                "@type": "richTextCustomEmoji", "custom_emoji_id": "5368324170671202286",
                "alternative_text": "😀",
            },
        }]}
        for next_content, expected_text, expected_rich in [
            ({"@type": "messageRichMessage", "message": replacement}, "😀", replacement),
            ({"@type": "messageText", "text": {"text": "final", "entities": []}}, "final", None),
            ({"@type": "messageUnsupported"}, "", None),
        ]:
            with self.subTest(content_type=next_content["@type"]):
                edited = driver.serve_update({
                    "@type": "updateMessageContent", "chat_id": -1001,
                    "message_id": message_id,
                    "new_content": next_content,
                }, client, known)
                self.assertEqual(edited["richMessage"], expected_rich)
                self.assertEqual(edited["text"], expected_text)
                self.assertEqual(edited["botApiMessageId"], 45)
                self.assertEqual(known[(-1001, message_id)]["richMessage"], expected_rich)


class RichObservationTest(unittest.TestCase):
    def test_serve_hydrates_selected_chat_messages_and_edits_before_emitting(self):
        partial = rich_content("preview", full=False)
        plain = {"@type": "messageText", "text": {"text": "plain replacement", "entities": []}}
        updates = [
            {"@type": "updateNewMessage", "message": native_message(partial, chat_id=-2002)},
            {"@type": "updateNewMessage", "message": native_message(partial)},
            {"@type": "updateMessageContent", "chat_id": -1001,
             "message_id": 42 << 20, "new_content": partial},
            {"@type": "updateMessageContent", "chat_id": -1001,
             "message_id": 42 << 20, "new_content": plain},
        ]
        raw_updates = deepcopy(updates)
        pending = list(updates)
        full = [rich_content(text)["message"] for text in ("full send", "full edit")]
        client = observation_client({101: {"username": "sut_bot"}})
        responses = iter(full)

        def request(payload, timeout=20):
            if payload["@type"] == "getMe":
                return {"id": 303}
            self.assertEqual(payload, {
                "@type": "getFullRichMessage", "chat_id": -1001, "message_id": 42 << 20,
            })
            return next(responses)

        client.request.side_effect = request
        client.next_update = lambda timeout: pending.pop(0) if pending else None
        instance = SimpleNamespace(
            client=client, authorize=lambda *_: None, resolve_chat=lambda *_: -1001,
            check_group_write_access=Mock(return_value=True),
        )
        events = []
        with patch.object(driver, "load_config", return_value=({}, {})), \
                patch.object(driver, "UserDriver", return_value=instance), \
                patch.object(driver, "write_ndjson", side_effect=events.append), \
                patch.object(driver.sys, "stdin", io.StringIO("")), \
                patch.object(driver.select, "select", side_effect=lambda *_: (
                    [] if pending else [driver.sys.stdin], [], []
                )):
            driver.command_serve(SimpleNamespace(chat="-1001", timeout_ms=1000))

        observed = [event["update"] for event in events if event["type"] == "update"]
        self.assertEqual([event["kind"] for event in observed], ["message", "edit", "edit"])
        self.assertEqual([event["text"] for event in observed], ["full send", "full edit", "plain replacement"])
        self.assertEqual([event["richMessage"] for event in observed], [*full, None])
        for event in observed:
            self.assertEqual((event["chatId"], event["messageId"], event["senderId"]), (-1001, 42 << 20, 101))
            self.assertEqual(event["senderUsername"], "sut_bot")
            self.assertEqual(event["replyToMessageId"], 7)
        self.assertEqual([call.args[0]["@type"] for call in client.request.call_args_list],
                         ["getMe", "getFullRichMessage", "getFullRichMessage"])
        self.assertEqual(updates, raw_updates)

    def test_same_message_id_in_different_chats_keeps_its_own_edit_and_fetch(self):
        client = observation_client()
        known = {}
        for chat_id, sender_id in [(-1001, 101), (-2002, 202)]:
            driver.serve_update({
                "@type": "updateNewMessage",
                "message": native_message(rich_content(str(chat_id)), chat_id=chat_id, sender_id=sender_id),
            }, client, known)
        other = deepcopy(known[(-2002, 42 << 20)])
        full = rich_content("updated first chat")["message"]
        client.request.side_effect = None
        client.request.return_value = full
        edited = driver.serve_update({
            "@type": "updateMessageContent", "chat_id": -1001, "message_id": 42 << 20,
            "new_content": rich_content("preview", full=False),
        }, client, known)

        client.request.assert_called_once_with({
            "@type": "getFullRichMessage", "chat_id": -1001, "message_id": 42 << 20,
        })
        self.assertEqual((edited["kind"], edited["chatId"], edited["senderId"]), ("edit", -1001, 101))
        self.assertEqual(edited["richMessage"], full)
        self.assertEqual(known[(-1001, 42 << 20)]["text"], "updated first chat")
        self.assertEqual(known[(-2002, 42 << 20)], other)

    def test_failed_or_incomplete_fetch_does_not_commit_a_partial_observation(self):
        for kind in ("message", "edit"):
            for outcome in ("request-error", "incomplete", "wrong-type"):
                with self.subTest(kind=kind, outcome=outcome):
                    client = observation_client()
                    known = {}
                    if kind == "edit":
                        driver.serve_update({"@type": "updateNewMessage", "message": native_message(
                            rich_content("previous complete content"),
                        )}, client, known)
                    before = deepcopy(known)
                    if outcome == "request-error":
                        client.request.side_effect = driver.DriverError("synthetic lookup failure")
                    else:
                        client.request.side_effect = None
                        client.request.return_value = (
                            rich_content("still partial", full=False)["message"]
                            if outcome == "incomplete" else {"@type": "ok"}
                        )
                    partial = rich_content("preview", full=False)
                    update = (
                        {"@type": "updateNewMessage", "message": native_message(partial)}
                        if kind == "message" else {
                            "@type": "updateMessageContent", "chat_id": -1001,
                            "message_id": 42 << 20, "new_content": partial,
                        }
                    )
                    with self.assertRaises(driver.DriverError):
                        driver.serve_update(update, client, known)
                    self.assertEqual(known, before)
                    self.assertFalse(partial["message"]["is_full"])

    def test_full_fetch_preserves_native_update_fifo_on_success_and_failure(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                client = driver.TdClient.__new__(driver.TdClient)
                client.users = {}
                earlier = {"@type": "updateChatAction", "chat_id": -1001}
                other = {"@type": "updateNewMessage", "message": native_message(
                    rich_content("other chat"), chat_id=-2002, sender_id=202,
                )}
                later = {
                    "@type": "updateMessageContent", "chat_id": -1001,
                    "message_id": 42 << 20, "new_content": {
                        "@type": "messageText", "text": {"text": "later plain edit", "entities": []},
                    },
                }
                client.updates = [earlier]
                client.send = Mock(return_value="full-request")
                response = (
                    {"@type": "error", "code": 400, "message": "synthetic lookup failure"}
                    if failed else rich_content("fetched snapshot")["message"]
                )
                client.receive = Mock(side_effect=[other, later, {**response, "@extra": "full-request"}])
                known = {}
                driver.serve_update({"@type": "updateNewMessage", "message": native_message(
                    rich_content("original"),
                )}, client, known)
                partial_edit = {
                    "@type": "updateMessageContent", "chat_id": -1001,
                    "message_id": 42 << 20, "new_content": rich_content("preview", full=False),
                }
                if failed:
                    with self.assertRaisesRegex(driver.DriverError, "synthetic lookup failure"):
                        driver.serve_update(partial_edit, client, known)
                    self.assertEqual(known[(-1001, 42 << 20)]["text"], "original")
                else:
                    event = driver.serve_update(partial_edit, client, known)
                    self.assertEqual((event["kind"], event["text"]), ("edit", "fetched snapshot"))
                client.send.assert_called_once_with({
                    "@type": "getFullRichMessage", "chat_id": -1001, "message_id": 42 << 20,
                })
                for expected in (earlier, other, later):
                    update = client.next_update()
                    self.assertIs(update, expected)
                    driver.serve_update(update, client, known)
                self.assertEqual(client.updates, [])
                self.assertEqual(known[(-1001, 42 << 20)]["text"], "later plain edit")
                self.assertIsNone(known[(-1001, 42 << 20)]["richMessage"])
                self.assertEqual(known[(-2002, 42 << 20)]["senderId"], 202)


class GroupWriteAccessTest(unittest.TestCase):
    def make_driver(self, status, default=True, boosts=None, kind="chatTypeSupergroup", active=True):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        requests = []
        class Client:
            users = {}

            def next_update(self, timeout):
                return None

            def request(self, payload, timeout=20):
                requests.append(payload)
                return {
                    "getChat": {"type": {"@type": kind, "supergroup_id": 1, "basic_group_id": 1, "is_channel": False}, "permissions": {"can_send_basic_messages": default}},
                    "getChatMember": {"status": status},
                    "getSupergroupFullInfo": boosts or {},
                    "getBasicGroup": {"is_active": active},
                    "getMe": {"id": 123},
                }[payload["@type"]]
        instance.client = Client()
        return instance, requests

    def test_effective_group_text_permissions(self):
        cases = [
            ({"@type": "chatMemberStatusMember"}, True, None, True),
            ({"@type": "chatMemberStatusMember"}, False, None, False),
            ({"@type": "chatMemberStatusMember"}, None, None, False),
            ({"@type": "chatMemberStatusLeft"}, True, None, False),
            ({"@type": "chatMemberStatusBanned"}, True, None, False),
            ({"@type": "chatMemberStatusCreator", "is_member": False}, True, None, False),
            ({"@type": "chatMemberStatusCreator", "is_member": True}, False, None, True),
            ({"@type": "chatMemberStatusAdministrator"}, False, None, True),
            ({"@type": "chatMemberStatusRestricted", "is_member": False, "permissions": {"can_send_basic_messages": True}}, True, None, False),
            ({"@type": "chatMemberStatusRestricted", "is_member": True, "permissions": {}}, True, None, False),
            ({"@type": "chatMemberStatusRestricted", "is_member": True, "permissions": {"can_send_basic_messages": False}}, True, None, False),
            ({"@type": "chatMemberStatusRestricted", "is_member": True, "permissions": {"can_send_basic_messages": True}}, True, None, True),
            ({"@type": "chatMemberStatusRestricted", "is_member": True, "permissions": {"can_send_basic_messages": True}}, False, None, False),
            ({"@type": "chatMemberStatusMember"}, False, {"unrestrict_boost_count": 2, "my_boost_count": 2}, True),
            ({"@type": "chatMemberStatusMember"}, False, {"unrestrict_boost_count": 2, "my_boost_count": 1}, False),
            ({"@type": "chatMemberStatusMember"}, False, {"unrestrict_boost_count": 0, "my_boost_count": 0}, False),
        ]
        for status, default, boosts, allowed in cases:
            with self.subTest(status=status, default=default, boosts=boosts):
                instance, requests = self.make_driver(status, default, boosts)
                if allowed:
                    self.assertTrue(instance.check_group_write_access(-1001, 123))
                else:
                    with self.assertRaisesRegex(driver.DriverError, "credential pool owner"):
                        instance.check_group_write_access(-1001, 123)
                self.assertTrue(all(p["@type"].startswith("get") for p in requests))

    def test_inactive_basic_group_is_not_writable_even_for_creator(self):
        instance, _ = self.make_driver({"@type": "chatMemberStatusCreator", "is_member": True}, kind="chatTypeBasicGroup", active=False)
        with self.assertRaisesRegex(driver.DriverError, "inactive"):
            instance.check_group_write_access(-1001, 123)

    def test_private_chat_does_not_claim_group_permission(self):
        instance, requests = self.make_driver({}, kind="chatTypePrivate")
        self.assertFalse(instance.check_group_write_access(123, 123))
        self.assertEqual(len(requests), 1)

    def test_denied_tester_never_announces_ready_or_sends(self):
        from unittest.mock import patch
        import argparse
        import io
        instance, requests = self.make_driver({"@type": "chatMemberStatusLeft"})
        instance.authorize = lambda args: None
        instance.resolve_chat = lambda chat: -1001
        emitted = []
        with patch.object(driver, "load_config", return_value=({}, {})), patch.object(driver, "UserDriver", return_value=instance), patch.object(driver, "write_ndjson", side_effect=emitted.append), patch.object(driver.sys, "stdin", io.StringIO("")), patch.object(driver.select, "select", return_value=([driver.sys.stdin], [], [])):
            with self.assertRaisesRegex(driver.DriverError, "not an active member"):
                driver.command_serve(argparse.Namespace(timeout_ms=1000, chat="-1001"))
        self.assertEqual(emitted, [])
        self.assertNotIn("sendMessage", [p["@type"] for p in requests])

if __name__ == "__main__":
    unittest.main()
