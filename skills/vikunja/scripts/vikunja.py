#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "rich"]
# ///
"""
Vikunja CLI - Project and task management for One Point engagements.

Usage:
    vikunja.py projects                    # List projects
    vikunja.py project <id>                # Get project details
    vikunja.py tasks [--project ID]        # List tasks
    vikunja.py create-project <name>       # Create new project
    vikunja.py create-task <title> --project ID [--due DATE] [--priority N]
    vikunja.py complete <task_id>          # Mark task complete
    vikunja.py sync-twenty                 # Sync with Twenty CRM opportunities
"""

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Optional

import requests
from rich.console import Console
from rich.table import Table

console = Console()

# Config
VIKUNJA_URL = os.environ.get("VIKUNJA_URL", "https://projects.mollified.app")
VIKUNJA_USER = os.environ.get("VIKUNJA_USER", "steve@withagency.ai")
VIKUNJA_PASSWORD = os.environ.get("VIKUNJA_PASSWORD", "")

TWENTY_API_URL = os.environ.get("TWENTY_API_URL", "https://api.mollified.app")
TWENTY_API_TOKEN = os.environ.get("TWENTY_API_TOKEN", "")


class VikunjaClient:
    def __init__(self):
        self.base_url = VIKUNJA_URL
        self.token = None
        
    def login(self):
        """Authenticate and get token."""
        resp = requests.post(
            f"{self.base_url}/api/v1/login",
            json={"username": VIKUNJA_USER, "password": VIKUNJA_PASSWORD}
        )
        if resp.status_code != 200:
            console.print(f"[red]Login failed: {resp.text}[/red]")
            sys.exit(1)
        self.token = resp.json().get("token")
        return self.token
    
    def _headers(self):
        if not self.token:
            self.login()
        return {"Authorization": f"Bearer {self.token}"}
    
    def get_projects(self):
        """List all projects."""
        resp = requests.get(f"{self.base_url}/api/v1/projects", headers=self._headers())
        return resp.json()
    
    def get_project(self, project_id: int):
        """Get project details."""
        resp = requests.get(f"{self.base_url}/api/v1/projects/{project_id}", headers=self._headers())
        return resp.json()
    
    def create_project(self, title: str, description: str = ""):
        """Create a new project."""
        resp = requests.put(
            f"{self.base_url}/api/v1/projects",
            headers=self._headers(),
            json={"title": title, "description": description}
        )
        return resp.json()
    
    def get_tasks(self, project_id: Optional[int] = None):
        """List tasks, optionally filtered by project."""
        if project_id:
            resp = requests.get(
                f"{self.base_url}/api/v1/projects/{project_id}/tasks",
                headers=self._headers()
            )
        else:
            resp = requests.get(f"{self.base_url}/api/v1/tasks/all", headers=self._headers())
        return resp.json()
    
    def create_task(self, project_id: int, title: str, description: str = "", 
                    due_date: Optional[str] = None, priority: int = 0):
        """Create a task in a project."""
        data = {
            "title": title,
            "description": description,
            "priority": priority
        }
        if due_date:
            data["due_date"] = due_date
        
        resp = requests.put(
            f"{self.base_url}/api/v1/projects/{project_id}/tasks",
            headers=self._headers(),
            json=data
        )
        return resp.json()
    
    def complete_task(self, task_id: int):
        """Mark a task as complete."""
        resp = requests.post(
            f"{self.base_url}/api/v1/tasks/{task_id}",
            headers=self._headers(),
            json={"done": True}
        )
        return resp.json()


class TwentyClient:
    def __init__(self):
        self.base_url = TWENTY_API_URL
        self.token = TWENTY_API_TOKEN
    
    def _headers(self):
        return {"Authorization": f"Bearer {self.token}"}
    
    def get_opportunities(self):
        """Get all opportunities from Twenty."""
        resp = requests.get(f"{self.base_url}/rest/opportunities", headers=self._headers())
        data = resp.json()
        return data.get("data", {}).get("opportunities", [])
    
    def get_engagements(self):
        """Get all engagements from Twenty."""
        resp = requests.get(f"{self.base_url}/rest/engagements", headers=self._headers())
        data = resp.json()
        return data.get("data", {}).get("engagements", [])
    
    def get_communities(self):
        """Get all communities from Twenty."""
        resp = requests.get(f"{self.base_url}/rest/communities", headers=self._headers())
        data = resp.json()
        return data.get("data", {}).get("communities", [])
    
    def get_companies(self):
        """Get all companies from Twenty."""
        resp = requests.get(f"{self.base_url}/rest/companies", headers=self._headers())
        data = resp.json()
        return data.get("data", {}).get("companies", [])


def cmd_projects(args):
    """List all projects."""
    client = VikunjaClient()
    projects = client.get_projects()
    
    if args.json:
        print(json.dumps(projects, indent=2))
        return
    
    table = Table(title="Projects")
    table.add_column("ID", style="cyan")
    table.add_column("Title", style="green")
    table.add_column("Description")
    
    for p in projects:
        table.add_row(str(p["id"]), p["title"], p.get("description", "")[:50])
    
    console.print(table)


