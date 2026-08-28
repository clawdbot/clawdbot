#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///
"""Record every observable Telegram event as the QA user, not just new messages.

`user-driver.py` handles only updateNewMessage, and no bot can observe deletions
at all. Progress drafts are built on edit-in-place plus delete-on-cleanup, so
proving them needs the full update stream:

  updateNewMessage      -> message
  updateMessageContent  -> edit      (carries the new body; one per revision)
  updateMessageEdited   -> edit-meta (edit_date / reply_markup only)
  updateDeleteMessages  -> delete    (is_permanent distinguishes real deletes)
  updateChatAction      -> typing
  updateMessageInteractionInfo -> reaction (ack / status reaction lifecycle)
"""

import argparse
from collections import Counter
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

DRIVER_PATH = Path(__file__).with_name("user-driver.py")
_spec = importlib.util.spec_from_file_location("tg_user_driver", DRIVER_PATH)
driver = importlib.util.module_from_spec(_spec)
sys.modules["tg_user_driver"] = driver
_spec.loader.exec_module(driver)


def formatted_text(value):
    return value.get("text", "") if isinstance(value, dict) else ""


def rich_text(value):
    if not isinstance(value, dict):
        return ""
    kind = value.get("@type", "")
    if kind == "richTextPlain":
        return value.get("text", "")
    if kind == "richTextCustomEmoji":
        return value.get("alternative_text", "")
    if kind == "richTextMathematicalExpression":
        return value.get("expression", "")
    if kind == "richTexts":
        return "".join(rich_text(item) for item in value.get("texts") or [])
    return rich_text(value.get("text"))


def rich_message_text(value):
    if not isinstance(value, dict):
        return ""
    parts = []

    def visit(node):
        if isinstance(node, list):
            for item in node:
                visit(item)
            return
        if not isinstance(node, dict):
            return
        if str(node.get("@type", "")).startswith("richText"):
            text = rich_text(node)
            if text:
                parts.append(text)
            return
        for child in node.values():
            visit(child)

    visit(value.get("blocks") or [])
    return "\n".join(parts)


def content_text(content):
    for key in ("text", "caption"):
        value = content.get(key)
        if isinstance(value, dict) and isinstance(value.get("text"), str):
            return value["text"]
    if content.get("@type") == "messageRichMessage":
        return rich_message_text(content.get("message") or {})
    return ""


def message_text(message):
    return content_text(message.get("content") or {})


def content_kind(message):
    return (message.get("content") or {}).get("@type", "")


