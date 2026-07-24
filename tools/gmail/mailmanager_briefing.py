from pathlib import Path
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose"
]
token_file = Path.home() / ".openclaw" / "credentials" / "gmail-token.json"

creds = Credentials.from_authorized_user_file(str(token_file), SCOPES)
service = build("gmail", "v1", credentials=creds)

results = service.users().messages().list(
    userId="me",
    labelIds=["INBOX"],
    q="is:unread",
    maxResults=20
).execute()

messages = results.get("messages", [])

important = []
newsletters = []
newsletter_keywords = [
    "unsubscribe",
    "promotion",
    "newsletter",
    "daily",
    "digest",
    "coupon",
    "sale",
    "savings",
    "off",
    "deal",
    "click here",
    "fewer emails",
    "job alerts",
    "substack",
    "donate",
    "give",
]

for msg in messages:
    detail = service.users().messages().get(
        userId="me",
        id=msg["id"],
        format="metadata",
        metadataHeaders=["Subject", "From"]
    ).execute()

    headers = detail.get("payload", {}).get("headers", [])

    subject = next((h["value"] for h in headers if h["name"] == "Subject"), "")
    sender = next((h["value"] for h in headers if h["name"] == "From"), "")

    snippet = detail.get("snippet", "").lower()

    item = {
        "subject": subject,
        "from": sender,
    }

    if any(k in snippet for k in newsletter_keywords):
        newsletters.append(item)
    else:
        important.append(item)

print("\n=== IMPORTANT ===")
for item in important:
    print(f"- {item['subject']} ({item['from']})")

print("\n=== NEWSLETTERS / PROMOTIONS ===")
for item in newsletters:
    print(f"- {item['subject']} ({item['from']})")
