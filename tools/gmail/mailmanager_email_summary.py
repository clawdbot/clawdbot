from pathlib import Path
import base64
from email.mime.text import MIMEText
from datetime import datetime
import subprocess

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send"
]

MY_EMAIL = "gravesab@gmail.com"

token_file = Path.home() / ".openclaw" / "credentials" / "gmail-token.json"

creds = Credentials.from_authorized_user_file(str(token_file), SCOPES)
service = build("gmail", "v1", credentials=creds)

results = service.users().messages().list(
    userId="me",
    labelIds=["INBOX"],
    q="is:unread",
    maxResults=25
).execute()

messages = results.get("messages", [])

promo_words = [
    "survey",
    "reward",
    "rewards",
    "catering",
    "stock trader",
    "waste money",
    "black friday",
    "sale",
    "ebook",
    "daily digest",
    "daily inspiration",
    "tip of the day",
    "clearance",
    "markdown",
    "unsubscribe",
    "promotion",
    "coupon",
    "deals",
    "weekend sale",
    "bogo",
    "free shipping",
    "special offer",
]

action_words = [
    "invoice",
    "bill",
    "payment",
    "due",
    "appointment",
    "confirm",
    "confirmation",
    "receipt",
    "statement",
    "security",
    "password",
    "alert",
    "urgent",
    "verify",
    "renewal",
    "service",
    "delivery",
]

review = []
action = []
promos = []

for msg in messages:
    detail = service.users().messages().get(
        userId="me",
        id=msg["id"],
        format="metadata",
        metadataHeaders=["Subject", "From", "Date"]
    ).execute()

    headers = detail.get("payload", {}).get("headers", [])

    subject = next((h["value"] for h in headers if h["name"] == "Subject"), "")
    sender = next((h["value"] for h in headers if h["name"] == "From"), "")
    date = next((h["value"] for h in headers if h["name"] == "Date"), "")
    snippet = detail.get("snippet", "")

    text = f"{sender} {subject} {snippet}".lower()

    item = {
        "from": sender,
        "subject": subject,
        "date": date,
        "snippet": snippet
    }

    if any(w in text for w in action_words):
        action.append(item)
    elif any(w in text for w in promo_words):
        promos.append(item)
    else:
        review.append(item)

lines = []

lines.append("MailManager Daily Email Summary")
lines.append(datetime.now().strftime("%A, %B %d, %Y %I:%M %p"))
lines.append("")

lines.append(f"Unread messages scanned: {len(messages)}")
lines.append(f"Action items: {len(action)}")
lines.append(f"Worth reviewing: {len(review)}")
lines.append(f"Promotions/newsletters filtered: {len(promos)}")
lines.append("")

def add_section(title, items):
    lines.append("=" * 60)
    lines.append(title)
    lines.append("=" * 60)

    if not items:
        lines.append("None found.")
        lines.append("")
        return

    for i, item in enumerate(items, start=1):
        lines.append(f"{i}. {item['subject']}")
        lines.append(f"   From: {item['from']}")

        if item["date"]:
            lines.append(f"   Date: {item['date']}")

        if item["snippet"]:
            lines.append(f"   Summary: {item['snippet']}")

        lines.append("")

add_section("ACTION ITEMS", action)
add_section("WORTH REVIEWING", review)
add_section("FILTERED PROMOTIONS / NEWSLETTERS", promos[:10])

body = "\n".join(lines)

message = MIMEText(body)

message["to"] = MY_EMAIL
message["from"] = MY_EMAIL
message["subject"] = "MailManager Daily Summary"

raw = base64.urlsafe_b64encode(message.as_bytes()).decode()

sent = service.users().messages().send(
    userId="me",
    body={"raw": raw}
).execute()

print("Summary email sent successfully.")
print("Message ID:", sent["id"])

subprocess.run([
    "/home/gravesab/ai/projects/openclaw/tools/memory/.venv/bin/python3",
    "/home/gravesab/ai/projects/openclaw/tools/memory/memory_add_custom.py",
    "MailManager",
    "gmail_summary",
    body,
    "daily_email_summary"
])

print("Memory storage requested.")

subprocess.run([
    "/home/gravesab/ai/projects/openclaw/tools/bus/.venv/bin/python3",
    "/home/gravesab/ai/projects/openclaw/tools/bus/publish_event.py",
    "MailManager",
    "gmail_summary_sent",
    "MailManager sent the daily Gmail summary email and saved it to long-term memory."
])

print("Redis event published.")