class EventRecorder:
    def __init__(self, client, chat_id, record_path, sut_user_id=None):
        self.client = client
        self.chat_id = int(chat_id)
        self.record_path = Path(record_path) if record_path else None
        self.sut_user_id = int(sut_user_id) if sut_user_id else None
        self.events = []
        self.message_fields = {}
        self.messages = {}
        self.started_at = time.time()
        # One handle for the run instead of open/append/close per event; line
        # buffering keeps the file readable while a recording is still going.
        if self.record_path:
            self.record_path.parent.mkdir(parents=True, exist_ok=True)
        self.record_handle = self.record_path.open("w", buffering=1) if self.record_path else None

    def _sender_id(self, message):
        sender = message.get("sender_id") or {}
        return sender.get("user_id") or sender.get("chat_id")

    def _append(self, kind, message_id, raw=None, **fields):
        event = {
            "elapsedMs": int((time.time() - self.started_at) * 1000),
            "kind": kind,
            "messageId": message_id,
            # Bot API ids are TDLib ids >> 20; keep both so bot-lane and
            # userbot-lane recordings can be correlated by message.
            "botApiMessageId": (message_id >> 20) if isinstance(message_id, int) else None,
            **fields,
        }
        self.events.append(event)
        if self.record_handle:
            self.record_handle.write(f"{json.dumps({**event, 'raw': raw})}\n")
        return event

    def _reply_fields(self, message):
        reply = message.get("reply_to") or {}
        quote = reply.get("quote") or {}
        topic = message.get("topic_id") or {}
        topic_id = (
            topic.get("message_thread_id")
            or topic.get("forum_topic_id")
            or topic.get("direct_messages_chat_topic_id")
            or topic.get("saved_messages_topic_id")
            or message.get("message_thread_id")
        )
        return {
            "replyToMessageId": reply.get("message_id") or message.get("reply_to_message_id"),
            "replyToChatId": reply.get("chat_id"),
            "quoteText": formatted_text(quote.get("text")),
            "topicType": topic.get("@type", ""),
            "topicId": topic_id,
        }

    def _remember_message(self, message, sender):
        message_id = message.get("id")
        if not isinstance(message_id, int):
            return
        self.message_fields[message_id] = {
            "senderId": sender,
            "isSut": self.sut_user_id is not None and sender == self.sut_user_id,
            "isOutgoing": bool(message.get("is_outgoing")),
            **self._reply_fields(message),
        }
        self.messages[message_id] = message

    def _known_message_fields(self, message_id):
        return self.message_fields.get(message_id, {})

    def close(self):
        if self.record_handle:
            self.record_handle.close()
            self.record_handle = None

    def ingest(self, update):
        if self._chat_id_of(update) != self.chat_id:
            return
        for kind, message_id, fields in self._events_for(update):
            self._append(kind, message_id, **fields)

    def _chat_id_of(self, update):
        """updateNewMessage nests chat_id under message; the rest keep it top level."""
        message = update.get("message")
        if isinstance(message, dict) and "chat_id" in message:
            return message["chat_id"]
        return update.get("chat_id")

    def _events_for(self, update):
        """One update yields zero or more events; a delete batch yields many."""
        kind = update.get("@type")
        if kind == "updateNewMessage":
            message = update.get("message") or {}
            message_date = message.get("date")
            if isinstance(message_date, int) and message_date < int(self.started_at) - 2:
                return
            sender = self._sender_id(message)
            self._remember_message(message, sender)
            text = message_text(message)
            content = message.get("content") or {}
            rich_message = content.get("message") if content.get("@type") == "messageRichMessage" else None
            yield (
                "message",
                message.get("id"),
                {
                    "raw": update,
                    "senderId": sender,
                    "isSut": self.sut_user_id is not None and sender == self.sut_user_id,
                    "isOutgoing": bool(message.get("is_outgoing")),
                    "contentType": content_kind(message),
                    "textLen": len(text),
                    "text": text,
                    "richMessageIsFull": rich_message.get("is_full") if isinstance(rich_message, dict) else None,
                    **self._reply_fields(message),
                },
            )
        elif kind == "updateMessageContent":
            content = update.get("new_content") or {}
            message_id = update.get("message_id")
            text = content_text(content)
            rich_message = content.get("message") if content.get("@type") == "messageRichMessage" else None
            yield (
                "edit",
                message_id,
                {
                    "raw": update,
                    **self._known_message_fields(message_id),
                    "contentType": content.get("@type", ""),
                    "textLen": len(text),
                    "text": text,
                    "richMessageIsFull": rich_message.get("is_full") if isinstance(rich_message, dict) else None,
                },
            )
        elif kind == "updateMessageEdited":
            message_id = update.get("message_id")
            if message_id in self.messages and "reply_markup" in update:
                self.messages[message_id]["reply_markup"] = update.get("reply_markup")
            yield (
                "edit-meta",
                message_id,
                {
                    "raw": update,
                    **self._known_message_fields(message_id),
                    "editDate": update.get("edit_date"),
                    "hasReplyMarkup": bool(update.get("reply_markup")),
                },
            )
        elif kind == "updateDeleteMessages":
            # from_cache deletions are local cache evictions, not real deletes.
            if update.get("from_cache"):
                return
            for message_id in update.get("message_ids") or []:
                yield (
                    "delete",
                    message_id,
                    {
                        "raw": update,
                        **self._known_message_fields(message_id),
                        "isPermanent": bool(update.get("is_permanent")),
                    },
                )
        elif kind == "updateMessageInteractionInfo":
            # Ack and status reactions arrive here, on the *user's own* message.
            # A bot reacting to its own message produces no update for the user,
            # so probe this by reacting to a message the QA user sent.
            reactions = (
                ((update.get("interaction_info") or {}).get("reactions") or {}).get("reactions") or []
            )
            emojis = "".join(
                (reaction.get("type") or {}).get("emoji", "")
                for reaction in reactions
                if isinstance(reaction, dict)
            )
            yield (
                "reaction",
                update.get("message_id"),
                {
                    "raw": update,
                    **self._known_message_fields(update.get("message_id")),
                    "reactionText": emojis,
                    "reactionCount": sum(
                        int(reaction.get("total_count") or 0)
                        for reaction in reactions
                        if isinstance(reaction, dict)
                    ),
                    "reactionTypes": [
                        reaction.get("type") for reaction in reactions if isinstance(reaction, dict)
                    ],
                },
            )
        elif kind == "updateChatAction":
            sender = self._sender_id({"sender_id": update.get("sender_id") or {}})
            yield (
                "typing",
                None,
                {
                    "raw": update,
                    "action": (update.get("action") or {}).get("@type", ""),
                    "senderId": sender,
                    "isSut": self.sut_user_id is not None and sender == self.sut_user_id,
                },
            )

    def pump(self, seconds, stop_when=None):
        deadline = time.time() + seconds
        while time.time() < deadline:
            update = self.client.next_update(timeout=0.5)
            if not update:
                continue
            self.ingest(update)
            if stop_when and stop_when(self.events):
                return

    def find_callback_button(self, message_text_value, button_text):
        for message_id in sorted(self.messages, reverse=True):
            message = self.messages[message_id]
            fields = self._known_message_fields(message_id)
            if fields.get("isSut") is not True or message_text_value not in message_text(message):
                continue
            markup = message.get("reply_markup") or {}
            if markup.get("@type") != "replyMarkupInlineKeyboard":
                continue
            for row in markup.get("rows") or []:
                for button in row:
                    button_type = button.get("type") or {}
                    if (
                        button.get("text") == button_text
                        and button_type.get("@type") == "inlineKeyboardButtonTypeCallback"
                        and isinstance(button_type.get("data"), str)
                    ):
                        return message_id, button_type["data"]
        return None

    def click_callback_button(self, message_id, data, timeout_ms):
        return self.client.request(
            {
                "@type": "getCallbackQueryAnswer",
                "chat_id": self.chat_id,
                "message_id": message_id,
                "payload": {"@type": "callbackQueryPayloadData", "data": data},
            },
            timeout=timeout_ms / 1000,
        )

    def summary(self):
        by_kind = Counter(event["kind"] for event in self.events)
        sut_by_kind = Counter(event["kind"] for event in self.events if event.get("isSut") is True)
        revisions = [e for e in self.events if e["kind"] in {"message", "edit"}]
        sut_revisions = [e for e in revisions if e.get("isSut") is True]
        return {
            "totals": dict(by_kind),
            "sutTotals": dict(sut_by_kind),
            "timeline": [
                {
                    "elapsedMs": e["elapsedMs"],
                    "kind": e["kind"],
                    "messageId": e["messageId"],
                    "botApiMessageId": e.get("botApiMessageId"),
                    "textLen": e.get("textLen"),
                    "contentType": e.get("contentType"),
                    "senderId": e.get("senderId"),
                    "isSut": e.get("isSut"),
                    "isOutgoing": e.get("isOutgoing"),
                    "replyToMessageId": e.get("replyToMessageId"),
                    "quoteText": e.get("quoteText"),
                    "topicType": e.get("topicType"),
                    "topicId": e.get("topicId"),
                    "reactionText": e.get("reactionText"),
                    "reactionCount": e.get("reactionCount"),
                    "actionType": e.get("actionType"),
                    "status": e.get("status"),
                    "buttonText": e.get("buttonText"),
                    "durationMs": e.get("durationMs"),
                    "error": e.get("error"),
                }
                for e in self.events
            ],
            "revisionTexts": [e.get("text", "") for e in revisions],
            "sutRevisionTexts": [e.get("text", "") for e in sut_revisions],
            "actions": [e for e in self.events if e["kind"] == "action"],
        }


