from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]

creds_file = Path.home() / ".openclaw" / "credentials" / "gmail-oauth.json"
token_file = Path.home() / ".openclaw" / "credentials" / "calendar-token.json"

flow = InstalledAppFlow.from_client_secrets_file(str(creds_file), SCOPES)

creds = flow.run_local_server(
    host="127.0.0.1",
    port=8081,
    open_browser=False,
    access_type="offline",
    prompt="consent"
)

token_file.write_text(creds.to_json())
token_file.chmod(0o600)

print("Calendar authorization complete.")
print(f"Token saved to: {token_file}")
