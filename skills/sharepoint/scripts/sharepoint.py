#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["msal", "httpx", "rich"]
# ///
"""SharePoint/OneDrive CLI for One Point Partners via Microsoft Graph API."""

import argparse
import os
import json
import httpx
from msal import ConfidentialClientApplication
from rich.console import Console
from rich.table import Table
from rich import print as rprint

console = Console()

# Config from environment
TENANT_ID = os.environ.get("SHAREPOINT_TENANT_ID")
CLIENT_ID = os.environ.get("SHAREPOINT_CLIENT_ID")
CLIENT_SECRET = os.environ.get("SHAREPOINT_CLIENT_SECRET")

GRAPH_URL = "https://graph.microsoft.com/v1.0"
SCOPES = ["https://graph.microsoft.com/.default"]

def get_token() -> str:
    """Get access token using client credentials flow."""
    if not all([TENANT_ID, CLIENT_ID, CLIENT_SECRET]):
        raise ValueError("Missing SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, or SHAREPOINT_CLIENT_SECRET")
    
    app = ConfidentialClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        client_credential=CLIENT_SECRET
    )
    result = app.acquire_token_for_client(scopes=SCOPES)
    
    if "access_token" in result:
        return result["access_token"]
    else:
        raise ValueError(f"Auth failed: {result.get('error_description', result)}")

def graph_get(endpoint: str, token: str, params: dict = None) -> dict:
    """Make a GET request to Graph API."""
    headers = {"Authorization": f"Bearer {token}"}
    r = httpx.get(f"{GRAPH_URL}{endpoint}", headers=headers, params=params, timeout=30)
    if r.status_code == 200:
        return r.json()
    else:
        raise ValueError(f"Graph API error {r.status_code}: {r.text[:500]}")

def cmd_auth(args):
    """Test authentication."""
    try:
        token = get_token()
        rprint("[green]✓ Authentication successful![/green]")
        # Test with a simple call
        me = graph_get("/organization", token)
        org = me.get("value", [{}])[0]
        rprint(f"  Tenant: {org.get('displayName', 'Unknown')}")
        rprint(f"  Tenant ID: {TENANT_ID}")
    except Exception as e:
        rprint(f"[red]✗ Authentication failed: {e}[/red]")

def cmd_sites(args):
    """List SharePoint sites."""
    token = get_token()
    result = graph_get("/sites?search=*", token)
    sites = result.get("value", [])
    
    table = Table(title="SharePoint Sites")
    table.add_column("Name", style="bold")
    table.add_column("URL")
    table.add_column("Site ID", style="dim")
    
    for site in sites:
        table.add_row(
            site.get("displayName", "No name"),
            site.get("webUrl", ""),
            site.get("id", "")[:40] + "..."
        )
    console.print(table)

def cmd_drives(args):
    """List drives (document libraries)."""
    token = get_token()
    
    if args.site:
        endpoint = f"/sites/{args.site}/drives"
    else:
        endpoint = "/drives"
    
    result = graph_get(endpoint, token)
    drives = result.get("value", [])
    
    table = Table(title="Document Libraries")
    table.add_column("Name", style="bold")
    table.add_column("Drive ID", style="dim")
    table.add_column("Type")
    
    for drive in drives:
        table.add_row(
            drive.get("name", "No name"),
            drive.get("id", ""),
            drive.get("driveType", "")
        )
    console.print(table)

def cmd_list(args):
    """List files in a drive/folder."""
    token = get_token()
    
    if args.path:
        endpoint = f"/drives/{args.drive}/root:/{args.path}:/children"
    else:
        endpoint = f"/drives/{args.drive}/root/children"
    
    result = graph_get(endpoint, token)
    items = result.get("value", [])
    
    table = Table(title=f"Files in {args.path or 'root'}")
    table.add_column("Name", style="bold")
    table.add_column("Type")
    table.add_column("Size")
    table.add_column("Modified")
    table.add_column("ID", style="dim")
    
    for item in items:
        item_type = "📁 Folder" if "folder" in item else "📄 File"
        size = item.get("size", 0)
        size_str = f"{size:,}" if size else "-"
        modified = item.get("lastModifiedDateTime", "")[:10]
        
        table.add_row(
            item.get("name", ""),
            item_type,
            size_str,
            modified,
            item.get("id", "")[:20] + "..."
        )
    console.print(table)

def cmd_search(args):
    """Search for files."""
    token = get_token()
    query = " ".join(args.query)
    
    # Use Graph Search API
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {
        "requests": [{
            "entityTypes": ["driveItem"],
            "query": {"queryString": query},
            "from": 0,
            "size": args.limit,
            "region": "US"
        }]
    }
    
    r = httpx.post(f"{GRAPH_URL}/search/query", headers=headers, json=body, timeout=30)
    if r.status_code != 200:
        rprint(f"[red]Search failed: {r.text[:200]}[/red]")
        return
    
    result = r.json()
    hits = result.get("value", [{}])[0].get("hitsContainers", [{}])[0].get("hits", [])
    
    table = Table(title=f"Search: {query}")
    table.add_column("Name", style="bold")
    table.add_column("Path")
    table.add_column("Modified")
    
    for hit in hits:
        resource = hit.get("resource", {})
        name = resource.get("name", "Unknown")
        parent = resource.get("parentReference", {}).get("path", "")
        modified = resource.get("lastModifiedDateTime", "")[:10]
        table.add_row(name, parent[-50:] if len(parent) > 50 else parent, modified)
    
    console.print(table)
    rprint(f"\n[dim]Found {len(hits)} results[/dim]")

def cmd_download(args):
    """Download a file."""
    token = get_token()
    
    # Get download URL
    endpoint = f"/drives/{args.drive}/items/{args.item_id}"
    item = graph_get(endpoint, token)
    
    download_url = item.get("@microsoft.graph.downloadUrl")
    if not download_url:
        rprint("[red]No download URL available[/red]")
        return
    
    filename = args.output or item.get("name", "download")
    
    rprint(f"Downloading {item.get('name')}...")
    r = httpx.get(download_url, timeout=60)
    
    with open(filename, "wb") as f:
        f.write(r.content)
    
    rprint(f"[green]✓ Saved to {filename}[/green]")

def main():
    parser = argparse.ArgumentParser(description="SharePoint/OneDrive CLI")
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # Auth
    subparsers.add_parser("auth", help="Test authentication")
    
    # Sites
    subparsers.add_parser("sites", help="List SharePoint sites")
    
    # Drives
    drives_p = subparsers.add_parser("drives", help="List drives/document libraries")
    drives_p.add_argument("--site", help="Site ID (optional)")
    
    # List
    list_p = subparsers.add_parser("list", help="List files")
    list_p.add_argument("drive", help="Drive ID")
    list_p.add_argument("--path", help="Folder path")
    
    # Search
    search_p = subparsers.add_parser("search", help="Search files")
    search_p.add_argument("query", nargs="+", help="Search query")
    search_p.add_argument("-n", "--limit", type=int, default=25, help="Max results")
    
    # Download
    dl_p = subparsers.add_parser("download", help="Download a file")
    dl_p.add_argument("drive", help="Drive ID")
    dl_p.add_argument("item_id", help="Item ID")
    dl_p.add_argument("-o", "--output", help="Output filename")
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        return
    
    commands = {
        "auth": cmd_auth,
        "sites": cmd_sites,
        "drives": cmd_drives,
        "list": cmd_list,
        "search": cmd_search,
        "download": cmd_download,
    }
    
    try:
        commands[args.command](args)
    except Exception as e:
        rprint(f"[red]Error: {e}[/red]")

if __name__ == "__main__":
    main()
