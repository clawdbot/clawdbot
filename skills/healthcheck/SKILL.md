---
name: healthcheck
description: "Audit/harden OpenClaw hosts: SSH, firewall, updates, exposure, backups, disk encryption, gateway security."
---

# OpenClaw host healthcheck

Goal: assess host risk, run read-only checks, then propose staged hardening without breaking access.

## Rules

- Ask before state-changing actions.
- Do not change SSH/firewall/remote access until access path is confirmed.
- Prefer reversible steps and rollback notes.
- Never claim OpenClaw manages OS firewall, SSH, or updates.
- If identity/role unknown, recommend only.
- User choices: numbered list.
- Never print secrets.

## Context to infer first

- OS/version, container vs host.
- Privilege level.
- Access path: local, SSH, RDP, tailnet.
- Network exposure: public IP, reverse proxy, tunnel, LAN only.
- OpenClaw gateway status, bind, auth.
- Backup status.
- Disk encryption.
- Automatic security updates.
- Usage mode: personal workstation, local assistant box, remote server, other.

Ask only for missing facts. Simple phrasing preferred.

## Read-only checks

Ask once for permission to run read-only checks. Then run relevant commands.

Common:

```bash
openclaw security audit --deep
openclaw gateway status --deep
openclaw doctor
```

macOS:

```bash
sw_vers
lsof -nP -iTCP -sTCP:LISTEN
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
pfctl -s info
tmutil status
fdesetup status
softwareupdate --schedule
```

Linux:

```bash
cat /etc/os-release
ss -ltnup || ss -ltnp
ufw status || firewall-cmd --state || nft list ruleset
systemctl status ssh sshd
lsblk -f
```

Windows:

```powershell
systeminfo
Get-NetFirewallProfile
Get-BitLockerVolume
```

## Risk profile

After context is known, ask desired posture:

1. Convenience: local/private, minimal prompts.
2. Balanced: secure defaults, low friction.
3. Strict: remote/public/sensitive data, more lock-down.

## Report shape

- Current posture: one paragraph.
- Findings: severity + evidence + why it matters.
- Recommended plan: staged, reversible.
- Commands: read-only first; write actions only after approval.
- Gaps: what could not be checked.

## Hardening menu

Offer only relevant items:

- Bind gateway to loopback/LAN/tailnet intentionally.
- Require auth for remote access.
- Close public ports or restrict by firewall.
- Enable OS security updates.
- Enable disk encryption.
- Verify backups and restore path.
- Disable password SSH or require keys/MFA where appropriate.
- Add scheduled `openclaw security audit --deep`.

Confirm exact action before applying.