def build_driver():
    """UserDriver owns its own TdClient, so recording shares that one client."""
    config, bot_config = driver.load_config()
    user_driver = driver.UserDriver(config, bot_config)
    user_driver.authorize(need_ready=True)
    return config, bot_config, user_driver


def run_scenario(recorder, driver_obj, sut, actions, seconds):
    telegram_actions = [action for action in actions if action["type"] in {"send", "click"}]
    sent_ids = []
    next_action = 0
    deadline = recorder.started_at + seconds
    while time.time() < deadline:
        now_ms = int((time.time() - recorder.started_at) * 1000)
        if next_action < len(telegram_actions):
            action = telegram_actions[next_action]
            if now_ms >= action["atMs"]:
                if action["type"] == "send":
                    text, _run = driver.apply_template(action["text"], sut)
                    result = driver_obj.send_text(recorder.chat_id, text)
                    message_id = (result or {}).get("id")
                    sent_ids.append(message_id)
                    recorder._append(
                        "action",
                        message_id,
                        actionType="send",
                        status="completed",
                        text=text,
                    )
                    next_action += 1
                    continue

                found = recorder.find_callback_button(action["messageText"], action["buttonText"])
                if found:
                    message_id, data = found
                    started = time.time()
                    try:
                        response = recorder.click_callback_button(
                            message_id,
                            data,
                            action["timeoutMs"],
                        )
                        recorder._append(
                            "action",
                            message_id,
                            raw=response,
                            actionType="click",
                            status="completed",
                            buttonText=action["buttonText"],
                            durationMs=int((time.time() - started) * 1000),
                        )
                    except driver.DriverError as error:
                        recorder._append(
                            "action",
                            message_id,
                            actionType="click",
                            status="failed",
                            buttonText=action["buttonText"],
                            durationMs=int((time.time() - started) * 1000),
                            error=str(error),
                        )
                    next_action += 1
                    continue
                if now_ms >= action["atMs"] + action["timeoutMs"]:
                    recorder._append(
                        "action",
                        None,
                        actionType="click",
                        status="failed",
                        buttonText=action["buttonText"],
                        error=f'No matching "{action["buttonText"]}" callback button appeared.',
                    )
                    next_action += 1
                    continue

        update = driver_obj.client.next_update(timeout=0.2)
        if update:
            recorder.ingest(update)
    return sent_ids


