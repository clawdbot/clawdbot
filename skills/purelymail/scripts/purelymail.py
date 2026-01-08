#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["rich", "typer"]
# ///
"""
PurelyMail Setup - Configure and test PurelyMail email for Clawdbot agents.
"""

import email
import imaplib
import json
import smtplib
import ssl
from datetime import datetime
from email.mime.text import MIMEText
from typing import Optional

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

app = typer.Typer(help="PurelyMail Setup - configure email for Clawdbot agents")
console = Console()

# PurelyMail server settings
IMAP_SERVER = "imap.purelymail.com"
IMAP_PORT = 993
SMTP_SERVER = "smtp.purelymail.com"
SMTP_PORT = 465  # SSL
SMTP_PORT_STARTTLS = 587


@app.command()
def config(
    email_addr: str = typer.Option(..., "--email", "-e", help="Email address"),
    password: str = typer.Option(..., "--password", "-p", help="Email password"),
    name: str = typer.Option("agent-email", "--name", "-n", help="Config entry name"),
    output: bool = typer.Option(False, "--output", "-o", help="Output raw JSON only"),
):
    """Generate clawdbot.json config snippet for PurelyMail."""
    
    config_snippet = {
        "skills": {
            "entries": {
                name: {
                    "env": {
                        f"{name.upper().replace('-', '_')}_EMAIL": email_addr,
                        f"{name.upper().replace('-', '_')}_PASSWORD": password,
                        f"{name.upper().replace('-', '_')}_IMAP_SERVER": IMAP_SERVER,
                        f"{name.upper().replace('-', '_')}_SMTP_SERVER": SMTP_SERVER,
                    }
                }
            }
        }
    }
    
    if output:
        print(json.dumps(config_snippet, indent=2))
        return
    
    console.print(Panel(
        f"[bold]Add this to your clawdbot.json:[/bold]\n\n"
        f"[cyan]{json.dumps(config_snippet, indent=2)}[/cyan]",
        title="PurelyMail Config"
    ))
    
    console.print("\n[dim]Or merge into existing config under skills.entries[/dim]")


@app.command()
def test(
    email_addr: str = typer.Option(..., "--email", "-e", help="Email address"),
    password: str = typer.Option(..., "--password", "-p", help="Email password"),
):
    """Test IMAP and SMTP connectivity."""
    
    console.print("[bold]Testing PurelyMail connection...[/bold]\n")
    
    # Test IMAP
    console.print(f"[blue]Testing IMAP ({IMAP_SERVER}:{IMAP_PORT})...[/blue]")
    try:
        context = ssl.create_default_context()
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT, ssl_context=context) as imap:
            imap.login(email_addr, password)
            imap.select("INBOX")
            _, messages = imap.search(None, "ALL")
            msg_count = len(messages[0].split()) if messages[0] else 0
            console.print(f"[green]✓ IMAP connected - {msg_count} messages in inbox[/green]")
    except imaplib.IMAP4.error as e:
        console.print(f"[red]✗ IMAP failed: {e}[/red]")
        raise typer.Exit(1)
    except Exception as e:
        console.print(f"[red]✗ IMAP error: {e}[/red]")
        raise typer.Exit(1)
    
    # Test SMTP
    console.print(f"\n[blue]Testing SMTP ({SMTP_SERVER}:{SMTP_PORT})...[/blue]")
    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, context=context) as smtp:
            smtp.login(email_addr, password)
            console.print(f"[green]✓ SMTP connected and authenticated[/green]")
    except smtplib.SMTPAuthenticationError as e:
        console.print(f"[red]✗ SMTP auth failed: {e}[/red]")
        raise typer.Exit(1)
    except Exception as e:
        console.print(f"[red]✗ SMTP error: {e}[/red]")
        raise typer.Exit(1)
    
    console.print("\n[bold green]✓ All tests passed![/bold green]")


@app.command()
def send_test(
    email_addr: str = typer.Option(..., "--email", "-e", help="Email address"),
    password: str = typer.Option(..., "--password", "-p", help="Email password"),
    to: str = typer.Option(..., "--to", "-t", help="Recipient email address"),
    subject: str = typer.Option("Test from Clawdbot Agent", "--subject", "-s", help="Email subject"),
):
    """Send a test email."""
    
    console.print(f"[blue]Sending test email to {to}...[/blue]")
    
    msg = MIMEText(f"""Hello!

This is a test email from your Clawdbot agent ({email_addr}).

If you received this, SMTP is working correctly!

Sent at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

-- 
Clawdbot Agent
""")
    
    msg["Subject"] = subject
    msg["From"] = email_addr
    msg["To"] = to
    
    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, context=context) as smtp:
            smtp.login(email_addr, password)
            smtp.send_message(msg)
        console.print(f"[green]✓ Test email sent to {to}[/green]")
    except Exception as e:
        console.print(f"[red]✗ Failed to send: {e}[/red]")
        raise typer.Exit(1)


