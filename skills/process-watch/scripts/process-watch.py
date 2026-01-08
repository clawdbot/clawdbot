#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["psutil", "rich", "typer"]
# ///
"""
Process Watch - Comprehensive system process monitoring.
"""

import signal
import sys
import time
from datetime import datetime
from typing import Optional

import psutil
import typer
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

app = typer.Typer(help="Process Watch - monitor system processes, resources, and ports")
console = Console()


def format_bytes(b: float) -> str:
    """Format bytes to human readable."""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(b) < 1024:
            return f"{b:.1f}{unit}"
        b /= 1024
    return f"{b:.1f}PB"


def format_time(seconds: float) -> str:
    """Format seconds to human readable."""
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds/60:.0f}m"
    if seconds < 86400:
        return f"{seconds/3600:.1f}h"
    return f"{seconds/86400:.1f}d"


def get_process_info(proc: psutil.Process) -> dict:
    """Get comprehensive process info safely."""
    try:
        with proc.oneshot():
            info = {
                "pid": proc.pid,
                "name": proc.name(),
                "cpu": proc.cpu_percent(),
                "mem": proc.memory_percent(),
                "mem_bytes": proc.memory_info().rss,
                "status": proc.status(),
                "user": proc.username(),
                "created": proc.create_time(),
            }
            try:
                info["cmdline"] = " ".join(proc.cmdline())[:80]
            except (psutil.AccessDenied, psutil.ZombieProcess):
                info["cmdline"] = ""
            try:
                io = proc.io_counters()
                info["read_bytes"] = io.read_bytes
                info["write_bytes"] = io.write_bytes
            except (psutil.AccessDenied, AttributeError, psutil.ZombieProcess):
                info["read_bytes"] = 0
                info["write_bytes"] = 0
            return info
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return None


@app.command()
def list_procs(
    sort: str = typer.Option("cpu", "--sort", "-s", help="Sort by: cpu, mem, disk, name, pid"),
    limit: int = typer.Option(25, "--limit", "-l", help="Number of processes to show"),
    all_procs: bool = typer.Option(False, "--all", "-a", help="Show all processes"),
):
    """List running processes with resource usage."""
    # First pass to init CPU measurement
    for proc in psutil.process_iter():
        try:
            proc.cpu_percent()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    
    time.sleep(0.1)  # Brief pause for CPU measurement
    
    procs = []
    for proc in psutil.process_iter():
        info = get_process_info(proc)
        if info:
            procs.append(info)
    
    # Sort
    sort_keys = {
        "cpu": lambda x: x["cpu"],
        "mem": lambda x: x["mem"],
        "disk": lambda x: x["read_bytes"] + x["write_bytes"],
        "name": lambda x: x["name"].lower(),
        "pid": lambda x: x["pid"],
    }
    procs.sort(key=sort_keys.get(sort, sort_keys["cpu"]), reverse=sort != "name")
    
    if not all_procs:
        procs = procs[:limit]
    
    table = Table(title=f"Processes (sorted by {sort})")
    table.add_column("PID", style="cyan", justify="right")
    table.add_column("Name", style="bold")
    table.add_column("CPU%", justify="right")
    table.add_column("Mem%", justify="right")
    table.add_column("Memory", justify="right")
    table.add_column("User", style="dim")
    table.add_column("Command", style="dim", max_width=40)
    
    for p in procs:
        cpu_style = "red" if p["cpu"] > 50 else "yellow" if p["cpu"] > 20 else ""
        mem_style = "red" if p["mem"] > 10 else "yellow" if p["mem"] > 5 else ""
        table.add_row(
            str(p["pid"]),
            p["name"][:20],
            f"[{cpu_style}]{p['cpu']:.1f}[/]",
            f"[{mem_style}]{p['mem']:.1f}[/]",
            format_bytes(p["mem_bytes"]),
            p["user"][:10],
            p["cmdline"][:40] if p["cmdline"] else "-",
        )
    
    console.print(table)