def publish_recorder_ready(path, recorder):
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    pending = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    payload = {
        "schemaVersion": 1,
        "startedAtUnixMs": int(recorder.started_at * 1000),
        "chatId": recorder.chat_id,
    }
    with pending.open("w") as handle:
        json.dump(payload, handle)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(pending, target)


def main():
    parser = argparse.ArgumentParser(description="Record the full Telegram update stream as the QA user.")
    parser.add_argument("--chat", default="")
    parser.add_argument("--send", default="", help="optional text to send before recording")
    parser.add_argument("--send-photo", action="append", default=[], help="photo path to send before recording; repeat for an album")
    parser.add_argument("--send-caption", default="", help="caption for the first photo")
    parser.add_argument("--scenario", default="", help="normalized scenario JSON from the runner")
    parser.add_argument("--ready-file", default="", help=argparse.SUPPRESS)
    parser.add_argument("--seconds", type=float, default=30.0)
    parser.add_argument("--record", default="/tmp/tg-user-events.ndjson")
    parser.add_argument("--output", default="")
    parser.add_argument("--sut-user-id", default="")
    args = parser.parse_args()
    if sum(bool(value) for value in (args.send, args.send_photo, args.scenario)) > 1:
        parser.error("use only one of --send, --send-photo, or --scenario")
    if args.ready_file and not args.scenario:
        parser.error("--ready-file requires --scenario")

    config, bot_config, driver_obj = build_driver()

    # One resolution path for every chat form the driver accepts: numeric id,
    # @username (the DM lane passes the SUT's username), or an invite link.
    chat_id = driver_obj.resolve_chat(args.chat)
    sut = driver.resolve_sut(config, bot_config)
    sut_user_id = args.sut_user_id or sut.get("id") or ""

    recorder = EventRecorder(driver_obj.client, chat_id, args.record, sut_user_id or None)
    publish_recorder_ready(args.ready_file, recorder)

    sent_ids = []
    try:
        if args.scenario:
            scenario = json.loads(Path(args.scenario).read_text())
            sent_ids.extend(
                run_scenario(recorder, driver_obj, sut, scenario["actions"], args.seconds)
            )
        elif args.send:
            text, _run = driver.apply_template(args.send, sut)
            result = driver_obj.send_text(chat_id, text)
            sent_ids.append((result or {}).get("id"))
        elif args.send_photo:
            caption, _run = driver.apply_template(args.send_caption, sut)
            results = driver_obj.send_photos(chat_id, args.send_photo, caption)
            sent_ids.extend(message.get("id") for message in results)
        if not args.scenario:
            recorder.pump(args.seconds)
    finally:
        recorder.close()

    summary = recorder.summary()
    summary["recordingComplete"] = True
    summary["chatId"] = str(chat_id)
    summary["sentMessageId"] = sent_ids[0] if sent_ids else None
    summary["sentMessageIds"] = sent_ids
    summary["sentAction"] = (
        {"type": "scenario", "count": len(sent_ids), "messageIds": sent_ids}
        if args.scenario
        else
        {"type": "text", "messageId": sent_ids[0]}
        if args.send
        else {"type": "photoAlbum", "count": len(sent_ids), "messageIds": sent_ids}
        if args.send_photo
        else None
    )
    summary["recordPath"] = str(args.record)

    payload = json.dumps(summary, indent=2)
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(f"{payload}\n")
    print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
