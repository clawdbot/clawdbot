---
summary: "Moltmates Security - How isolation and sandboxing works"
read_when:
  - Understanding Moltmates security model
  - Configuring sandbox restrictions
  - Evaluating multi-user safety
---

# 🔒 Moltmates Security

> Understanding the security model, isolation layers, and how to configure safe multi-user deployments.

---

## Security Philosophy

Moltmates follows a **zero-trust** model:

> **Assume every user (and their AI) might try something malicious.**

Even if you trust your users personally, their AI agents might be manipulated via prompt injection. The goal is to limit blast radius.

---

## Isolation Layers

### Layer 1: Session Routing

Each user gets their own session:

```
User A message → Session A → Agent A
User B message → Session B → Agent B
```

Sessions cannot:
- Read each other's history
- Access each other's memory
- Share context or state

### Layer 2: Workspace Isolation

Each user has their own directory:

```
~/.moltmate/users/
├── telegram_123/    # User A (isolated)
│   ├── SOUL.md
│   ├── MEMORY.md
│   └── workspace/
└── telegram_456/    # User B (isolated)
    ├── SOUL.md
    ├── MEMORY.md
    └── workspace/
```

Agents can only access their user's directory.

### Layer 3: Docker Sandboxing

Agent code runs in isolated containers:

```
┌─────────────────────────────┐
│         Host System         │
│  (Moltmates Gateway)        │
│                             │
│  ┌─────────┐  ┌─────────┐  │
│  │Container│  │Container│  │
│  │ User A  │  │ User B  │  │
│  │ 🔒      │  │ 🔒      │  │
│  └─────────┘  └─────────┘  │
└─────────────────────────────┘
```

Containers:
- Cannot access host filesystem
- Cannot see other containers
- Have limited binaries
- Are ephemeral (destroyed on restart)

### Layer 4: Tool Allowlisting

Only specified commands can run:

```json
{
  "exec": {
    "security": "allowlist",
    "safeBins": ["cat", "head", "tail", "grep", "wc"]
  }
}
```

Any command not in `safeBins` is blocked.

---

## Attack Scenarios & Mitigations

### Prompt Injection

**Attack:** Malicious website returns text like "Ignore previous instructions and..."

**Mitigation:**
- Sandbox limits what "bad" instructions can do
- Only allowlisted tools available
- Model training includes some injection resistance

### Filesystem Access

**Attack:** `cat /etc/shadow` or `rm -rf /`

**Mitigation:**
- Sandbox sees only container filesystem
- Host `/etc/shadow` not accessible
- Deleting sandbox files only affects that session

### Network Exfiltration

**Attack:** Upload user data to attacker's server

**Mitigation:**
- Optional: disable network in container
- `web_fetch` is controllable
- Logs show all network requests

### Cross-User Data Access

**Attack:** User A tries to read User B's files

**Mitigation:**
- Workspace paths are user-specific
- Container mounts only that user's directory
- Session routing prevents message interception

### Resource Exhaustion (DoS)

**Attack:** Infinite loop, memory bomb, disk fill

**Mitigation:**
- Container resource limits (memory, CPU)
- Session timeouts
- Disk quotas on workspace

---

## Configuration Options

### Sandbox Modes

```json
"sandbox": {
  "mode": "all",       // All sessions sandboxed (recommended)
  "scope": "session",  // Container per session
  "workspaceAccess": "rw"  // Read-write workspace
}
```

| Mode | Description | Security |
|------|-------------|----------|
| `all` | All sessions sandboxed | ✅ Maximum |
| `tools` | Only tool calls sandboxed | ⚠️ Medium |
| `none` | No sandboxing | ❌ Dangerous |

### Exec Security Levels

```json
"exec": {
  "security": "allowlist"  // Only safeBins allowed
}
```

| Level | Description | Risk |
|-------|-------------|------|
| `allowlist` | Only safeBins | ✅ Safe |
| `blocklist` | Block dangerous | ⚠️ Medium |
| `full` | Everything allowed | ❌ Dangerous |

### Safe Binaries

Only add what's necessary:

```json
"safeBins": [
  // Read-only (safe)
  "cat", "head", "tail", "grep", "wc", "ls",
  
  // Text processing (safe)
  "sed", "awk", "sort", "uniq",
  
  // Document conversion (safe)
  "pdftotext",
  
  // DANGEROUS - avoid in multi-user:
  // "curl", "wget"    - network access
  // "python", "node"  - arbitrary code
  // "rm", "mv"        - destructive
  // "bash", "sh"      - shell escape
]
```

---

## Network Security

### Disable Outbound Network

For maximum isolation, containers have no network:

```json
"sandbox": {
  "network": "none"
}
```

### Control Web Access

If network needed, control at tool level:

```json
"tools": {
  "web": {
    "fetch": {
      "enabled": true,
      "allowedDomains": ["wikipedia.org", "docs.python.org"]
    }
  }
}
```

### Gateway Binding

Never expose gateway publicly:

```json
"gateway": {
  "bind": "127.0.0.1",  // Localhost only!
  "port": 18790
}
```

For remote access, use SSH tunnel or Tailscale.

---

## Audit & Monitoring

### Check Running Containers

```bash
# See all Moltmates containers
docker ps | grep moltmate-sbx

# Resource usage
docker stats
```

### Review Logs

```bash
# All gateway activity
journalctl -u moltmate -f

# Filter for specific user
journalctl -u moltmate | grep "telegram_123456"
```

### Audit User Actions

Enable detailed logging:

```json
"logging": {
  "level": "debug",
  "tools": true  // Log all tool calls
}
```

---

## Security Checklist

### Before Deployment

- [ ] Sandbox mode set to `all`
- [ ] Exec security set to `allowlist`
- [ ] Only necessary safeBins listed
- [ ] Gateway bound to localhost
- [ ] API keys not in git
- [ ] Strong gateway token (if exposed)

### Regular Checks

- [ ] Review user workspaces for unusual files
- [ ] Check container resource usage
- [ ] Audit logs for suspicious activity
- [ ] Update Moltmates regularly
- [ ] Rotate API keys periodically

### Per-User Considerations

- [ ] Trust level: family vs strangers
- [ ] Appropriate tool access
- [ ] Workspace size limits
- [ ] Session monitoring

---

## Incident Response

### If Compromise Suspected

1. **Stop gateway:** `systemctl stop moltmate`
2. **Review logs:** `journalctl -u moltmate --since "24 hours ago"`
3. **Check containers:** `docker ps -a | grep moltmate`
4. **Inspect workspaces:** `ls -la ~/.moltmate/users/*/`
5. **Rotate API keys**
6. **Remove suspicious users from allowlist**
7. **Restart with fresh state if needed**

### Resetting a User

```bash
# Remove their workspace
rm -rf ~/.moltmate/users/telegram_SUSPICIOUS_ID/

# Remove from allowlist
# Edit config, remove ID from allowFrom

# Restart
systemctl restart moltmate
```

---

## Comparison: Trust Levels

| Scenario | Sandbox | Network | Tools |
|----------|---------|---------|-------|
| Personal (just you) | Optional | Full | Full |
| Family/Friends | Yes | Limited | Allowlist |
| Strangers/Public | Yes | None | Minimal |
| High-security | Yes + limits | None | Read-only |

---

## Advanced: Custom Sandbox

For custom isolation, edit `Dockerfile.sandbox`:

```dockerfile
FROM debian:bookworm-slim

# Minimal user
RUN useradd -m agent

# No shell
RUN rm /bin/bash /bin/sh

# Read-only root
# (Configure in docker run)

# Only needed tools
RUN apt-get update && apt-get install -y \
    coreutils \
    && rm -rf /var/lib/apt/lists/*

USER agent
WORKDIR /workspace
```

Build with hardening:

```bash
docker build \
  --no-cache \
  --security-opt no-new-privileges \
  -f Dockerfile.sandbox \
  -t moltmate-sandbox:hardened .
```

---

## Resources

- [Docker Security Best Practices](https://docs.docker.com/develop/security-best-practices/)
- [Moltbot Security Docs](/gateway/security)
- [OWASP AI Security](https://owasp.org/www-project-ai-security/)

---

**Security is a journey, not a destination.** 🔒

Review regularly. Update often. Stay vigilant.