@app.command()
def inbox(
    email_addr: str = typer.Option(..., "--email", "-e", help="Email address"),
    password: str = typer.Option(..., "--password", "-p", help="Email password"),
    limit: int = typer.Option(10, "--limit", "-l", help="Number of messages to show"),
    unread: bool = typer.Option(False, "--unread", "-u", help="Show only unread messages"),
):
    """List recent inbox messages."""
    
    try:
        context = ssl.create_default_context()
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT, ssl_context=context) as imap:
            imap.login(email_addr, password)
            imap.select("INBOX")
            
            search_criteria = "UNSEEN" if unread else "ALL"
            _, messages = imap.search(None, search_criteria)
            
            msg_nums = messages[0].split()
            if not msg_nums:
                console.print("[yellow]No messages found[/yellow]")
                return
            
            # Get latest messages
            msg_nums = msg_nums[-limit:]
            msg_nums.reverse()  # Newest first
            
            table = Table(title=f"Inbox ({email_addr})")
            table.add_column("#", style="dim")
            table.add_column("From", style="cyan")
            table.add_column("Subject", style="bold")
            table.add_column("Date", style="dim")
            
            for num in msg_nums:
                _, msg_data = imap.fetch(num, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
                if msg_data[0]:
                    header = email.message_from_bytes(msg_data[0][1])
                    from_addr = header.get("From", "Unknown")[:40]
                    subject = header.get("Subject", "No subject")[:50]
                    date = header.get("Date", "")[:25]
                    table.add_row(num.decode(), from_addr, subject, date)
            
            console.print(table)
            console.print(f"\n[dim]Use 'purelymail read <num>' to read a message[/dim]")
            
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command()
def read(
    msg_num: int = typer.Argument(..., help="Message number to read"),
    email_addr: str = typer.Option(..., "--email", "-e", help="Email address"),
    password: str = typer.Option(..., "--password", "-p", help="Email password"),
):
    """Read a specific email message."""
    
    try:
        context = ssl.create_default_context()
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT, ssl_context=context) as imap:
            imap.login(email_addr, password)
            imap.select("INBOX")
            
            _, msg_data = imap.fetch(str(msg_num).encode(), "(RFC822)")
            if not msg_data[0]:
                console.print(f"[red]Message {msg_num} not found[/red]")
                raise typer.Exit(1)
            
            msg = email.message_from_bytes(msg_data[0][1])
            
            # Extract body
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_type() == "text/plain":
                        body = part.get_payload(decode=True).decode(errors="replace")
                        break
            else:
                body = msg.get_payload(decode=True).decode(errors="replace")
            
            console.print(Panel(
                f"[bold]From:[/bold] {msg.get('From', 'Unknown')}\n"
                f"[bold]To:[/bold] {msg.get('To', 'Unknown')}\n"
                f"[bold]Date:[/bold] {msg.get('Date', 'Unknown')}\n"
                f"[bold]Subject:[/bold] {msg.get('Subject', 'No subject')}\n\n"
                f"{body[:2000]}{'...' if len(body) > 2000 else ''}",
                title=f"Message #{msg_num}"
            ))
            
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command()
def setup_guide():
    """Print full PurelyMail setup guide."""
    
    guide = """
[bold cyan]PurelyMail Setup Guide for Clawdbot[/bold cyan]

[bold]Step 1: Create PurelyMail Account[/bold]
  1. Go to https://purelymail.com
  2. Click "Get Started" and create an account
  3. Choose a plan (~$10/year for basic)

[bold]Step 2: Add Your Domain[/bold]
  1. In PurelyMail dashboard, click "Domains"
  2. Add your domain (e.g., yourdomain.com)
  3. Add the DNS records PurelyMail provides:
     - MX records (for receiving)
     - SPF, DKIM, DMARC (for sending)
  4. Wait for DNS propagation (can take up to 48h)

[bold]Step 3: Create Agent Mailbox[/bold]
  1. Go to "Users" in PurelyMail dashboard
  2. Click "Add User"
  3. Create an address like agent@yourdomain.com
  4. Set a strong password
  5. Save the password securely

[bold]Step 4: Configure Clawdbot[/bold]
  Run: purelymail config --email agent@yourdomain.com --password "YourPassword"
  
  Add the output to your ~/.clawdbot/clawdbot.json

[bold]Step 5: Test Connection[/bold]
  Run: purelymail test --email agent@yourdomain.com --password "YourPassword"

[bold]Step 6: Send Test Email[/bold]
  Run: purelymail send-test --email agent@yourdomain.com --password "YourPassword" --to you@example.com

[bold]Server Settings[/bold]
  IMAP: imap.purelymail.com:993 (SSL)
  SMTP: smtp.purelymail.com:465 (SSL) or :587 (STARTTLS)

[bold]Tips[/bold]
  • Use a unique password for your agent (not your main account)
  • Enable 2FA on your PurelyMail account
  • Consider catch-all addresses for flexible routing
  • PurelyMail supports unlimited aliases on your domain
"""
    
    console.print(Panel(guide, title="Setup Guide"))