@app.command()
def top(
    type_: str = typer.Option("cpu", "--type", "-t", help="Resource type: cpu, mem, disk"),
    limit: int = typer.Option(10, "--limit", "-l", help="Number of processes"),
):
    """Show top resource consumers."""
    # Init CPU
    for proc in psutil.process_iter():
        try:
            proc.cpu_percent()
        except:
            pass
    time.sleep(0.2)
    
    procs = []
    for proc in psutil.process_iter():
        info = get_process_info(proc)
        if info:
            procs.append(info)
    
    sort_keys = {
        "cpu": lambda x: x["cpu"],
        "mem": lambda x: x["mem"],
        "disk": lambda x: x["read_bytes"] + x["write_bytes"],
    }
    procs.sort(key=sort_keys.get(type_, sort_keys["cpu"]), reverse=True)
    procs = procs[:limit]
    
    title = {"cpu": "🔥 Top CPU Consumers", "mem": "🧠 Top Memory Consumers", "disk": "💾 Top Disk I/O"}
    
    table = Table(title=title.get(type_, f"Top by {type_}"))
    table.add_column("PID", style="cyan", justify="right")
    table.add_column("Name", style="bold")
    
    if type_ == "cpu":
        table.add_column("CPU%", justify="right", style="red")
    elif type_ == "mem":
        table.add_column("Mem%", justify="right")
        table.add_column("Memory", justify="right", style="red")
    else:
        table.add_column("Read", justify="right")
        table.add_column("Write", justify="right", style="red")
    
    table.add_column("User", style="dim")
    
    for p in procs:
        if type_ == "cpu":
            table.add_row(str(p["pid"]), p["name"], f"{p['cpu']:.1f}%", p["user"])
        elif type_ == "mem":
            table.add_row(str(p["pid"]), p["name"], f"{p['mem']:.1f}%", format_bytes(p["mem_bytes"]), p["user"])
        else:
            table.add_row(str(p["pid"]), p["name"], format_bytes(p["read_bytes"]), format_bytes(p["write_bytes"]), p["user"])
    
    console.print(table)


@app.command()
def info(pid: int = typer.Argument(..., help="Process ID")):
    """Get detailed info about a specific process."""
    try:
        proc = psutil.Process(pid)
    except psutil.NoSuchProcess:
        console.print(f"[red]Process {pid} not found[/red]")
        raise typer.Exit(1)
    
    try:
        proc.cpu_percent()
        time.sleep(0.1)
        
        with proc.oneshot():
            name = proc.name()
            cmdline = " ".join(proc.cmdline()) or "-"
            cpu = proc.cpu_percent()
            mem = proc.memory_info()
            status = proc.status()
            user = proc.username()
            created = datetime.fromtimestamp(proc.create_time())
            parent = proc.parent()
            children = proc.children()
            
            # Panel with basic info
            info_text = f"""[bold]Name:[/bold] {name}
[bold]PID:[/bold] {pid}
[bold]Status:[/bold] {status}
[bold]User:[/bold] {user}
[bold]Started:[/bold] {created.strftime('%Y-%m-%d %H:%M:%S')}
[bold]Parent:[/bold] {parent.pid if parent else 'None'} ({parent.name() if parent else ''})
[bold]Children:[/bold] {len(children)}

[bold]CPU:[/bold] {cpu:.1f}%
[bold]Memory:[/bold] {format_bytes(mem.rss)} ({mem.rss / psutil.virtual_memory().total * 100:.1f}%)
[bold]Virtual:[/bold] {format_bytes(mem.vms)}

[bold]Command:[/bold]
{cmdline[:200]}"""
            
            console.print(Panel(info_text, title=f"Process {pid}: {name}"))
            
            # Open files
            try:
                files = proc.open_files()
                if files:
                    console.print(f"\n[bold]Open Files ({len(files)}):[/bold]")
                    for f in files[:10]:
                        console.print(f"  {f.path}")
                    if len(files) > 10:
                        console.print(f"  ... and {len(files) - 10} more")
            except psutil.AccessDenied:
                console.print("\n[dim]Open files: Access denied[/dim]")
            
            # Network connections
            try:
                conns = proc.net_connections()
                if conns:
                    console.print(f"\n[bold]Network Connections ({len(conns)}):[/bold]")
                    for c in conns[:10]:
                        local = f"{c.laddr.ip}:{c.laddr.port}" if c.laddr else "-"
                        remote = f"{c.raddr.ip}:{c.raddr.port}" if c.raddr else "-"
                        console.print(f"  {c.status:12} {local:25} → {remote}")
                    if len(conns) > 10:
                        console.print(f"  ... and {len(conns) - 10} more")
            except psutil.AccessDenied:
                console.print("\n[dim]Network connections: Access denied[/dim]")
            
            # Children
            if children:
                console.print(f"\n[bold]Child Processes ({len(children)}):[/bold]")
                for child in children[:10]:
                    try:
                        console.print(f"  {child.pid}: {child.name()}")
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                        
    except psutil.AccessDenied:
        console.print(f"[red]Access denied to process {pid}[/red]")
        raise typer.Exit(1)


