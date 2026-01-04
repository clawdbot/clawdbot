#!/usr/bin/env python3
"""
Granola meeting sync script.
Fetches all meetings from the Granola API and saves them locally.

Usage:
    python sync.py [output_dir]

The script reads auth tokens from:
    ~/Library/Application Support/Granola/supabase.json

Output structure:
    output_dir/
        {meeting_id}/
            metadata.json   - title, date, attendees
            transcript.md   - formatted transcript
            transcript.json - raw transcript data
            document.json   - full API response
            notes.md        - AI summary (if available)
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import requests

# Paths
SUPABASE_PATH = Path.home() / "Library/Application Support/Granola/supabase.json"
DEFAULT_OUTPUT = Path.home() / "granola-meetings"
API_BASE = "https://api.granola.ai/v1"


def get_token():
    """Get access token from Granola's local auth file."""
    if not SUPABASE_PATH.exists():
        print(f"Error: Auth file not found at {SUPABASE_PATH}")
        print("Make sure Granola is installed and you're signed in.")
        sys.exit(1)
    
    with open(SUPABASE_PATH) as f:
        data = json.load(f)
    
    tokens = json.loads(data.get("workos_tokens", "{}"))
    token = tokens.get("access_token")
    
    if not token:
        print("Error: No access token found. Try signing into Granola again.")
        sys.exit(1)
    
    # Check expiration
    obtained_at = tokens.get("obtained_at", 0) / 1000  # ms to seconds
    expires_in = tokens.get("expires_in", 0)
    if datetime.now().timestamp() > obtained_at + expires_in:
        print("Warning: Token may be expired. Open Granola to refresh.")
    
    return token


def fetch_documents(token, limit=500):
    """Fetch documents from Granola API."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    response = requests.post(
        f"{API_BASE}/get-documents",
        headers=headers,
        json={"limit": limit}
    )
    response.raise_for_status()
    return response.json()


def fetch_document_metadata(token, doc_id):
    """Fetch document metadata."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    response = requests.post(
        f"{API_BASE}/get-document-metadata",
        headers=headers,
        json={"document_id": doc_id}
    )
    if response.ok:
        return response.json()
    return {}


def fetch_document_transcript(token, doc_id):
    """Fetch document transcript."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    response = requests.post(
        f"{API_BASE}/get-document-transcript",
        headers=headers,
        json={"document_id": doc_id}
    )
    if response.ok:
        return response.json()
    return []


def format_transcript(doc, transcript_data=None):
    """Format transcript as readable markdown."""
    lines = []
    
    # Header
    lines.append(f"# {doc.get('title', 'Untitled Meeting')}")
    created = doc.get('created_at', 'Unknown')
    lines.append(f"\n**Date:** {created[:10] if created else 'Unknown'}")
    
    # Attendees - handle both dict and list formats
    people = doc.get("people", {})
    names = []
    if isinstance(people, dict):
        # New format: {creator: {...}, attendees: [...]}
        creator = people.get("creator", {})
        if creator.get("name"):
            names.append(creator["name"])
        for att in people.get("attendees", []):
            if isinstance(att, dict) and att.get("name"):
                names.append(att["name"])
            elif isinstance(att, str):
                names.append(att)
    elif isinstance(people, list):
        # Old format: [{name, email}, ...]
        names = [p.get("name", p.get("email", "Unknown")) for p in people if isinstance(p, dict)]
    
    if names:
        lines.append(f"**Attendees:** {', '.join(names)}")
    
    lines.append("\n---\n")
    
    # Use provided transcript data if available, otherwise fall back to doc
    transcript = transcript_data if transcript_data else (doc.get("transcript") or [])
    
    if not transcript:
        # Try chapters from doc
        chapters = doc.get("chapters") or []
        for chapter in chapters:
            if chapter.get("title"):
                lines.append(f"\n## {chapter['title']}\n")
            for segment in chapter.get("transcript", []):
                speaker = segment.get("speaker", "Unknown")
                text = segment.get("text", "")
                lines.append(f"**{speaker}:** {text}\n")
    else:
        # Handle transcript as list of segments
        if isinstance(transcript, list):
            for segment in transcript:
                if isinstance(segment, dict):
                    speaker = segment.get("speaker", "Unknown")
                    text = segment.get("text", "")
                    lines.append(f"**{speaker}:** {text}\n")
    
    return "\n".join(lines)


def save_meeting(doc, output_dir, token=None):
    """Save a single meeting to disk."""
    meeting_id = doc.get("id")
    if not meeting_id:
        return
    
    meeting_dir = output_dir / meeting_id
    meeting_dir.mkdir(parents=True, exist_ok=True)
    
    # Fetch additional data if token provided
    transcript_data = None
    if token:
        try:
            transcript_data = fetch_document_transcript(token, meeting_id)
        except Exception as e:
            print(f"    Warning: Could not fetch transcript: {e}")
    
    # Metadata
    metadata = {
        "id": meeting_id,
        "title": doc.get("title"),
        "created_at": doc.get("created_at"),
        "updated_at": doc.get("updated_at"),
        "people": doc.get("people"),
        "calendar_event": doc.get("google_calendar_event"),
    }
    with open(meeting_dir / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)
    
    # Transcript markdown
    with open(meeting_dir / "transcript.md", "w") as f:
        f.write(format_transcript(doc, transcript_data))
    
    # Raw transcript JSON
    transcript = transcript_data or doc.get("transcript") or doc.get("chapters", [])
    with open(meeting_dir / "transcript.json", "w") as f:
        json.dump(transcript, f, indent=2)
    
    # Full document
    with open(meeting_dir / "document.json", "w") as f:
        json.dump(doc, f, indent=2)
    
    # Notes/summary if available
    notes = doc.get("notes_markdown") or doc.get("notes_plain")
    if notes:
        with open(meeting_dir / "notes.md", "w") as f:
            f.write(notes)


def main():
    output_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUTPUT
    output_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"Syncing Granola meetings to {output_dir}")
    
    token = get_token()
    
    print("Fetching documents from API...")
    docs = fetch_documents(token)
    
    print(f"Found {len(docs)} meetings")
    
    for i, doc in enumerate(docs, 1):
        title = doc.get("title", "Untitled")[:50]
        print(f"  [{i}/{len(docs)}] {title}")
        save_meeting(doc, output_dir, token)
    
    print(f"\nDone! Meetings saved to {output_dir}")


if __name__ == "__main__":
    main()
