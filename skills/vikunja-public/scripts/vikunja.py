#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "rich"]
# ///
"""
Vikunja CLI - Open-source project and task management.

Usage:
    vikunja.py projects                    # List projects
    vikunja.py project <id>                # Get project details
    vikunja.py tasks [--project ID]        # List tasks
    vikunja.py create-project <name>       # Create new project
    vikunja.py create-task <title> --project ID [--due DATE] [--priority N]
    vikunja.py complete <task_id>          # Mark task complete

Environment:
    VIKUNJA_URL      - Vikunja instance URL (required)
    VIKUNJA_USER     - Username or email (required)
    VIKUNJA_PASSWORD - Password (required)
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

# Config from environment
VIKUNJA_URL = os.environ.get("VIKUNJA_URL", "")
VIKUNJA_USER = os.environ.get("VIKUNJA_USER", "")
VIKUNJA_PASSWORD = os.environ.get("VIKUNJA_PASSWORD", "")


def check_config():
    """Verify required environment variables are set."""
    missing = []
    if not VIKUNJA_URL:
        missing.append("VIKUNJA_URL")
    if not VIKUNJA_USER:
        missing.append("VIKUNJA_USER")
    if not VIKUNJA_PASSWORD:
        missing.append("VIKUNJA_PASSWORD")
    
    if missing:
        console.print(f"[red]Missing required environment variables: {', '.join(missing)}[/red]")
        console.print("[dim]Set these before running the script.[/dim]")
        sys.exit(1)


class VikunjaClient:
    def __init__(self):
        check_config()
        self.base_url = VIKUNJA_URL.rstrip("/")
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
            # Convert to ISO format with time
            data["due_date"] = f"{due_date}T23:59:59Z"
        
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
    table.add_column("Tasks", style="yellow")
    
    for p in projects:
        table.add_row(str(p["id"]), p["title"], str(p.get("task_count", 0)))
    
    console.print(table)


def cmd_project(args):
    """Get project details."""
    client = VikunjaClient()
    project = client.get_project(args.id)
    
    if args.json:
        print(json.dumps(project, indent=2))
        return
    
    console.print(f"[bold]{project['title']}[/bold] (ID: {project['id']})")
    if project.get("description"):
        console.print(f"[dim]{project['description']}[/dim]")
    
    # Get tasks in this project
    tasks = client.get_tasks(args.id)
    if tasks:
        console.print(f"\n[yellow]Tasks ({len(tasks)}):[/yellow]")
        for t in tasks:
            done = "✓" if t.get("done") else "○"
            console.print(f"  {done} {t['title']}")


def cmd_tasks(args):
    """List tasks."""
    client = VikunjaClient()
    tasks = client.get_tasks(args.project)
    
    if args.json:
        print(json.dumps(tasks, indent=2))
        return
    
    title = f"Tasks (Project {args.project})" if args.project else "All Tasks"
    table = Table(title=title)
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
    p_create_task.add_argument("--due", help="Due date (YYYY-MM-DD)")
    p_create_task.add_argument("--priority", type=int, help="Priority (0-5)")
    p_create_task.set_defaults(func=cmd_create_task)
    
    # complete
    p_complete = subparsers.add_parser("complete", help="Complete task")
    p_complete.add_argument("task_id", type=int, help="Task ID")
    p_complete.set_defaults(func=cmd_complete)
    
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