@app.command()
def find(name: str = typer.Argument(..., help="Process name to search")):
    """Find processes by name."""
    found = []
    for proc in psutil.process_iter(['pid', 'name', 'cmdline', 'cpu_percent', 'memory_percent']):
        try:
            pname = proc.info['name'].lower()
            cmdline = " ".join(proc.info['cmdline'] or []).lower()
            if name.lower() in pname or name.lower() in cmdline:
                found.append(proc.info)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    
    if not found:
        console.print(f"[yellow]No processes found matching '{name}'[/yellow]")
        return
    
    table = Table(title=f"Processes matching '{name}'")
    table.add_column("PID", style="cyan")
    table.add_column("Name", style="bold")
    table.add_column("CPU%", justify="right")
    table.add_column("Mem%", justify="right")
    
    for p in found:
        table.add_row(str(p['pid']), p['name'], f"{p['cpu_percent']:.1f}", f"{p['memory_percent']:.1f}")
    
    console.print(table)
    console.print(f"\n[dim]Found {len(found)} process(es)[/dim]")


@app.command()
def ports(
    port: Optional[int] = typer.Option(None, "--port", "-p", help="Filter by specific port"),
    listening: bool = typer.Option(False, "--listening", "-l", help="Show only listening ports"),
):
    """Show port bindings and which processes are using them."""
    connections = []
    
    for proc in psutil.process_iter(['pid', 'name']):
        try:
            for conn in proc.net_connections():
                if conn.laddr:
                    if port and conn.laddr.port != port:
                        continue
                    if listening and conn.status != "LISTEN":
                        continue
                    connections.append({
                        "pid": proc.info['pid'],
                        "name": proc.info['name'],
                        "port": conn.laddr.port,
                        "ip": conn.laddr.ip,
                        "status": conn.status,
                        "remote": f"{conn.raddr.ip}:{conn.raddr.port}" if conn.raddr else "-",
                    })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    
    # Sort by port
    connections.sort(key=lambda x: x["port"])
    
    # Dedupe for listening
    if listening:
        seen = set()
        unique = []
        for c in connections:
            key = (c["port"], c["pid"])
            if key not in seen:
                seen.add(key)
                unique.append(c)
        connections = unique
    
    if not connections:
        msg = f"No connections found"
        if port:
            msg += f" on port {port}"
        console.print(f"[yellow]{msg}[/yellow]")
        return
    
    table = Table(title="Port Bindings" + (f" (port {port})" if port else ""))
    table.add_column("Port", style="cyan", justify="right")
    table.add_column("IP", style="dim")
    table.add_column("Status")
    table.add_column("PID", justify="right")
    table.add_column("Process", style="bold")
    table.add_column("Remote", style="dim")
    
    for c in connections[:50]:
        status_style = "green" if c["status"] == "LISTEN" else "yellow" if c["status"] == "ESTABLISHED" else ""
        table.add_row(
            str(c["port"]),
            c["ip"],
            f"[{status_style}]{c['status']}[/]",
            str(c["pid"]),
            c["name"],
            c["remote"],
        )
    
    if len(connections) > 50:
        console.print(f"[dim]Showing 50 of {len(connections)} connections[/dim]")
    
    console.print(table)


@app.command()
def kill(
    pid: Optional[int] = typer.Argument(None, help="Process ID to kill"),
    name: Optional[str] = typer.Option(None, "--name", "-n", help="Kill processes by name"),
    force: bool = typer.Option(False, "--force", "-f", help="Force kill (SIGKILL)"),
):
    """Kill a process by PID or name."""
    if not pid and not name:
        console.print("[red]Provide either a PID or --name[/red]")
        raise typer.Exit(1)
    
    sig = signal.SIGKILL if force else signal.SIGTERM
    sig_name = "SIGKILL" if force else "SIGTERM"
    
    if pid:
        try:
            proc = psutil.Process(pid)
            pname = proc.name()
            proc.send_signal(sig)
            console.print(f"[green]✓ Sent {sig_name} to {pid} ({pname})[/green]")
        except psutil.NoSuchProcess:
            console.print(f"[red]Process {pid} not found[/red]")
            raise typer.Exit(1)
        except psutil.AccessDenied:
            console.print(f"[red]Access denied - try with sudo[/red]")
            raise typer.Exit(1)
    
    if name:
        killed = 0
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                if name.lower() in proc.info['name'].lower():
                    proc.send_signal(sig)
                    console.print(f"[green]✓ Sent {sig_name} to {proc.info['pid']} ({proc.info['name']})[/green]")
                    killed += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        
        if killed == 0:
            console.print(f"[yellow]No processes found matching '{name}'[/yellow]")
        else:
            console.print(f"\n[bold]Killed {killed} process(es)[/bold]")


