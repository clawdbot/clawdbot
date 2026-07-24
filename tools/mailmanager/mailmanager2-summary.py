#!/usr/bin/env python3

from pathlib import Path
from datetime import datetime
import subprocess
import os
import re

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

BASE = Path.home() / "ai/projects/openclaw"
REPORT_DIR = BASE / "reports/mailmanager"
REPORT_DIR.mkdir(parents=True, exist_ok=True)

TOKEN_FILE = Path.home() / ".openclaw/credentials/gmail-token.json"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
]

SEND_TELEGRAM = BASE / "tools/telegram/send-telegram.sh"

creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
service = build("gmail", "v1", credentials=creds)


def header(headers, name):
    return next((h["value"] for h in headers if h["name"].lower() == name.lower()), "")


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


def score(text, words):
    return sum(1 for w in words if w in text)


CATEGORIES = {
    "🚨 Urgent / Security": [
        "security", "suspicious", "password", "login", "verify", "verification",
        "code", "2fa", "unauthorized", "fraud", "locked", "alert", "breach"
    ],
    "✅ Action Needed": [
        "action required", "respond", "reply", "approve", "approval", "required",
        "deadline", "urgent", "please review", "signature", "confirm", "complete"
    ],
    "💵 Bills / Money": [
        "bill", "payment", "invoice", "statement", "due", "charge", "paid",
        "bank", "credit", "subscription", "renewal", "autopay", "balance"
    ],
    "📦 Orders / Receipts / Deliveries": [
        "order", "receipt", "shipped", "shipping", "delivery", "delivered",
        "tracking", "purchase", "return", "refund", "amazon", "tractor supply"
    ],
    "📅 Appointments / Calendar": [
        "appointment", "schedule", "meeting", "reservation", "calendar",
        "reminder", "visit", "therapy", "doctor", "dentist", "confirm appointment"
    ],
    "🏠 Home / Property / Utilities": [
        "oec", "electric", "fiber", "utility", "water", "internet", "home",
        "property", "service call", "maintenance", "pool", "spa", "hvac"
    ],
    "💼 Work / USPS / MTSC": [
        "usps", "mtsc", "service now", "servicenow", "oracle", "apex",
        "dr testing", "maintenance", "scorecard", "scrum", "qa", "cat"
    ],
    "👨‍👩‍👧 Personal / Family": [
        "family", "andrew", "andy", "graves", "wife", "daughter", "personal"
    ],
    "📰 Newsletters / Promotions": [
        "unsubscribe", "newsletter", "sale", "deal", "coupon", "promo",
        "promotion", "discount", "digest", "savings", "marketing", "offer"
    ],
}


def classify_email(text):
    scores = {}

    for category, words in CATEGORIES.items():
        scores[category] = score(text, words)

    best_category = max(scores, key=scores.get)

    if scores[best_category] == 0:
        return "👀 Worth Reviewing"

    if best_category == "📰 Newsletters / Promotions":
        other_scores = {k: v for k, v in scores.items() if k != best_category}
        if max(other_scores.values()) > 0:
            return max(other_scores, key=other_scores.get)

    return best_category


categories = {name: [] for name in CATEGORIES}
categories["👀 Worth Reviewing"] = []

results = service.users().messages().list(
    userId="me",
    labelIds=["INBOX"],
    q="is:unread newer_than:14d",
    maxResults=100
).execute()

messages = results.get("messages", [])

for msg in messages:
    detail = service.users().messages().get(
        userId="me",
        id=msg["id"],
        format="metadata",
        metadataHeaders=["Subject", "From", "Date"]
    ).execute()

    headers = detail.get("payload", {}).get("headers", [])

    subject = clean(header(headers, "Subject")) or "(No subject)"
    sender = clean(header(headers, "From")) or "(Unknown sender)"
    date = clean(header(headers, "Date"))
    snippet = clean(detail.get("snippet", ""))

    full_text = f"{sender} {subject} {snippet}".lower()
    category = classify_email(full_text)

    item = {
        "id": msg["id"],
        "subject": subject,
        "from": sender,
        "date": date,
        "snippet": snippet,
    }

    categories.setdefault(category, []).append(item)

    if category == "👀 Worth Reviewing":
        try:
            service.users().messages().modify(
                userId="me",
                id=msg["id"],
                body={"removeLabelIds": ["INBOX"]}
            ).execute()
            item["auto_archived"] = True
            item["archive_destination"] = "Gmail Archive / All Mail"
        except Exception as e:
            item["auto_archived"] = False
            item["archive_destination"] = f"Archive failed: {e}"

