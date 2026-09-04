#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# ///

import argparse
import atexit
import base64
import ctypes
import fcntl
import hashlib
import json
import os
import platform
import re
import secrets
import select
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path


STATE_ROOT = Path(
    os.environ.get("TELEGRAM_E2E_STATE_DIR")
    # Stable across the skill rename: existing TDLib sessions live here.
    or (Path.home() / ".local/share/telegram-e2e-bot-to-bot")
).expanduser()
STATE_DIR = Path(
    os.environ.get("TELEGRAM_USER_DRIVER_STATE_DIR") or (STATE_ROOT / "user-driver")
).expanduser()
CONFIG_PATH = STATE_DIR / "config.local.json"
BOT_CREDENTIALS_PATH = STATE_ROOT / "credentials.local.json"
TDLIB_CACHE_ROOT = Path(
    os.environ.get("TELEGRAM_USER_DRIVER_TDLIB_CACHE_DIR")
    or (Path.home() / ".cache/openclaw/telegram-e2e-userbot/tdlib")
).expanduser()


class DriverError(RuntimeError):
    pass


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}


def write_json_private(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(stat.S_IRWXU)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)


def env_or_config(env_name, config, key, default=""):
    value = os.environ.get(env_name)
    if value:
        return value
    value = config.get(key)
    if value is None:
        return default
    return str(value)


def load_config():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.chmod(stat.S_IRWXU)
    config = read_json(CONFIG_PATH)
    bot_config = read_json(BOT_CREDENTIALS_PATH)
    if not valid_base64(config.get("databaseEncryptionKey", "")):
        config["databaseEncryptionKey"] = base64.b64encode(secrets.token_bytes(32)).decode()
        write_json_private(CONFIG_PATH, config)
    return config, bot_config


def valid_base64(value):
    if not isinstance(value, str) or not value:
        return False
    try:
        base64.b64decode(value.encode(), validate=True)
        return True
    except ValueError:
        return False


# TDLib 1.8.67. Older TDLib (e.g. 1.8.0) reports messageUnsupported for some
# current OpenClaw message types; keep the pin and hashes in one move.
TDLIB_PACKAGE_VERSION = "0.1008067.0"
TDLIB_PREBUILT = {
    ("darwin", "arm64"): (
        "darwin-arm64",
        "libtdjson.dylib",
        "74579fba6475357d924987fda7a7d7c9e2f1c35f842f4d107bce840aa6ed96559d3f8efa82c79272a537e214b3691e1162c22e4192438da606b75bf662223b1c",
    ),
    ("darwin", "x86_64"): (
        "darwin-x64",
        "libtdjson.dylib",
        "b6a49eef1060d7fe51cf34dcecf97360fe392930b473057764abd4a99bc71ce0eb0f3cd69f0aa5b6d790ffedc5be4dfce8d730151238cb98c7a2de97bc21ffdc",
    ),
    ("linux", "x86_64"): (
        "linux-x64-glibc",
        "libtdjson.so",
        "20b48d15b8cffe045635cd1b4edc93397d515bce78bda51c4a973a1ad5c9429ec7830afffa6d466f3854e21af2e32791934d847ec9aa0da05055d5d28c15e066",
    ),
    ("linux", "aarch64"): (
        "linux-arm64-glibc",
        "libtdjson.so",
        "3106daa8847b270e6479c9855682e9f3665aff970745d8ee8a781086b33593ce584393c2eb63e8bf98bda92901fbd25054df7b7fcf4c31c6d8781b4096204dd5",
    ),
}


def extract_prebuilt_archive(tar, destination):
    root = Path(destination).resolve()
    for member in tar.getmembers():
        target = (root / member.name).resolve()
        outside_root = target != root and root not in target.parents
        if outside_root or not (member.isfile() or member.isdir()):
            raise DriverError("TDLib package archive has an unsafe member")
    tar.extractall(destination)


def ensure_prebuilt_tdjson():
    entry = TDLIB_PREBUILT.get((platform.system().lower(), platform.machine().lower()))
    if not entry:
        return None
    package, libname, sha512 = entry
    # Cache key matches the old bootstrap layout so bootstrapped machines reuse
    # their existing extraction.
    cache_dir = TDLIB_CACHE_ROOT / sha512[:16]
    lib = cache_dir / "package" / libname
    if lib.exists():
        return lib
    url = (
        f"https://registry.npmjs.org/@prebuilt-tdlib/{package}"
        f"/-/{package}-{TDLIB_PACKAGE_VERSION}.tgz"
    )
    cache_dir.mkdir(parents=True, exist_ok=True)
    lock_path = cache_dir / ".install.lock"
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if lib.exists():
            return lib
        with tempfile.NamedTemporaryFile(
            dir=cache_dir, suffix=".tgz", delete=False
        ) as handle:
            archive = Path(handle.name)
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                archive.write_bytes(response.read())
            digest = hashlib.sha512(archive.read_bytes()).hexdigest()
            if digest != sha512:
                raise DriverError(
                    f"libtdjson download checksum mismatch for {package}: got {digest}"
                )
            with tempfile.TemporaryDirectory(dir=cache_dir, prefix=".extract-") as temp:
                with tarfile.open(archive) as tar:
                    extract_prebuilt_archive(tar, temp)
                Path(temp, "package").replace(cache_dir / "package")
        finally:
            archive.unlink(missing_ok=True)
    if not lib.exists():
        raise DriverError(f"libtdjson missing from extracted {package} archive")
    return lib