@app.command()
def summary():
    """Quick system summary - CPU, memory, disk, top processes."""
    # CPU
    cpu_percent = psutil.cpu_percent(interval=0.5)
    cpu_count = psutil.cpu_count()
    load = psutil.getloadavg()
    
    # Memory
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    
    # Disk
    disk = psutil.disk_usage('/')
    
    # Build summary
    summary_text = f"""[bold cyan]CPU[/bold cyan]
  Usage: {cpu_percent}% ({cpu_count} cores)
  Load: {load[0]:.2f} / {load[1]:.2f} / {load[2]:.2f}

[bold cyan]Memory[/bold cyan]
  Used: {format_bytes(mem.used)} / {format_bytes(mem.total)} ({mem.percent}%)
  Available: {format_bytes(mem.available)}
  Swap: {format_bytes(swap.used)} / {format_bytes(swap.total)} ({swap.percent}%)

[bold cyan]Disk (/)[/bold cyan]
  Used: {format_bytes(disk.used)} / {format_bytes(disk.total)} ({disk.percent}%)
  Free: {format_bytes(disk.free)}

[bold cyan]Processes[/bold cyan]
  Total: {len(list(psutil.process_iter()))}"""
    
    console.print(Panel(summary_text, title="System Summary"))
    
    # Top 5 by CPU
    console.print("\n[bold]Top 5 by CPU:[/bold]")
    procs = []
    for proc in psutil.process_iter(['pid', 'name', 'cpu_percent']):
        try:
            procs.append(proc.info)
        except:
            pass
    procs.sort(key=lambda x: x['cpu_percent'] or 0, reverse=True)
    for p in procs[:5]:
        cpu_val = p['cpu_percent'] or 0
        console.print(f"  {p['pid']:>6}  {p['name']:<20} {cpu_val:.1f}%")


@app.command()
def watch(
    interval: int = typer.Option(2, "--interval", "-i", help="Update interval in seconds"),
    alert_cpu: int = typer.Option(80, "--alert-cpu", help="CPU alert threshold (%)"),
    alert_mem: int = typer.Option(90, "--alert-mem", help="Memory alert threshold (%)"),
):
    """Watch system resources in real-time with alerts."""
    console.print(f"[dim]Watching... (Ctrl+C to stop, alerts at CPU>{alert_cpu}%, Mem>{alert_mem}%)[/dim]\n")
    
    try:
        while True:
            # Get current stats
            cpu = psutil.cpu_percent(interval=0.1)
            mem = psutil.virtual_memory()
            
            # Get top processes
            procs = []
            for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_percent']):
                try:
                    procs.append(proc.info)
                except:
                    pass
            procs.sort(key=lambda x: x['cpu_percent'] or 0, reverse=True)
            
            # Build display
            table = Table(title=f"System Monitor - {datetime.now().strftime('%H:%M:%S')}")
            table.add_column("Metric", style="bold")
            table.add_column("Value", justify="right")
            table.add_column("Status")
            
            cpu_status = "[red]⚠️ HIGH[/red]" if cpu > alert_cpu else "[green]OK[/green]"
            mem_status = "[red]⚠️ HIGH[/red]" if mem.percent > alert_mem else "[green]OK[/green]"
            
            table.add_row("CPU", f"{cpu:.1f}%", cpu_status)
            table.add_row("Memory", f"{mem.percent:.1f}%", mem_status)
            table.add_row("Processes", str(len(procs)), "")
            
            console.clear()
            console.print(table)
            
            # Top 5 processes
            console.print("\n[bold]Top Processes:[/bold]")
            for p in procs[:5]:
                cpu_style = "red" if (p['cpu_percent'] or 0) > 50 else ""
                console.print(f"  {p['pid']:>6}  {p['name']:<25} [{cpu_style}]{p['cpu_percent']:.1f}%[/]")
            
            # Alerts
            if cpu > alert_cpu:
                console.print(f"\n[red bold]⚠️ CPU ALERT: {cpu:.1f}% > {alert_cpu}%[/red bold]")
            if mem.percent > alert_mem:
                console.print(f"\n[red bold]⚠️ MEMORY ALERT: {mem.percent:.1f}% > {alert_mem}%[/red bold]")
            
            time.sleep(interval)
            
    except KeyboardInterrupt:
        console.print("\n[dim]Stopped watching[/dim]")


if __name__ == "__main__":
    app()
