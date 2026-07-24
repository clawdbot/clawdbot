from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from pathlib import Path

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send"
]

creds_file = Path.home() / ".openclaw" / "credentials" / "gmail-oauth.json"
token_file = Path.home() / ".openclaw" / "credentials" / "gmail-token.json"

flow = InstalledAppFlow.from_client_secrets_file(str(creds_file), SCOPES)

creds = flow.run_local_server(
    host="127.0.0.1",
    port=8081,
    open_browser=False,
    access_type="offline",
    prompt="consent"
)

token_file.write_text(creds.to_json())

service = build("gmail", "v1", credentials=creds)

results = service.users().messages().list(
    userId="me",
    labelIds=["INBOX"],
    maxResults=5
).execute()

messages = results.get("messages", [])

print(f"Found {len(messages)} recent inbox messages.")
for msg in messages:
    detail = service.users().messages().get(
        userId="me",
        id=msg["id"],
        format="metadata",
        metadataHeaders=["Subject", "From"]
    ).execute()

    headers = detail.get("payload", {}).get("headers", [])
    subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(No subject)")
    sender = next((h["value"] for h in headers if h["name"] == "From"), "(Unknown sender)")

    print("----")
    print("From:", sender)
    print("Subject:", subject)