def find_tdjson(config):
    explicit = env_or_config("TELEGRAM_USER_DRIVER_TDLIB_PATH", config, "tdlibPath")
    if explicit:
        path = Path(explicit).expanduser()
        if path.exists():
            return path
    prebuilt = ensure_prebuilt_tdjson()
    if prebuilt:
        return prebuilt
    candidates = [
        Path(path)
        for path in [
            "/opt/homebrew/lib/libtdjson.dylib",
            "/opt/homebrew/opt/tdlib/lib/libtdjson.dylib",
            "/usr/local/lib/libtdjson.dylib",
            "/usr/local/opt/tdlib/lib/libtdjson.dylib",
            "/usr/lib/libtdjson.so",
            "/usr/local/lib/libtdjson.so",
        ]
    ]
    for path in candidates:
        if path.exists():
            return path
    found = shutil.which("tdjson")
    if found:
        return Path(found)
    return None


def telegram_bot(token, method, payload=None, test_dc=False):
    data = json.dumps(payload or {}).encode()
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{'test/' if test_dc else ''}{method}",
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = json.loads(response.read().decode())
    except (OSError, ValueError):
        raise DriverError(f"Telegram Bot API {method} request failed") from None
    if not body.get("ok"):
        raise DriverError(body.get("description") or f"{method} failed")
    return body["result"]


def resolve_sut(config, bot_config):
    username = env_or_config("TELEGRAM_USER_DRIVER_SUT_USERNAME", config, "sutUsername")
    user_id = env_or_config("TELEGRAM_USER_DRIVER_SUT_ID", config, "sutId")
    if username and user_id:
        return {"username": username.lstrip("@"), "id": int(user_id)}
    token = (
        os.environ.get("TELEGRAM_E2E_SUT_BOT_TOKEN")
        or os.environ.get("OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN")
        or bot_config.get("sutBotToken")
        or bot_config.get("botAToken")
        or bot_config.get("BOTA")
    )
    if token:
        me = telegram_bot(token, "getMe", test_dc=config.get("testDc") is True)
        return {"username": me.get("username", "").lstrip("@"), "id": int(me["id"])}
    if username:
        return {"username": username.lstrip("@"), "id": None}
    return {"username": "", "id": None}


def default_chat(config, bot_config):
    return (
        os.environ.get("TELEGRAM_USER_DRIVER_CHAT_ID")
        or os.environ.get("TELEGRAM_E2E_GROUP_ID")
        or os.environ.get("OPENCLAW_QA_TELEGRAM_GROUP_ID")
        or str(config.get("defaultChatId") or "")
        or str(bot_config.get("groupId") or "")
    )


class TdClient:
    def __init__(self, config):
        lib_path = find_tdjson(config)
        if not lib_path:
            raise DriverError(
                "Missing libtdjson and no pinned prebuilt exists for "
                f"{platform.system()}/{platform.machine()}. Install TDLib "
                "(e.g. brew install tdlib) or set TELEGRAM_USER_DRIVER_TDLIB_PATH."
            )
        self.lib_path = lib_path
        self.lib = ctypes.CDLL(str(lib_path))
        self.lib.td_execute.argtypes = [ctypes.c_char_p]
        self.lib.td_execute.restype = ctypes.c_char_p
        self.lib.td_json_client_create.restype = ctypes.c_void_p
        self.lib.td_json_client_send.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        self.lib.td_json_client_receive.argtypes = [ctypes.c_void_p, ctypes.c_double]
        self.lib.td_json_client_receive.restype = ctypes.c_char_p
        self.lib.td_json_client_execute.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        self.lib.td_json_client_execute.restype = ctypes.c_char_p
        self.lib.td_json_client_destroy.argtypes = [ctypes.c_void_p]
        self.lib.td_execute(json.dumps({"@type": "setLogStream", "log_stream": {"@type": "logStreamEmpty"}}).encode())
        self.lib.td_execute(json.dumps({"@type": "setLogVerbosityLevel", "new_verbosity_level": 0}).encode())
        self.client = self.lib.td_json_client_create()
        self.extra = 0
        self.pending = {}
        self.users = {}
        self.updates = []
        atexit.register(self.destroy)

    def execute(self, payload):
        raw = self.lib.td_json_client_execute(self.client, json.dumps(payload).encode())
        return json.loads(raw.decode()) if raw else None

    def send(self, payload):
        self.extra += 1
        extra = str(self.extra)
        payload = dict(payload)
        payload["@extra"] = extra
        self.pending[extra] = payload["@type"]
        self.lib.td_json_client_send(self.client, json.dumps(payload).encode())
        return extra

    def receive(self, timeout=1.0):
        raw = self.lib.td_json_client_receive(self.client, ctypes.c_double(timeout))
        if not raw:
            return None
        item = json.loads(raw.decode())
        if item.get("@type") == "updateUser":
            user = item.get("user") or {}
            self.users[int(user["id"])] = user
        return item

    def destroy(self):
        if not self.client:
            return
        client = self.client
        self.client = None
        self.lib.td_json_client_destroy(client)

    def request(self, payload, timeout=20):
        extra = self.send(payload)
        deadline = time.time() + timeout
        while time.time() < deadline:
            item = self.receive(1)
            if not item:
                continue
            if item.get("@extra") == extra:
                if item.get("@type") == "error":
                    raise DriverError(
                        f"{payload['@type']} failed ({item.get('code')}): {item.get('message')}"
                    )
                return item
            self.handle_update(item)
        raise DriverError(f"Timed out waiting for {payload['@type']}")

    def handle_update(self, item):
        self.updates.append(item)
        return item

    def next_update(self, timeout=1.0):
        if self.updates:
            return self.updates.pop(0)
        return self.receive(timeout)