now = datetime.now()

lines = []
lines.append("📬 MailManager 2.0 Email Classification")
lines.append(now.strftime("%A, %B %d, %Y %I:%M %p"))
lines.append("")
lines.append(f"Unread inbox messages scanned from last 14 days: {len(messages)}")
lines.append("")

priority_order = [
    "🚨 Urgent / Security",
    "✅ Action Needed",
    "💵 Bills / Money",
    "📅 Appointments / Calendar",
    "📦 Orders / Receipts / Deliveries",
    "🏠 Home / Property / Utilities",
    "💼 Work / USPS / MTSC",
    "👨‍👩‍👧 Personal / Family",
    "👀 Worth Reviewing",
    "📰 Newsletters / Promotions",
]

priority_count = (
    len(categories.get("🚨 Urgent / Security", []))
    + len(categories.get("✅ Action Needed", []))
    + len(categories.get("💵 Bills / Money", []))
    + len(categories.get("📅 Appointments / Calendar", []))
)

urgent_count = len(categories.get("🚨 Urgent / Security", []))
action_count = len(categories.get("✅ Action Needed", []))

if urgent_count > 0 or priority_count >= 4:
    mail_status = "🔴 ACTION REQUIRED"
elif action_count > 0 or priority_count > 0:
    mail_status = "🟡 ATTENTION"
else:
    mail_status = "🟢 NORMAL"

lines.append(f"Status: {mail_status}")
lines.append(f"Priority Items Requiring Attention: {priority_count}")

worth_reviewing_items = categories.get("👀 Worth Reviewing", [])
auto_archived_items = [i for i in worth_reviewing_items if i.get("auto_archived")]

lines.append("")
lines.append("📦 Auto Archived")
lines.append(f"Category: 👀 Worth Reviewing")
lines.append(f"Action: Auto Archived")
lines.append(f"Destination: Gmail Archive / All Mail")
lines.append(f"Count: {len(auto_archived_items)}")
lines.append("")

for category in priority_order:
    items = categories.get(category, [])
    lines.append(f"{category}: {len(items)}")

# Full detail report stays saved to disk only.
detail_lines = []
detail_lines.append("📬 MailManager 2.0 Detailed Email Classification")
detail_lines.append(now.strftime("%A, %B %d, %Y %I:%M %p"))
detail_lines.append("")
detail_lines.append(f"Unread inbox messages scanned from last 14 days: {len(messages)}")
detail_lines.append("")
detail_lines.append(f"Status: {mail_status}")
detail_lines.append(f"Priority Items Requiring Attention: {priority_count}")
detail_lines.append("")

for category in priority_order:
    items = categories.get(category, [])

    detail_lines.append("=" * 48)
    detail_lines.append(f"{category}: {len(items)}")
    detail_lines.append("=" * 48)

    if not items:
        detail_lines.append("None found.")
        detail_lines.append("")
        continue

    for i, item in enumerate(items[:20], start=1):
        detail_lines.append(f"{i}. {item['subject']}")
        detail_lines.append(f"   From: {item['from']}")
        if item["snippet"]:
            detail_lines.append(f"   Summary: {item['snippet'][:240]}")
        detail_lines.append("")

report = "\n".join(lines)

report_file = REPORT_DIR / f"mailmanager2-classification-{now.strftime('%Y%m%d-%H%M%S')}.txt"
report_file.write_text("\n".join(detail_lines))

print(report)
print("")
print(f"Saved report: {report_file}")

telegram = "\n".join(lines)

if SEND_TELEGRAM.exists() and os.environ.get("MAILMANAGER_TELEGRAM", "1") == "1":
    subprocess.run([str(SEND_TELEGRAM), telegram], check=False)
