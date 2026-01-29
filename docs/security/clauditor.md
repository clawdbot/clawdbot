---
summary: "Tamper-resistant audit watchdog for VPS deployments"
read_when:
  - You want to detect if your agent is compromised
  - You need tamper-evident logging for Clawdbot activity
  - You're running Clawdbot on a production VPS
---
# Clauditor

Clauditor is a security watchdog that monitors filesystem activity and creates tamper-evident logs. Even if Clawdbot is compromised, it cannot stop the watchdog, forge log entries, or delete evidence.

**GitHub:** [apollostreetcompany/clauditor](https://github.com/apollostreetcompany/clauditor)  
**ClawdHub:** `clawdhub install clauditor`

## Why Clauditor?

When you give an AI agent access to your system, you're trusting it not to:
- Exfiltrate sensitive data (credentials, keys, personal files)
- Install persistence mechanisms (cron jobs, SSH keys)
- Cover its tracks by deleting logs

Clauditor creates an independent audit trail that the agent **cannot tamper with**, even if fully compromised.

## Security Model

| Component | Owner | Clawdbot Access |
|-----------|-------|-----------------|
| Daemon | sysaudit user | ❌ Cannot kill |
| HMAC Key | root:sysaudit | ❌ Cannot read |
| Log Directory | sysaudit | ❌ Cannot write |
| Logs | sysaudit | ✅ Can read (tamper-evident) |

The watchdog runs as a separate system user (`sysaudit`). Even with full control of the `clawdbot` account, an attacker cannot:
- Stop the monitoring daemon
- Forge log entries (no access to HMAC key)
- Delete evidence (no write access to logs)

## Features

- **HMAC hash-chained logs** — Any tampering breaks the chain
- **Exec monitoring** — Tracks all command executions
- **Exfiltration detection** — Flags credential reads followed by network commands
- **Baseline tracking** — Alerts on first-time command usage
- **Orphan detection** — Flags commands running when no Clawdbot session is active
- **Digest reports** — Human-readable security summaries

## Installation

Clauditor includes an interactive wizard that guides you through installation:

```bash
# Clone and build
git clone https://github.com/apollostreetcompany/clauditor.git
cd clauditor
cargo build --release

# Run the wizard (follow prompts)
./target/release/clauditor wizard status
./target/release/clauditor wizard next
# Run the sudo command it shows, then:
./target/release/clauditor wizard verify
# Repeat until complete
```

Or use the automated script:

```bash
sudo bash wizard/wizard.sh
```

## Usage

### Check daemon status
```bash
systemctl status systemd-journaldd
```

### Generate security report
```bash
# Silent mode (only outputs if issues found)
clauditor digest --log /var/lib/.sysd/.audit/events.log --key /etc/sysaudit/key

# Verbose mode (full report)
clauditor digest --log /var/lib/.sysd/.audit/events.log --key /etc/sysaudit/key --verbose
```

### Automated daily digest
```bash
# Add to root's crontab
0 6 * * * /usr/local/sbin/systemd-journaldd digest --log /var/lib/.sysd/.audit/events.log --key /etc/sysaudit/key || echo "Anomalies detected" | mail -s "Clauditor Alert" you@example.com
```

## Requirements

- Linux with systemd
- Rust toolchain (for building)
- Root access (for installation)

## Recommended For

- **Production VPS deployments** — Where Clawdbot has access to sensitive data
- **Multi-user environments** — Where audit trails matter
- **High-trust setups** — Where you've given Clawdbot elevated permissions

For local development or sandboxed environments, Clauditor is optional but still useful for understanding agent behavior patterns.