class UserDriver:
    def __init__(self, config, bot_config):
        self.config = config
        self.bot_config = bot_config
        self.client = TdClient(config)
        self.auth_state = None
        self.printed_qr_link = ""

    def td_params(self):
        api_id = env_or_config("TELEGRAM_USER_DRIVER_API_ID", self.config, "apiId")
        api_hash = env_or_config("TELEGRAM_USER_DRIVER_API_HASH", self.config, "apiHash")
        if not api_id or not api_hash:
            raise DriverError("Missing Telegram API app credentials. Run configure or set TELEGRAM_USER_DRIVER_API_ID/API_HASH.")
        params = {
            "use_test_dc": self.config.get("testDc") is True,
            "database_directory": str(STATE_DIR / "db"),
            "files_directory": str(STATE_DIR / "files"),
            "use_file_database": True,
            "use_chat_info_database": True,
            "use_message_database": True,
            "use_secret_chats": False,
            "api_id": int(api_id),
            "api_hash": api_hash,
            "system_language_code": "en",
            "device_model": "OpenClaw Telegram User Driver",
            "system_version": sys.platform,
            "application_version": "1",
            "enable_storage_optimizer": True,
            "ignore_file_names": False,
        }
        return {
            "@type": "setTdlibParameters",
            "parameters": {"@type": "tdlibParameters", **params},
        }

    def td_params_current(self):
        payload = self.td_params()
        params = dict(payload["parameters"])
        params.pop("@type", None)
        # TDLib >= 1.8.6 dropped authorizationStateWaitEncryptionKey and takes the
        # key here instead. `bytes` fields are base64 in the JSON interface, and
        # the stored key is already base64, so pass it through unchanged: that
        # decodes to the same 32 bytes a 1.8.0-era database was created with.
        # Re-encoding it would silently derive a different key.
        return {
            "@type": "setTdlibParameters",
            "database_encryption_key": self.encryption_key(),
            **params,
        }

    def encryption_key(self):
        return env_or_config(
            "TELEGRAM_USER_DRIVER_DB_ENCRYPTION_KEY",
            self.config,
            "databaseEncryptionKey",
        )

    def encryption_key_for_current_tdlib(self):
        return base64.b64encode(self.encryption_key().encode()).decode()

    def authorize(self, args=None, need_ready=True):
        args = args or argparse.Namespace()
        self.client.execute({"@type": "setLogStream", "log_stream": {"@type": "logStreamEmpty"}})
        self.client.execute({"@type": "setLogVerbosityLevel", "new_verbosity_level": 1})
        self.client.send({"@type": "getOption", "name": "version"})
        retried_current_params = False
        retried_current_encryption_key = False
        deadline = time.time() + getattr(args, "timeout_ms", 120000) / 1000
        while time.time() < deadline:
            item = self.client.receive(1)
            if not item:
                continue
            if item.get("@type") == "updateAuthorizationState":
                self.auth_state = item["authorization_state"]
                state = self.auth_state["@type"]
                if state == "authorizationStateWaitTdlibParameters":
                    self.client.send(self.td_params())
                elif state == "authorizationStateWaitEncryptionKey":
                    self.client.send(
                        {
                            "@type": "checkDatabaseEncryptionKey",
                            "encryption_key": self.encryption_key(),
                        }
                    )
                elif state == "authorizationStateWaitPhoneNumber":
                    if getattr(args, "phone", ""):
                        self.client.send(
                            {
                                "@type": "setAuthenticationPhoneNumber",
                                "phone_number": args.phone,
                                "settings": None,
                            }
                        )
                    elif getattr(args, "qr", False):
                        self.client.send({"@type": "requestQrCodeAuthentication", "other_user_ids": []})
                    elif need_ready:
                        raise DriverError("Not logged in. Run: user-driver.py login --qr")
                    else:
                        return False
                elif state == "authorizationStateWaitOtherDeviceConfirmation":
                    self.show_qr_link(self.auth_state["link"])
                elif state == "authorizationStateWaitCode":
                    code = getattr(args, "code", "") or prompt_secret("Telegram login code: ")
                    self.client.send({"@type": "checkAuthenticationCode", "code": code})
                elif state == "authorizationStateWaitPassword":
                    password = getattr(args, "password", "") or prompt_secret("Telegram 2FA password: ")
                    self.client.send({"@type": "checkAuthenticationPassword", "password": password})
                elif state == "authorizationStateReady":
                    return True
                elif state in {"authorizationStateClosing", "authorizationStateClosed", "authorizationStateLoggingOut"}:
                    raise DriverError(f"TDLib auth state is {state}")
            elif item.get("@type") == "error":
                message = item.get("message") or "TDLib error"
                if not retried_current_params and "Valid api_id must be provided" in message:
                    retried_current_params = True
                    self.client.send(
                        {
                            "@type": "setDatabaseEncryptionKey",
                            "new_encryption_key": self.encryption_key_for_current_tdlib(),
                        }
                    )
                    self.client.send(self.td_params_current())
                    continue
                if not retried_current_encryption_key and "Wrong database encryption key" in message:
                    retried_current_encryption_key = True
                    # Retry with the key as stored rather than re-encoded; see
                    # td_params_current for why double-encoding derives a
                    # different key and cannot open an existing database.
                    self.client.send(self.td_params_current())
                    continue
                if retried_current_params and "Initialization parameters are needed" in message:
                    continue
                raise DriverError(message)
        raise DriverError("Timed out waiting for Telegram authorization")

    def show_qr_link(self, link):
        if link == self.printed_qr_link:
            return
        self.printed_qr_link = link
        print("\nScan this with Telegram > Settings > Devices > Link Desktop Device\n")
        qrencode = shutil.which("qrencode")
        if qrencode:
            subprocess.run([qrencode, "-t", "UTF8", link], check=False)
        print(link)
        print("")

    def resolve_chat(self, chat):
        chat = chat or default_chat(self.config, self.bot_config)
        if not chat:
            raise DriverError("Missing chat. Pass --chat or configure defaultChatId. Run `user-driver.py chats --json` to list chats visible to the tester account.")
        if chat.startswith("https://t.me/+") or chat.startswith("tg://join") or "joinchat" in chat:
            return self.client.request({"@type": "joinChatByInviteLink", "invite_link": chat})["id"]
        if chat.startswith("@"):
            return self.client.request({"@type": "searchPublicChat", "username": chat[1:]})["id"]
        if chat.startswith("https://t.me/") and "/" not in chat.removeprefix("https://t.me/"):
            return self.client.request({"@type": "searchPublicChat", "username": chat.removeprefix("https://t.me/")})["id"]
        try:
            return self.client.request({"@type": "getChat", "chat_id": int(chat)}, timeout=10)["id"]
        except DriverError as error:
            try:
                self.client.request(
                    {
                        "@type": "loadChats",
                        "chat_list": {"@type": "chatListMain"},
                        "limit": 100,
                    },
                    timeout=30,
                )
            except DriverError as refresh_error:
                if "failed (404)" not in str(refresh_error):
                    raise
            try:
                return self.client.request(
                    {"@type": "getChat", "chat_id": int(chat)}, timeout=10
                )["id"]
            except DriverError:
                raise DriverError(
                    f"Chat not found for tester account: {chat}. Add the QA user to the group, or configure the TDLib chat id from `user-driver.py chats --json`."
                ) from error

    def formatted_text(self, text):
        sut = resolve_sut(self.config, self.bot_config)
        username = sut.get("username") or ""
        if not username:
            return {"@type": "formattedText", "text": text, "entities": []}
        entities = []
        occupied = []
        command_pattern = re.compile(
            rf"(?<!\S)/[A-Za-z0-9_]+@{re.escape(username)}\b", re.IGNORECASE
        )
        for match in command_pattern.finditer(text):
            occupied.append((match.start(), match.end()))
            entities.append(self.text_entity(text, match.start(), match.end(), "textEntityTypeBotCommand"))
        mention_pattern = re.compile(rf"@{re.escape(username)}\b", re.IGNORECASE)
        for match in mention_pattern.finditer(text):
            if any(start <= match.start() < end for start, end in occupied):
                continue
            entities.append(self.text_entity(text, match.start(), match.end(), "textEntityTypeMention"))
        entities.sort(key=lambda entity: entity["offset"])
        return {"@type": "formattedText", "text": text, "entities": entities}

    def text_entity(self, text, start, end, entity_type):
        utf16_offset = len(text[:start].encode("utf-16-le")) // 2
        utf16_length = len(text[start:end].encode("utf-16-le")) // 2
        return {
            "@type": "textEntity",
            "offset": utf16_offset,
            "length": utf16_length,
            "type": {"@type": entity_type},
        }

    def text_content(self, text):
        return {
            "@type": "inputMessageText",
            "text": self.formatted_text(text),
            "disable_web_page_preview": False,
            "clear_draft": True,
        }

    def photo_content(self, path, caption=""):
        photo_path = Path(path).expanduser().resolve()
        if not photo_path.is_file():
            raise DriverError(f"Photo file not found: {photo_path}")
        return {
            "@type": "inputMessagePhoto",
            "photo": {
                "@type": "inputPhoto",
                "photo": {"@type": "inputFileLocal", "path": str(photo_path)},
                "thumbnail": None,
                "video": None,
                "added_sticker_file_ids": [],
                "width": 0,
                "height": 0,
            },
            "caption": self.formatted_text(caption),
            "show_caption_above_media": False,
            "self_destruct_type": None,
            "has_spoiler": False,
        }

    def send_text(self, chat_id, text, reply_to=None, thread_id=0):
        return self.settle_sent_message(
            self.client.request(
                {
                    "@type": "sendMessage",
                    "chat_id": chat_id,
                    "message_thread_id": int(thread_id or 0),
                    "reply_to_message_id": int(reply_to or 0),
                    "options": {
                        "@type": "messageSendOptions",
                        "disable_notification": True,
                        "from_background": False,
                        "scheduling_state": None,
                    },
                    "reply_markup": None,
                    "input_message_content": self.text_content(text),
                },
                timeout=30,
            )
        )

    def send_photos(self, chat_id, paths, caption="", reply_to=None, thread_id=0):
        contents = [
            self.photo_content(path, caption if index == 0 else "")
            for index, path in enumerate(paths)
        ]
        payload = {
            "chat_id": chat_id,
            "message_thread_id": int(thread_id or 0),
            "reply_to_message_id": int(reply_to or 0),
            "options": {
                "@type": "messageSendOptions",
                "disable_notification": True,
                "from_background": False,
                "scheduling_state": None,
            },
        }
        if len(contents) == 1:
            response = self.client.request(
                {"@type": "sendMessage", "reply_markup": None, "input_message_content": contents[0], **payload},
                timeout=30,
            )
            return [self.settle_sent_message(response)]
        response = self.client.request(
            {"@type": "sendMessageAlbum", "input_message_contents": contents, **payload},
            timeout=60,
        )
        return [self.settle_sent_message(message) for message in response.get("messages", [])]

    def settle_sent_message(self, message, timeout=30):
        if not message.get("sending_state"):
            return message
        pending_id = message["id"]
        deadline = time.time() + timeout
        deferred = []
        while time.time() < deadline:
            item = self.client.next_update(1)
            if not item:
                continue
            if item.get("@type") == "updateMessageSendSucceeded" and item.get("old_message_id") == pending_id:
                self.client.updates = deferred + self.client.updates
                return item["message"]
            if item.get("@type") == "updateMessageSendFailed" and item.get("old_message_id") == pending_id:
                self.client.updates = deferred + self.client.updates
                raise DriverError(item.get("error_message") or "Telegram message send failed")
            deferred.append(item)
        self.client.updates = deferred + self.client.updates
        raise DriverError("Timed out waiting for Telegram message send confirmation")

    def wait_for_message(self, chat_id, args, after_message_id=0):
        sut = resolve_sut(self.config, self.bot_config)
        expect = args.expect or []
        from_bot = (args.from_bot or sut["username"] or "").lstrip("@")
        from_bot_id = int(from_bot) if from_bot.isdigit() else sut["id"]
        from_bot_username = "" if from_bot.isdigit() else from_bot
        deadline = time.time() + args.timeout_ms / 1000
        observed = []
        while time.time() < deadline:
            item = self.client.next_update(1)
            if not item or item.get("@type") != "updateNewMessage":
                continue
            message = item["message"]
            if int(message.get("chat_id", 0)) != int(chat_id):
                continue
            normalized = normalize_message(message, self.client.users)
            observed.append(normalized)
            if int(normalized["messageId"]) <= int(after_message_id):
                continue
            if getattr(args, "thread_id", None) and str(normalized.get("threadId") or "") != str(args.thread_id):
                continue
            if from_bot_id and int(normalized.get("senderId") or 0) != int(from_bot_id):
                continue
            if not from_bot_id and from_bot_username and normalized["senderUsername"].lower() != from_bot_username.lower():
                continue
            if args.reply_to and str(normalized.get("replyToMessageId") or "") != str(args.reply_to):
                continue
            if any(entry not in normalized["text"] for entry in expect):
                continue
            return normalized, observed
        return None, observed


