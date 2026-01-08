#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "rich"]
# ///
"""Hacker News CLI - Browse HN stories and comments."""

import argparse
import httpx
from rich.console import Console
from rich.table import Table
from rich import print as rprint
from html import unescape
import re

console = Console()
BASE_URL = "https://hacker-news.firebaseio.com/v0"
ALGOLIA_URL = "https://hn.algolia.com/api/v1"

def strip_html(text: str) -> str:
    """Remove HTML tags and decode entities."""
    if not text:
        return ""
    text = re.sub(r'<[^>]+>', '', text)
    return unescape(text)

def fetch_item(item_id: int) -> dict:
    """Fetch a single item (story, comment, etc)."""
    r = httpx.get(f"{BASE_URL}/item/{item_id}.json", timeout=10)
    return r.json() if r.status_code == 200 else {}

def fetch_stories(endpoint: str, limit: int = 10) -> list[dict]:
    """Fetch stories from an endpoint."""
    r = httpx.get(f"{BASE_URL}/{endpoint}.json", timeout=10)
    if r.status_code != 200:
        return []
    ids = r.json()[:limit]
    stories = []
    for i in ids:
        item = fetch_item(i)
        if item:
            stories.append(item)
    return stories

def display_stories(stories: list[dict], title: str):
    """Display stories in a table."""
    table = Table(title=title, show_lines=False)
    table.add_column("#", style="dim", width=3)
    table.add_column("Pts", style="green", width=5)
    table.add_column("Title", style="bold")
    table.add_column("Comments", style="cyan", width=5)
    table.add_column("ID", style="dim", width=10)
    
    for i, s in enumerate(stories, 1):
        table.add_row(
            str(i),
            str(s.get('score', 0)),
            s.get('title', 'No title')[:70],
            str(s.get('descendants', 0)),
            str(s.get('id', ''))
        )
    console.print(table)

def display_story(story: dict, comment_limit: int = 10):
    """Display a story with comments."""
    rprint(f"\n[bold]{story.get('title', 'No title')}[/bold]")
    rprint(f"[green]{story.get('score', 0)} points[/green] by [cyan]{story.get('by', 'unknown')}[/cyan]")
    if story.get('url'):
        rprint(f"[blue]{story.get('url')}[/blue]")
    if story.get('text'):
        rprint(f"\n{strip_html(story.get('text'))}")
    
    kids = story.get('kids', [])[:comment_limit]
    if kids:
        rprint(f"\n[bold]Top {len(kids)} comments:[/bold]\n")
        for kid_id in kids:
            comment = fetch_item(kid_id)
            if comment and comment.get('text'):
                author = comment.get('by', 'unknown')
                text = strip_html(comment.get('text', ''))[:500]
                rprint(f"[cyan]{author}[/cyan]: {text}\n")

def search_stories(query: str, limit: int = 10):
    """Search HN via Algolia."""
    r = httpx.get(f"{ALGOLIA_URL}/search", params={"query": query, "hitsPerPage": limit}, timeout=10)
    if r.status_code != 200:
        rprint("[red]Search failed[/red]")
        return
    
    hits = r.json().get('hits', [])
    table = Table(title=f"Search: {query}", show_lines=False)
    table.add_column("#", style="dim", width=3)
    table.add_column("Pts", style="green", width=5)
    table.add_column("Title", style="bold")
    table.add_column("ID", style="dim", width=10)
    
    for i, h in enumerate(hits, 1):
        table.add_row(
            str(i),
            str(h.get('points', 0) or 0),
            (h.get('title') or 'No title')[:70],
            str(h.get('objectID', ''))
        )
    console.print(table)

def main():
    parser = argparse.ArgumentParser(description="Hacker News CLI")
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # Feed commands
    for feed in ['top', 'new', 'best', 'ask', 'show', 'jobs']:
        p = subparsers.add_parser(feed, help=f"{feed.title()} stories")
        p.add_argument('-n', '--limit', type=int, default=10, help='Number of stories')
    
    # Story command
    story_p = subparsers.add_parser('story', help='Get story details')
    story_p.add_argument('id', type=int, help='Story ID')
    story_p.add_argument('--comments', type=int, default=10, help='Number of comments')
    
    # Search command
    search_p = subparsers.add_parser('search', help='Search stories')
    search_p.add_argument('query', nargs='+', help='Search query')
    search_p.add_argument('-n', '--limit', type=int, default=10, help='Max results')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return
    
    endpoints = {
        'top': 'topstories',
        'new': 'newstories', 
        'best': 'beststories',
        'ask': 'askstories',
        'show': 'showstories',
        'jobs': 'jobstories'
    }
    
    if args.command in endpoints:
        stories = fetch_stories(endpoints[args.command], args.limit)
        display_stories(stories, f"HN {args.command.title()}")
    elif args.command == 'story':
        story = fetch_item(args.id)
        if story:
            display_story(story, args.comments)
        else:
            rprint("[red]Story not found[/red]")
    elif args.command == 'search':
        search_stories(' '.join(args.query), args.limit)

if __name__ == "__main__":
    main()