def cmd_project(args):
    """Get project details."""
    client = VikunjaClient()
    project = client.get_project(args.id)
    
    if args.json:
        print(json.dumps(project, indent=2))
        return
    
    console.print(f"[bold]{project['title']}[/bold]")
    console.print(f"ID: {project['id']}")
    console.print(f"Description: {project.get('description', 'N/A')}")


def cmd_tasks(args):
    """List tasks."""
    client = VikunjaClient()
    tasks = client.get_tasks(args.project)
    
    if args.json:
        print(json.dumps(tasks, indent=2))
        return
    
    table = Table(title="Tasks")
    table.add_column("ID", style="cyan")
    table.add_column("Title", style="green")
    table.add_column("Done", style="yellow")
    table.add_column("Due", style="red")
    table.add_column("Priority")
    
    for t in tasks:
        done = "✓" if t.get("done") else ""
        due = t.get("due_date", "")[:10] if t.get("due_date") else ""
        priority = str(t.get("priority", 0))
        table.add_row(str(t["id"]), t["title"], done, due, priority)
    
    console.print(table)


def cmd_create_project(args):
    """Create a new project."""
    client = VikunjaClient()
    project = client.create_project(args.name, args.description or "")
    console.print(f"[green]Created project:[/green] {project['title']} (ID: {project['id']})")


def cmd_create_task(args):
    """Create a new task."""
    client = VikunjaClient()
    task = client.create_task(
        args.project,
        args.title,
        args.description or "",
        args.due,
        args.priority or 0
    )
    console.print(f"[green]Created task:[/green] {task['title']} (ID: {task['id']})")


def cmd_complete(args):
    """Mark task complete."""
    client = VikunjaClient()
    task = client.complete_task(args.task_id)
    console.print(f"[green]Completed:[/green] {task['title']}")


def cmd_sync_twenty(args):
    """Sync Twenty engagements to Vikunja projects."""
    vikunja = VikunjaClient()
    twenty = TwentyClient()
    
    # Get existing Vikunja projects
    projects = vikunja.get_projects()
    project_titles = {p["title"]: p["id"] for p in projects}
    
    # Get Twenty engagements
    engagements = twenty.get_engagements()
    
    if not engagements:
        console.print("[yellow]No engagements found in Twenty CRM.[/yellow]")
        return
    
    console.print(f"[blue]Found {len(engagements)} engagements in Twenty[/blue]")
    
    created = 0
    for eng in engagements:
        name = eng.get("name", "Unnamed Engagement")
        
        if name in project_titles:
            console.print(f"[dim]Skipping (exists):[/dim] {name}")
            continue
        
        # Create project for this engagement
        project = vikunja.create_project(
            title=name,
            description=f"Twenty Engagement ID: {eng.get('id')}"
        )
        console.print(f"[green]Created project:[/green] {name}")
        created += 1
        
        # Add standard engagement tasks
        standard_tasks = [
            ("Kickoff Meeting", 3),
            ("Discovery Phase", 2),
            ("Milestone 1", 2),
            ("Milestone 2", 2),
            ("Final Delivery", 3),
            ("Retrospective", 1),
        ]
        
        for task_title, priority in standard_tasks:
            vikunja.create_task(project["id"], task_title, priority=priority)
        
        console.print(f"  → Added {len(standard_tasks)} standard tasks")
    
    console.print(f"\n[bold green]Created {created} new projects[/bold green]")


def main():
    parser = argparse.ArgumentParser(description="Vikunja Project Management")
    parser.add_argument("--json", action="store_true", help="JSON output")
    
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # projects
    p_projects = subparsers.add_parser("projects", help="List projects")
    p_projects.set_defaults(func=cmd_projects)
    
    # project
    p_project = subparsers.add_parser("project", help="Get project details")
    p_project.add_argument("id", type=int, help="Project ID")
    p_project.set_defaults(func=cmd_project)
    
    # tasks
    p_tasks = subparsers.add_parser("tasks", help="List tasks")
    p_tasks.add_argument("--project", type=int, help="Filter by project ID")
    p_tasks.set_defaults(func=cmd_tasks)
    
    # create-project
    p_create_proj = subparsers.add_parser("create-project", help="Create project")
    p_create_proj.add_argument("name", help="Project name")
    p_create_proj.add_argument("--description", "-d", help="Description")
    p_create_proj.set_defaults(func=cmd_create_project)
    
    # create-task
    p_create_task = subparsers.add_parser("create-task", help="Create task")
    p_create_task.add_argument("title", help="Task title")
    p_create_task.add_argument("--project", "-p", type=int, required=True, help="Project ID")
    p_create_task.add_argument("--description", "-d", help="Description")
    p_create_task.add_argument("--due", help="Due date (ISO format)")
    p_create_task.add_argument("--priority", type=int, help="Priority (0-5)")
    p_create_task.set_defaults(func=cmd_create_task)
    
    # complete
    p_complete = subparsers.add_parser("complete", help="Complete task")
    p_complete.add_argument("task_id", type=int, help="Task ID")
    p_complete.set_defaults(func=cmd_complete)
    
    # sync-twenty
    p_sync = subparsers.add_parser("sync-twenty", help="Sync with Twenty CRM")
    p_sync.set_defaults(func=cmd_sync_twenty)
    
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