def prompt_secret(label):
    if not sys.stdin.isatty():
        raise DriverError(f"{label.strip()} required; rerun with explicit flag in an interactive terminal.")
    import getpass

    return getpass.getpass(label)


def normalize_message(message, users=None):
    users = users or {}
    sender = message.get("sender_id") or {}
    sender_id = sender.get("user_id") or sender.get("chat_id")
    sender_user = users.get(int(sender_id or 0), {}) if sender_id else {}
    content = message.get("content") or {}
    reply_to_message_id = message.get("reply_to_message_id") or (message.get("reply_to") or {}).get("message_id")
    return {
        "messageId": message.get("id"),
        "chatId": message.get("chat_id"),
        "senderId": sender_id,
        "senderUsername": sender_user.get("username") or "",
        "date": message.get("date"),
        "replyToMessageId": reply_to_message_id,
        "threadId": message.get("message_thread_id"),
        **message_content(content),
        "raw": message,
    }


def apply_template(text, sut):
    run = f"USER-E2E-{int(time.time())}"
    username = sut.get("username", "")
    return text.replace("{run}", run).replace("{sut}", username), run


def print_result(payload, as_json=False, output=""):
    if output:
        output_path = Path(output).expanduser()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(json.dumps(payload, indent=2, sort_keys=True))


