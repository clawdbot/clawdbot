from pathlib import Path
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

token_file = Path.home() / ".openclaw" / "credentials" / "gmail-token.json"

creds = Credentials.from_authorized_user_file(str(token_file), SCOPES)
service = build("gmail", "v1", credentials=creds)

results = service.users().messages().list(
    userId="me",
    labelIds=["INBOX"],
    q="is:unread",
    maxResults=10
).execute()

messages = results.get("messages", [])

print(f"Unread inbox messages found: {len(messages)}")

for msg in messages:
    detail = service.users().messages().get(
        userId="me",
        id=msg["id"],
        format="metadata",
        metadataHeaders=["Subject", "From", "Date"]
    ).execute()

    headers = detail.get("payload", {}).get("headers", [])
    subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(No subject)")
    sender = next((h["value"] for h in headers if h["name"] == "From"), "(Unknown sender)")
    date = next((h["value"] for h in headers if h["name"] == "Date"), "(No date)")

    print("\n----")
    print("From:", sender)
    print("Date:", date)
    print("Subject:", subject)
    print("Snippet:", detail.get("snippet", ""))