@app.command()
def wizard():
    """Interactive wizard to set up PurelyMail for your Clawdbot agent."""
    
    console.print(Panel(
        "[bold]Welcome to PurelyMail Setup Wizard![/bold]\n\n"
        "This wizard will help you configure email for your Clawdbot agent.\n"
        "You'll need a PurelyMail account first - sign up at https://purelymail.com",
        title="📬 PurelyMail Wizard"
    ))
    
    # Step 1: Check if they have an account
    console.print("\n[bold cyan]Step 1: PurelyMail Account[/bold cyan]")
    has_account = typer.confirm("Do you already have a PurelyMail account?", default=True)
    
    if not has_account:
        console.print("""
[yellow]No problem! Here's how to get started:[/yellow]

1. Go to [link=https://purelymail.com]https://purelymail.com[/link]
2. Click "Get Started" 
3. Choose a plan (~$10/year for unlimited addresses)
4. Add your domain and set up DNS records
5. Create a mailbox for your agent

[dim]Come back and run this wizard again once you have credentials![/dim]
""")
        raise typer.Exit(0)
    
    # Step 2: Get credentials
    console.print("\n[bold cyan]Step 2: Enter Credentials[/bold cyan]")
    email_addr = typer.prompt("Agent email address (e.g., agent@yourdomain.com)")
    password = typer.prompt("Email password", hide_input=True)
    
    # Step 3: Test connection
    console.print("\n[bold cyan]Step 3: Testing Connection[/bold cyan]")
    
    # Test IMAP
    console.print(f"Testing IMAP ({IMAP_SERVER}:{IMAP_PORT})...")
    imap_ok = False
    try:
        context = ssl.create_default_context()
        with imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT, ssl_context=context) as imap:
            imap.login(email_addr, password)
            imap.select("INBOX")
            _, messages = imap.search(None, "ALL")
            msg_count = len(messages[0].split()) if messages[0] else 0
            console.print(f"[green]✓ IMAP connected - {msg_count} messages in inbox[/green]")
            imap_ok = True
    except Exception as e:
        console.print(f"[red]✗ IMAP failed: {e}[/red]")
    
    # Test SMTP
    console.print(f"Testing SMTP ({SMTP_SERVER}:{SMTP_PORT})...")
    smtp_ok = False
    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, context=context) as smtp:
            smtp.login(email_addr, password)
            console.print(f"[green]✓ SMTP connected[/green]")
            smtp_ok = True
    except Exception as e:
        console.print(f"[red]✗ SMTP failed: {e}[/red]")
    
    if not (imap_ok and smtp_ok):
        console.print("\n[red]Connection test failed. Please check your credentials.[/red]")
        console.print("[dim]Common issues: wrong password, 2FA enabled (use app password), account not activated[/dim]")
        raise typer.Exit(1)
    
    console.print("\n[green]✓ All connection tests passed![/green]")
    
    # Step 4: Generate config
    console.print("\n[bold cyan]Step 4: Generate Configuration[/bold cyan]")
    config_name = typer.prompt("Config entry name", default="agent-email")
    
    env_prefix = config_name.upper().replace("-", "_")
    config_snippet = {
        config_name: {
            "env": {
                f"{env_prefix}_EMAIL": email_addr,
                f"{env_prefix}_PASSWORD": password,
                f"{env_prefix}_IMAP_SERVER": IMAP_SERVER,
                f"{env_prefix}_SMTP_SERVER": SMTP_SERVER,
            }
        }
    }
    
    console.print(Panel(
        f"[bold]Add this to your clawdbot.json under skills.entries:[/bold]\n\n"
        f"[cyan]{json.dumps(config_snippet, indent=2)}[/cyan]",
        title="Configuration"
    ))
    
    # Step 5: Optional test email
    console.print("\n[bold cyan]Step 5: Send Test Email (Optional)[/bold cyan]")
    send_test = typer.confirm("Would you like to send a test email?", default=True)
    
    if send_test:
        test_to = typer.prompt("Send test email to")
        
        msg = MIMEText(f"""Hello!

This is a test email from your Clawdbot agent setup wizard.

Agent email: {email_addr}
Sent at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

If you received this, your agent's email is working correctly! 🎉

-- 
Clawdbot Agent (via PurelyMail)
""")
        
        msg["Subject"] = "✓ Clawdbot Agent Email Test"
        msg["From"] = email_addr
        msg["To"] = test_to
        
        try:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, context=context) as smtp:
                smtp.login(email_addr, password)
                smtp.send_message(msg)
            console.print(f"[green]✓ Test email sent to {test_to}[/green]")
        except Exception as e:
            console.print(f"[yellow]⚠ Failed to send test email: {e}[/yellow]")
    
    # Done!
    console.print(Panel(
        f"""[bold green]Setup Complete! 🎉[/bold green]

Your Clawdbot agent email is ready:
  📧 Email: {email_addr}
  📥 IMAP: {IMAP_SERVER}:993
  📤 SMTP: {SMTP_SERVER}:465

[bold]Next steps:[/bold]
1. Add the config above to ~/.clawdbot/clawdbot.json
2. Restart your Clawdbot gateway
3. Your agent can now send and receive email!

[dim]Use 'purelymail inbox' to check messages
Use 'purelymail send-test' to send emails[/dim]""",
        title="✓ Setup Complete"
    ))


if __name__ == "__main__":
    app()