def command_configure(args):
    config, _ = load_config()
    changed = False
    for arg_name, key in [
        ("api_id", "apiId"),
        ("api_hash", "apiHash"),
        ("tdlib_path", "tdlibPath"),
        ("chat", "defaultChatId"),
        ("sut_username", "sutUsername"),
        ("sut_id", "sutId"),
    ]:
        value = getattr(args, arg_name)
        if value:
            config[key] = int(value) if key in {"apiId", "sutId"} else value
            changed = True
    if not changed:
        raise DriverError("No config values passed.")
    write_json_private(CONFIG_PATH, config)
    print(f"Wrote {CONFIG_PATH}")


def command_doctor(args):
    config = read_json(CONFIG_PATH)
    bot_config = read_json(BOT_CREDENTIALS_PATH)
    lib_path = find_tdjson(config)
    tdjson_loads = False
    tdjson_error = ""
    if lib_path:
        try:
            ctypes.CDLL(str(lib_path))
            tdjson_loads = True
        except OSError as error:
            tdjson_error = str(error)
    checks = {
        "configPath": str(CONFIG_PATH),
        "tdjson": str(lib_path) if lib_path else "",
        "tdjsonLoads": tdjson_loads,
        "tdjsonError": tdjson_error,
        "hasApiId": bool(env_or_config("TELEGRAM_USER_DRIVER_API_ID", config, "apiId")),
        "hasApiHash": bool(env_or_config("TELEGRAM_USER_DRIVER_API_HASH", config, "apiHash")),
        "hasDefaultChat": bool(default_chat(config, bot_config)),
        "hasSutIdentity": bool(resolve_sut(config, bot_config).get("username")),
        "hasTesterIdentity": bool(config.get("testerUserId")),
        "testDc": config.get("testDc") is True,
        "testerUsername": config.get("testerUsername", ""),
        "hasQrencode": bool(shutil.which("qrencode")),
    }
    checks["ok"] = bool(
        checks["tdjsonLoads"]
        and checks["hasApiId"]
        and checks["hasApiHash"]
        and checks["hasDefaultChat"]
        and checks["hasSutIdentity"]
    )
    if checks["ok"]:
        checks["next"] = "run status --json"
    elif not checks["tdjsonLoads"]:
        checks["next"] = "install TDLib or set TELEGRAM_USER_DRIVER_TDLIB_PATH"
    else:
        checks["next"] = "run run-mock-sut-user-e2e.mjs; it lease-restores the session"
    print_result(checks, args.json, getattr(args, "output", ""))
    if not checks["ok"]:
        sys.exit(1)


def command_login(args):
    config, bot_config = load_config()
    driver = UserDriver(config, bot_config)
    driver.authorize(args)
    me = driver.client.request({"@type": "getMe"})
    save_tester_identity(config, me)
    print_result({"ok": True, "user": public_user(me)}, args.json, getattr(args, "output", ""))


def command_status(args):
    config, bot_config = load_config()
    driver = UserDriver(config, bot_config)
    ready = driver.authorize(argparse.Namespace(timeout_ms=args.timeout_ms), need_ready=False)
    if not ready:
        print_result({"ok": False, "authorized": False, "next": "login --qr"}, args.json, getattr(args, "output", ""))
        sys.exit(1)
    me = driver.client.request({"@type": "getMe"})
    version = driver.client.request({"@type": "getOption", "name": "version"})
    save_tester_identity(config, me)
    print_result(
        {
            "ok": True,
            "authorized": True,
            "testDc": config.get("testDc") is True,
            "tdlibVersion": version.get("value", ""),
            "user": public_user(me),
        },
        args.json,
        getattr(args, "output", ""),
    )


def command_confirm_qr(args):
    config, bot_config = load_config()
    driver = UserDriver(config, bot_config)
    driver.authorize(argparse.Namespace(timeout_ms=args.timeout_ms))
    result = driver.client.request({"@type": "confirmQrCodeAuthentication", "link": args.link}, timeout=30)
    print_result(
        {
            "ok": True,
            "session": {
                "id": result.get("id"),
                "isCurrent": result.get("is_current"),
                "isPasswordPending": result.get("is_password_pending"),
                "applicationName": result.get("application_name"),
                "deviceModel": result.get("device_model"),
                "platform": result.get("platform"),
                "systemVersion": result.get("system_version"),
            },
        },
        args.json,
        getattr(args, "output", ""),
    )


def public_user(user):
    return {
        "id": user.get("id"),
        "firstName": user.get("first_name"),
        "lastName": user.get("last_name"),
        "username": user.get("username"),
        "isBot": user.get("type", {}).get("@type") == "userTypeBot",
    }


def save_tester_identity(config, user):
    config["testerUserId"] = user.get("id")
    config["testerUsername"] = user.get("username") or ""
    config["testerFirstName"] = user.get("first_name") or ""
    config["testerLastName"] = user.get("last_name") or ""
    write_json_private(CONFIG_PATH, config)


def command_send(args):
    config, bot_config = load_config()
    driver = UserDriver(config, bot_config)
    driver.authorize(argparse.Namespace(timeout_ms=args.timeout_ms))
    chat_id = driver.resolve_chat(args.chat)
    if args.photo:
        sent = driver.send_photos(chat_id, args.photo, args.caption, args.reply_to, args.thread_id)
        print_result(
            {
                "ok": True,
                "sent": [normalize_message(message) for message in sent],
                "sentMessageIds": [message.get("id") for message in sent],
            },
            args.json,
            getattr(args, "output", ""),
        )
        return
    text, _run = apply_template(args.text, resolve_sut(config, bot_config))
    sent = driver.send_text(chat_id, text, args.reply_to, args.thread_id)
    print_result({"ok": True, "sent": normalize_message(sent)}, args.json, getattr(args, "output", ""))


def command_wait(args):
    config, bot_config = load_config()
    driver = UserDriver(config, bot_config)
    driver.authorize(argparse.Namespace(timeout_ms=args.timeout_ms))
    chat_id = driver.resolve_chat(args.chat)
    message, observed = driver.wait_for_message(chat_id, args, args.after_message_id)
    print_result(
        {
            "ok": bool(message),
            "message": message,
            "observedCount": len(observed),
            "observed": [] if message else observed[-10:],
        },
        args.json,
        getattr(args, "output", ""),
    )
    if not message:
        sys.exit(1)


def command_probe(args):
    config, bot_config = load_config()
    driver = UserDriver(config, bot_config)
    driver.authorize(argparse.Namespace(timeout_ms=args.timeout_ms))
    sut = resolve_sut(config, bot_config)
    chat_id = driver.resolve_chat(args.chat)
    if args.photo:
        caption, run = apply_template(args.caption, sut)
        sent_messages = driver.send_photos(chat_id, args.photo, caption, args.reply_to, args.thread_id)
        sent = sent_messages[0]
    else:
        text, run = apply_template(args.text, sut)
        sent_messages = [driver.send_text(chat_id, text, args.reply_to)]
        sent = sent_messages[0]
    wait_args = argparse.Namespace(
        expect=args.expect,
        from_bot=args.from_bot,
        reply_to=sent["id"] if args.require_reply else None,
        thread_id=args.thread_id,
        timeout_ms=args.timeout_ms,
    )
    message, observed = driver.wait_for_message(chat_id, wait_args, sent["id"])
    result = {
        "ok": bool(message),
        "chatId": chat_id,
        "run": run,
        "sent": normalize_message(sent),
        "sentMessages": [normalize_message(message) for message in sent_messages],
        "reply": message,
        "observedCount": len(observed),
        "observed": [] if message else observed[-10:],
    }
    print_result(result, args.json, getattr(args, "output", ""))
    if not message:
        sys.exit(1)


def command_transcript(args):
    config, bot_config = load_config()
    driver = UserDriver(config, bot_config)
    driver.authorize(argparse.Namespace(timeout_ms=args.timeout_ms))
    chat_id = driver.resolve_chat(args.chat)
    history = driver.client.request(
        {
            "@type": "getChatHistory",
            "chat_id": chat_id,
            "from_message_id": 0,
            "offset": 0,
            "limit": args.limit,
            "only_local": False,
        }
    )
    messages = [normalize_message(message) for message in history.get("messages", [])]
    print_result({"ok": True, "chatId": chat_id, "messages": messages}, args.json, getattr(args, "output", ""))


def command_chats(args):
    config, bot_config = load_config()
    driver = UserDriver(config, bot_config)
    driver.authorize(argparse.Namespace(timeout_ms=args.timeout_ms))
    chats = driver.client.request(
        {"@type": "getChats", "chat_list": {"@type": "chatListMain"}, "limit": args.limit},
        timeout=20,
    )
    seen = set()
    rows = []
    for chat_id in chats.get("chat_ids", []):
        chat = driver.client.request({"@type": "getChat", "chat_id": chat_id}, timeout=10)
        rows.append(public_chat(chat, "main"))
        seen.add(int(chat["id"]))
    configured = default_chat(config, bot_config)
    if configured and configured.lstrip("-").isdigit():
        try:
            chat = driver.client.request({"@type": "getChat", "chat_id": int(configured)}, timeout=10)
            if int(chat["id"]) not in seen:
                rows.append(public_chat(chat, "configured"))
        except DriverError:
            pass
    print_result({"ok": True, "configuredChat": configured, "chats": rows}, args.json, getattr(args, "output", ""))


def serve_message(message, users):
    normalized = normalize_message(message, users)
    message_id = normalized.get("messageId")
    return {
        "messageId": message_id,
        "botApiMessageId": message_id >> 20 if isinstance(message_id, int) else None,
        "chatId": normalized.get("chatId"),
        "senderId": normalized.get("senderId"),
        "senderUsername": normalized.get("senderUsername"),
        "replyToMessageId": normalized.get("replyToMessageId"),
        "timestamp": int(message.get("date") or 0) * 1000,
        "contentType": normalized["contentType"],
        "text": normalized["text"],
        "entities": normalized["entities"],
    }


def serve_update(update, users, known_messages):
    update_type = update.get("@type")
    if update_type == "updateNewMessage":
        message = update.get("message") or {}
        normalized = serve_message(message, users)
        if isinstance(normalized["messageId"], int):
            known_messages[normalized["messageId"]] = normalized
        return {"kind": "message", **normalized}
    if update_type != "updateMessageContent":
        return None
    message_id = update.get("message_id")
    known = known_messages.get(message_id)
    if not known:
        return None
    content = update.get("new_content") or {}
    normalized = {**known, **message_content(content)}
    known_messages[message_id] = normalized
    return {"kind": "edit", **normalized}


def message_content(content):
    key = "text" if content.get("@type") == "messageText" else "caption"
    formatted = content.get(key)
    if isinstance(formatted, dict) and isinstance(formatted.get("text"), str):
        return {"contentType": content.get("@type"), "text": formatted["text"], "entities": formatted["entities"]}
    return {"contentType": content.get("@type"), "text": "", "entities": []}


def write_ndjson(payload):
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def command_serve(args):
    config, bot_config = load_config()
    driver = UserDriver(config, bot_config)
    driver.authorize(argparse.Namespace(timeout_ms=args.timeout_ms))
    chat_id = driver.resolve_chat(args.chat)
    tester = driver.client.request({"@type": "getMe"})
    write_ndjson(
        {
            "type": "ready",
            "chatId": chat_id,
            "user": public_user(tester),
        }
    )
    known_messages = {}
    while True:
        update = driver.client.next_update(timeout=0.1)
        if update:
            event = serve_update(update, driver.client.users, known_messages)
            if event:
                write_ndjson({"type": "update", "update": event})
        readable, _, _ = select.select([sys.stdin], [], [], 0)
        if not readable:
            continue
        line = sys.stdin.readline()
        if not line:
            return
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if not isinstance(request_id, str) or not request_id:
                raise DriverError("serve command requires a string id")
            if request.get("method") != "send":
                raise DriverError("serve command method must be send")
            text = request.get("text")
            if not isinstance(text, str) or not text:
                raise DriverError("serve send command requires text")
            reply_to = request.get("replyToMessageId")
            sent = driver.send_text(chat_id, text, reply_to=reply_to)
            normalized = serve_message(sent, driver.client.users)
            known_messages[normalized["messageId"]] = normalized
            write_ndjson({"type": "response", "id": request_id, "result": normalized})
        except (DriverError, ValueError, TypeError) as error:
            write_ndjson(
                {
                    "type": "response",
                    "id": request_id,
                    "error": str(error),
                }
            )


def public_chat(chat, source):
    return {
        "id": chat.get("id"),
        "title": chat.get("title"),
        "type": (chat.get("type") or {}).get("@type"),
        "unreadCount": chat.get("unread_count"),
        "source": source,
    }


def add_common(parser):
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--output", default="")
    parser.add_argument("--timeout-ms", type=int, default=120000)


def main():
    parser = argparse.ArgumentParser(description="Telegram real-user E2E driver backed by TDLib.")
    sub = parser.add_subparsers(dest="command", required=True)

    configure = sub.add_parser("configure")
    configure.add_argument("--api-id")
    configure.add_argument("--api-hash")
    configure.add_argument("--tdlib-path")
    configure.add_argument("--chat")
    configure.add_argument("--sut-username")
    configure.add_argument("--sut-id")
    configure.set_defaults(func=command_configure)

    doctor = sub.add_parser("doctor")
    doctor.add_argument("--json", action="store_true")
    doctor.add_argument("--output", default="")
    doctor.set_defaults(func=command_doctor)

    login = sub.add_parser("login")
    add_common(login)
    login.add_argument("--qr", action="store_true", default=True)
    login.add_argument("--phone", default="")
    login.add_argument("--code", default="")
    login.add_argument("--password", default="")
    login.set_defaults(func=command_login)

    status = sub.add_parser("status")
    add_common(status)
    status.set_defaults(func=command_status)

    confirm_qr = sub.add_parser("confirm-qr")
    add_common(confirm_qr)
    confirm_qr.add_argument("--link", required=True)
    confirm_qr.set_defaults(func=command_confirm_qr)

    send = sub.add_parser("send")
    add_common(send)
    send.add_argument("--chat", default="")
    send.add_argument("--text")
    send.add_argument("--photo", action="append", default=[])
    send.add_argument("--caption", default="")
    send.add_argument("--reply-to")
    send.add_argument("--thread-id", type=int, default=0)
    send.set_defaults(func=command_send)

    wait = sub.add_parser("wait")
    add_common(wait)
    wait.add_argument("--chat", default="")
    wait.add_argument("--expect", action="append", default=[])
    wait.add_argument("--from-bot", default="")
    wait.add_argument("--reply-to")
    wait.add_argument("--thread-id", type=int, default=0)
    wait.add_argument("--after-message-id", type=int, default=0)
    wait.set_defaults(func=command_wait)

    probe = sub.add_parser("probe")
    add_common(probe)
    probe.add_argument("--chat", default="")
    probe.add_argument("--text", default="@{sut} Reply exactly: USER-E2E-{run}")
    probe.add_argument("--photo", action="append", default=[])
    probe.add_argument("--caption", default="")
    probe.add_argument("--expect", action="append", default=[])
    probe.add_argument("--from-bot", default="")
    probe.add_argument("--reply-to")
    probe.add_argument("--thread-id", type=int, default=0)
    probe.add_argument("--require-reply", action="store_true", default=True)
    probe.add_argument("--any-sut-reply", dest="require_reply", action="store_false")
    probe.set_defaults(func=command_probe)

    transcript = sub.add_parser("transcript")
    add_common(transcript)
    transcript.add_argument("--chat", default="")
    transcript.add_argument("--limit", type=int, default=20)
    transcript.set_defaults(func=command_transcript)

    chats = sub.add_parser("chats")
    add_common(chats)
    chats.add_argument("--limit", type=int, default=50)
    chats.set_defaults(func=command_chats)

    serve = sub.add_parser("serve")
    serve.add_argument("--chat", default="")
    serve.add_argument("--timeout-ms", type=int, default=120000)
    serve.set_defaults(func=command_serve)

    args = parser.parse_args()
    if args.command == "send" and not args.text and not args.photo:
        parser.error("send requires --text or at least one --photo")
    if args.command == "send" and args.text and args.photo:
        parser.error("send accepts --text or --photo, not both; use --caption with --photo")
    if args.command == "send" and args.caption and not args.photo:
        parser.error("--caption requires --photo")
    try:
        args.func(args)
    except DriverError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
