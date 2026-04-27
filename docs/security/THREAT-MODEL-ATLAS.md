---
summary: "OpenClaw threat model mapped to the MITRE ATLAS framework"
title: "Threat model (MITRE ATLAS)"
read_when:
  - Reviewing security posture or threat scenarios
  - Working on security features or audit responses
---

# OpenClaw Threat Model v1.0

## MITRE ATLAS Framework

**Version:** 1.0-draft
**Last Updated:** 2026-02-04
**Methodology:** MITRE ATLAS + Data Flow Diagrams
**Framework:** [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems)

### Framework attribution

This threat model is built on [MITRE ATLAS](https://atlas.mitre.org/), the industry-standard framework for documenting adversarial threats to AI/ML systems. ATLAS is maintained by [MITRE](https://www.mitre.org/) in collaboration with the AI security community.

**Key ATLAS Resources:**

- [ATLAS Techniques](https://atlas.mitre.org/techniques/)
- [ATLAS Tactics](https://atlas.mitre.org/tactics/)
- [ATLAS Case Studies](https://atlas.mitre.org/studies/)
- [ATLAS GitHub](https://github.com/mitre-atlas/atlas-data)
- [Contributing to ATLAS](https://atlas.mitre.org/resources/contribute)

### Contributing to This Threat Model

This is a living document maintained by the OpenClaw community. See [CONTRIBUTING-THREAT-MODEL.md](/security/CONTRIBUTING-THREAT-MODEL) for guidelines on contributing:

- Reporting new threats
- Updating existing threats
- Proposing attack chains
- Suggesting mitigations

---

## 1. Introduction

### 1.1 Purpose

This threat model documents adversarial threats to the OpenClaw AI agent platform and ClawHub skill marketplace, using the MITRE ATLAS framework designed specifically for AI/ML systems.

### 1.2 Scope

| Component              | Included | Notes                                            |
| ---------------------- | -------- | ------------------------------------------------ |
| OpenClaw Agent Runtime | Yes      | Core agent execution, tool calls, sessions       |
| Gateway                | Yes      | Authentication, routing, channel integration     |
| Channel Integrations   | Yes      | WhatsApp, Telegram, Discord, Signal, Slack, etc. |
| ClawHub Marketplace    | Yes      | Skill publishing, moderation, distribution       |
| MCP Servers            | Yes      | External tool providers                          |
| User Devices           | Partial  | Mobile apps, desktop clients                     |

### 1.3 Out of Scope

Nothing is explicitly out of scope for this threat model.

---

## 2. System Architecture

### 2.1 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                    UNTRUSTED ZONE                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  WhatsApp   │  │  Telegram   │  │   Discord   │  ...         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
└─────────┼────────────────┼────────────────┼──────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 1: Channel Access                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      GATEWAY                              │   │
│  │  • Device Pairing (1h DM / 5m node grace period)           │   │
│  │  • AllowFrom / AllowList validation                       │   │
│  │  • Token/Password/Tailscale auth                          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 2: Session Isolation              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   AGENT SESSIONS                          │   │
│  │  • Session key = agent:channel:peer                       │   │
│  │  • Tool policies per agent                                │   │
│  │  • Transcript logging                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 3: Tool Execution                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  EXECUTION SANDBOX                        │   │
│  │  • Docker sandbox OR Host (exec-approvals)                │   │
│  │  • Node remote execution                                  │   │
│  │  • SSRF protection (DNS pinning + IP blocking)            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 4: External Content               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              FETCHED URLs / EMAILS / WEBHOOKS             │   │
│  │  • External content wrapping (XML tags)                   │   │
│  │  • Security notice injection                              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TRUST BOUNDARY 5: Supply Chain                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      CLAWHUB                              │   │
│  │  • Skill publishing (semver, SKILL.md required)           │   │
│  │  • Pattern-based moderation flags                         │   │
│  │  • VirusTotal scanning (coming soon)                      │   │
│  │  • GitHub account age verification                        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flows

| Flow | Source  | Destination | Data               | Protection           |
| ---- | ------- | ----------- | ------------------ | -------------------- |
| F1   | Channel | Gateway     | User messages      | TLS, AllowFrom       |
| F2   | Gateway | Agent       | Routed messages    | Session isolation    |
| F3   | Agent   | Tools       | Tool invocations   | Policy enforcement   |
| F4   | Agent   | External    | web_fetch requests | SSRF blocking        |
| F5   | ClawHub | Agent       | Skill code         | Moderation, scanning |
| F6   | Agent   | Channel     | Responses          | Output filtering     |

---

## 3. Threat Analysis by ATLAS Tactic

### 3.1 Reconnaissance (AML.TA0002)

#### T-RECON-001: Agent Endpoint Discovery

| Attribute               | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                          |
| **Description**         | Attacker scans for exposed OpenClaw gateway endpoints                |
| **Attack Vector**       | Network scanning, shodan queries, DNS enumeration                    |
| **Affected Components** | Gateway, exposed API endpoints                                       |
| **Current Mitigations** | Tailscale auth option, bind to loopback by default                   |
| **Residual Risk**       | Medium - Public gateways discoverable                                |
| **Recommendations**     | Document secure deployment, add rate limiting on discovery endpoints |

#### T-RECON-002: Channel Integration Probing

| Attribute               | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                        |
| **Description**         | Attacker probes messaging channels to identify AI-managed accounts |
| **Attack Vector**       | Sending test messages, observing response patterns                 |
| **Affected Components** | All channel integrations                                           |
| **Current Mitigations** | None specific                                                      |
| **Residual Risk**       | Low - Limited value from discovery alone                           |
| **Recommendations**     | Consider response timing randomization                             |

---

### 3.2 Initial Access (AML.TA0004)

#### T-ACCESS-001: Pairing Code Interception

| Attribute               | Value                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                                                                     |
| **Description**         | Attacker intercepts pairing code during pairing grace period (1h for DM channel pairing, 5m for node pairing) |
| **Attack Vector**       | Shoulder surfing, network sniffing, social engineering                                                        |
| **Affected Components** | Device pairing system                                                                                         |
| **Current Mitigations** | 1h expiry (DM pairing) / 5m expiry (node pairing), codes sent via existing channel                            |
| **Residual Risk**       | Medium - Grace period exploitable                                                                             |
| **Recommendations**     | Reduce grace period, add confirmation step                                                                    |

#### T-ACCESS-002: AllowFrom Spoofing

| Attribute               | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                                      |
| **Description**         | Attacker spoofs allowed sender identity in channel                             |
| **Attack Vector**       | Depends on channel - phone number spoofing, username impersonation             |
| **Affected Components** | AllowFrom validation per channel                                               |
| **Current Mitigations** | Channel-specific identity verification                                         |
| **Residual Risk**       | Medium - Some channels vulnerable to spoofing                                  |
| **Recommendations**     | Document channel-specific risks, add cryptographic verification where possible |

#### T-ACCESS-003: Token Theft

| Attribute               | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                   |
| **Description**         | Attacker steals authentication tokens from config files     |
| **Attack Vector**       | Malware, unauthorized device access, config backup exposure |
| **Affected Components** | ~/.openclaw/credentials/, config storage                    |
| **Current Mitigations** | File permissions                                            |
| **Residual Risk**       | High - Tokens stored in plaintext                           |
| **Recommendations**     | Implement token encryption at rest, add token rotation      |

---

### 3.3 Execution (AML.TA0005)

#### T-EXEC-001: Direct Prompt Injection

| Attribute               | Value                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                                              |
| **Description**         | Attacker sends crafted prompts to manipulate agent behavior                               |
| **Attack Vector**       | Channel messages containing adversarial instructions                                      |
| **Affected Components** | Agent LLM, all input surfaces                                                             |
| **Current Mitigations** | Pattern detection, external content wrapping                                              |
| **Residual Risk**       | Critical - Detection only, no blocking; sophisticated attacks bypass                      |
| **Recommendations**     | Implement multi-layer defense, output validation, user confirmation for sensitive actions |

#### T-EXEC-002: Indirect Prompt Injection

| Attribute               | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ATLAS ID**            | AML.T0051.001 - LLM Prompt Injection: Indirect              |
| **Description**         | Attacker embeds malicious instructions in fetched content   |
| **Attack Vector**       | Malicious URLs, poisoned emails, compromised webhooks       |
| **Affected Components** | web_fetch, email ingestion, external data sources           |
| **Current Mitigations** | Content wrapping with XML tags and security notice          |
| **Residual Risk**       | High - LLM may ignore wrapper instructions                  |
| **Recommendations**     | Implement content sanitization, separate execution contexts |

#### T-EXEC-003: Tool Argument Injection

| Attribute               | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                 |
| **Description**         | Attacker manipulates tool arguments through prompt injection |
| **Attack Vector**       | Crafted prompts that influence tool parameter values         |
| **Affected Components** | All tool invocations                                         |
| **Current Mitigations** | Exec approvals for dangerous commands                        |
| **Residual Risk**       | High - Relies on user judgment                               |
| **Recommendations**     | Implement argument validation, parameterized tool calls      |

#### T-EXEC-004: Exec Approval Bypass

| Attribute               | Value                                                      |
| ----------------------- | ---------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                         |
| **Description**         | Attacker crafts commands that bypass approval allowlist    |
| **Attack Vector**       | Command obfuscation, alias exploitation, path manipulation |
| **Affected Components** | exec-approvals.ts, command allowlist                       |
| **Current Mitigations** | Allowlist + ask mode                                       |
| **Residual Risk**       | High - No command sanitization                             |
| **Recommendations**     | Implement command normalization, expand blocklist          |

---

### 3.4 Persistence (AML.TA0006)

#### T-PERSIST-001: Malicious Skill Installation

| Attribute               | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                     |
| **Description**         | Attacker publishes malicious skill to ClawHub                            |
| **Attack Vector**       | Create account, publish skill with hidden malicious code                 |
| **Affected Components** | ClawHub, skill loading, agent execution                                  |
| **Current Mitigations** | GitHub account age verification, pattern-based moderation flags          |
| **Residual Risk**       | Critical - No sandboxing, limited review                                 |
| **Recommendations**     | VirusTotal integration (in progress), skill sandboxing, community review |

#### T-PERSIST-002: Skill Update Poisoning

| Attribute               | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software           |
| **Description**         | Attacker compromises popular skill and pushes malicious update |
| **Attack Vector**       | Account compromise, social engineering of skill owner          |
| **Affected Components** | ClawHub versioning, auto-update flows                          |
| **Current Mitigations** | Version fingerprinting                                         |
| **Residual Risk**       | High - Auto-updates may pull malicious versions                |
| **Recommendations**     | Implement update signing, rollback capability, version pinning |

#### T-PERSIST-003: Agent Configuration Tampering

| Attribute               | Value                                                           |
| ----------------------- | --------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.002 - Supply Chain Compromise: Data                   |
| **Description**         | Attacker modifies agent configuration to persist access         |
| **Attack Vector**       | Config file modification, settings injection                    |
| **Affected Components** | Agent config, tool policies                                     |
| **Current Mitigations** | File permissions                                                |
| **Residual Risk**       | Medium - Requires local access                                  |
| **Recommendations**     | Config integrity verification, audit logging for config changes |

---

### 3.5 Defense Evasion (AML.TA0007)

#### T-EVADE-001: Moderation Pattern Bypass

| Attribute               | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                     |
| **Description**         | Attacker crafts skill content to evade moderation patterns             |
| **Attack Vector**       | Unicode homoglyphs, encoding tricks, dynamic loading                   |
| **Affected Components** | ClawHub moderation.ts                                                  |
| **Current Mitigations** | Pattern-based FLAG_RULES                                               |
| **Residual Risk**       | High - Simple regex easily bypassed                                    |
| **Recommendations**     | Add behavioral analysis (VirusTotal Code Insight), AST-based detection |

#### T-EVADE-002: Content Wrapper Escape

| Attribute               | Value                                                     |
| ----------------------- | --------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                        |
| **Description**         | Attacker crafts content that escapes XML wrapper context  |
| **Attack Vector**       | Tag manipulation, context confusion, instruction override |
| **Affected Components** | External content wrapping                                 |
| **Current Mitigations** | XML tags + security notice                                |
| **Residual Risk**       | Medium - Novel escapes discovered regularly               |
| **Recommendations**     | Multiple wrapper layers, output-side validation           |

---

### 3.6 Discovery (AML.TA0008)

#### T-DISC-001: Tool Enumeration

| Attribute               | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |
| **Description**         | Attacker enumerates available tools through prompting |
| **Attack Vector**       | "What tools do you have?" style queries               |
| **Affected Components** | Agent tool registry                                   |
| **Current Mitigations** | None specific                                         |
| **Residual Risk**       | Low - Tools generally documented                      |
| **Recommendations**     | Consider tool visibility controls                     |

#### T-DISC-002: Session Data Extraction

| Attribute               | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |
| **Description**         | Attacker extracts sensitive data from session context |
| **Attack Vector**       | "What did we discuss?" queries, context probing       |
| **Affected Components** | Session transcripts, context window                   |
| **Current Mitigations** | Session isolation per sender                          |
| **Residual Risk**       | Medium - Within-session data accessible               |
| **Recommendations**     | Implement sensitive data redaction in context         |

---

### 3.7 Collection & Exfiltration (AML.TA0009, AML.TA0010)

#### T-EXFIL-001: Data Theft via web_fetch

| Attribute               | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                                 |
| **Description**         | Attacker exfiltrates data by instructing agent to send to external URL |
| **Attack Vector**       | Prompt injection causing agent to POST data to attacker server         |
| **Affected Components** | web_fetch tool                                                         |
| **Current Mitigations** | SSRF blocking for internal networks                                    |
| **Residual Risk**       | High - External URLs permitted                                         |
| **Recommendations**     | Implement URL allowlisting, data classification awareness              |

#### T-EXFIL-002: Unauthorized Message Sending

| Attribute               | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                           |
| **Description**         | Attacker causes agent to send messages containing sensitive data |
| **Attack Vector**       | Prompt injection causing agent to message attacker               |
| **Affected Components** | Message tool, channel integrations                               |
| **Current Mitigations** | Outbound messaging gating                                        |
| **Residual Risk**       | Medium - Gating may be bypassed                                  |
| **Recommendations**     | Require explicit confirmation for new recipients                 |

#### T-EXFIL-003: Credential Harvesting

| Attribute               | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                  |
| **Description**         | Malicious skill harvests credentials from agent context |
| **Attack Vector**       | Skill code reads environment variables, config files    |
| **Affected Components** | Skill execution environment                             |
| **Current Mitigations** | None specific to skills                                 |
| **Residual Risk**       | Critical - Skills run with agent privileges             |
| **Recommendations**     | Skill sandboxing, credential isolation                  |

---

### 3.8 Impact (AML.TA0011)

#### T-IMPACT-001: Unauthorized Command Execution

| Attribute               | Value                                               |
| ----------------------- | --------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                |
| **Description**         | Attacker executes arbitrary commands on user system |
| **Attack Vector**       | Prompt injection combined with exec approval bypass |
| **Affected Components** | Bash tool, command execution                        |
| **Current Mitigations** | Exec approvals, Docker sandbox option               |
| **Residual Risk**       | Critical - Host execution without sandbox           |
| **Recommendations**     | Default to sandbox, improve approval UX             |

#### T-IMPACT-002: Resource Exhaustion (DoS)

| Attribute               | Value                                              |
| ----------------------- | -------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity               |
| **Description**         | Attacker exhausts API credits or compute resources |
| **Attack Vector**       | Automated message flooding, expensive tool calls   |
| **Affected Components** | Gateway, agent sessions, API provider              |
| **Current Mitigations** | None                                               |
| **Residual Risk**       | High - No rate limiting                            |
| **Recommendations**     | Implement per-sender rate limits, cost budgets     |

#### T-IMPACT-003: Reputation Damage

| Attribute               | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                    |
| **Description**         | Attacker causes agent to send harmful/offensive content |
| **Attack Vector**       | Prompt injection causing inappropriate responses        |
| **Affected Components** | Output generation, channel messaging                    |
| **Current Mitigations** | LLM provider content policies                           |
| **Residual Risk**       | Medium - Provider filters imperfect                     |
| **Recommendations**     | Output filtering layer, user controls                   |

---

## 4. ClawHub Supply Chain Analysis

### 4.1 Current Security Controls

| Control              | Implementation              | Effectiveness                                        |
| -------------------- | --------------------------- | ---------------------------------------------------- |
| GitHub Account Age   | `requireGitHubAccountAge()` | Medium - Raises bar for new attackers                |
| Path Sanitization    | `sanitizePath()`            | High - Prevents path traversal                       |
| File Type Validation | `isTextFile()`              | Medium - Only text files, but can still be malicious |
| Size Limits          | 50MB total bundle           | High - Prevents resource exhaustion                  |
| Required SKILL.md    | Mandatory readme            | Low security value - Informational only              |
| Pattern Moderation   | FLAG_RULES in moderation.ts | Low - Easily bypassed                                |
| Moderation Status    | `moderationStatus` field    | Medium - Manual review possible                      |

### 4.2 Moderation Flag Patterns

Current patterns in `moderation.ts`:

```javascript
// Known-bad identifiers
/(keepcold131\/ClawdAuthenticatorTool|ClawdAuthenticatorTool)/i

// Suspicious keywords
/(malware|stealer|phish|phishing|keylogger)/i
/(api[-_ ]?key|token|password|private key|secret)/i
/(wallet|seed phrase|mnemonic|crypto)/i
/(discord\.gg|webhook|hooks\.slack)/i
/(curl[^\n]+\|\s*(sh|bash))/i
/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd)/i
```

**Limitations:**

- Only checks slug, displayName, summary, frontmatter, metadata, file paths
- Does not analyze actual skill code content
- Simple regex easily bypassed with obfuscation
- No behavioral analysis

### 4.3 Planned Improvements

| Improvement            | Status                                | Impact                                                                |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| VirusTotal Integration | In Progress                           | High - Code Insight behavioral analysis                               |
| Community Reporting    | Partial (`skillReports` table exists) | Medium                                                                |
| Audit Logging          | Partial (`auditLogs` table exists)    | Medium                                                                |
| Badge System           | Implemented                           | Medium - `highlighted`, `official`, `deprecated`, `redactionApproved` |

---

## 5. Risk Matrix

### 5.1 Likelihood vs Impact

| Threat ID     | Likelihood | Impact   | Risk Level   | Priority |
| ------------- | ---------- | -------- | ------------ | -------- |
| T-EXEC-001    | High       | Critical | **Critical** | P0       |
| T-PERSIST-001 | High       | Critical | **Critical** | P0       |
| T-EXFIL-003   | Medium     | Critical | **Critical** | P0       |
| T-IMPACT-001  | Medium     | Critical | **High**     | P1       |
| T-EXEC-002    | High       | High     | **High**     | P1       |
| T-EXEC-004    | Medium     | High     | **High**     | P1       |
| T-ACCESS-003  | Medium     | High     | **High**     | P1       |
| T-EXFIL-001   | Medium     | High     | **High**     | P1       |
| T-IMPACT-002  | High       | Medium   | **High**     | P1       |
| T-EVADE-001   | High       | Medium   | **Medium**   | P2       |
| T-ACCESS-001  | Low        | High     | **Medium**   | P2       |
| T-ACCESS-002  | Low        | High     | **Medium**   | P2       |
| T-PERSIST-002 | Low        | High     | **Medium**   | P2       |

### 5.2 Critical Path Attack Chains

**Attack Chain 1: Skill-Based Data Theft**

```
T-PERSIST-001 → T-EVADE-001 → T-EXFIL-003
(Publish malicious skill) → (Evade moderation) → (Harvest credentials)
```

**Attack Chain 2: Prompt Injection to RCE**

```
T-EXEC-001 → T-EXEC-004 → T-IMPACT-001
(Inject prompt) → (Bypass exec approval) → (Execute commands)
```

**Attack Chain 3: Indirect Injection via Fetched Content**

```
T-EXEC-002 → T-EXFIL-001 → External exfiltration
(Poison URL content) → (Agent fetches & follows instructions) → (Data sent to attacker)
```

---

## 6. Recommendations Summary

### 6.1 Immediate (P0)

| ID    | Recommendation                              | Addresses                  |
| ----- | ------------------------------------------- | -------------------------- |
| R-001 | Complete VirusTotal integration             | T-PERSIST-001, T-EVADE-001 |
| R-002 | Implement skill sandboxing                  | T-PERSIST-001, T-EXFIL-003 |
| R-003 | Add output validation for sensitive actions | T-EXEC-001, T-EXEC-002     |

### 6.2 Short-term (P1)

| ID    | Recommendation                           | Addresses    |
| ----- | ---------------------------------------- | ------------ |
| R-004 | Implement rate limiting                  | T-IMPACT-002 |
| R-005 | Add token encryption at rest             | T-ACCESS-003 |
| R-006 | Improve exec approval UX and validation  | T-EXEC-004   |
| R-007 | Implement URL allowlisting for web_fetch | T-EXFIL-001  |

### 6.3 Medium-term (P2)

| ID    | Recommendation                                        | Addresses     |
| ----- | ----------------------------------------------------- | ------------- |
| R-008 | Add cryptographic channel verification where possible | T-ACCESS-002  |
| R-009 | Implement config integrity verification               | T-PERSIST-003 |
| R-010 | Add update signing and version pinning                | T-PERSIST-002 |

---

## 7. Appendices

### 7.1 ATLAS Technique Mapping

| ATLAS ID      | Technique Name                 | OpenClaw Threats                                                 |
| ------------- | ------------------------------ | ---------------------------------------------------------------- |
| AML.T0006     | Active Scanning                | T-RECON-001, T-RECON-002                                         |
| AML.T0009     | Collection                     | T-EXFIL-001, T-EXFIL-002, T-EXFIL-003                            |
| AML.T0010.001 | Supply Chain: AI Software      | T-PERSIST-001, T-PERSIST-002                                     |
| AML.T0010.002 | Supply Chain: Data             | T-PERSIST-003                                                    |
| AML.T0031     | Erode AI Model Integrity       | T-IMPACT-001, T-IMPACT-002, T-IMPACT-003                         |
| AML.T0040     | AI Model Inference API Access  | T-ACCESS-001, T-ACCESS-002, T-ACCESS-003, T-DISC-001, T-DISC-002 |
| AML.T0043     | Craft Adversarial Data         | T-EXEC-004, T-EVADE-001, T-EVADE-002                             |
| AML.T0051.000 | LLM Prompt Injection: Direct   | T-EXEC-001, T-EXEC-003                                           |
| AML.T0051.001 | LLM Prompt Injection: Indirect | T-EXEC-002                                                       |

### 7.2 Key Security Files

| Path                                | Purpose                     | Risk Level   |
| ----------------------------------- | --------------------------- | ------------ |
| `src/infra/exec-approvals.ts`       | Command approval logic      | **Critical** |
| `src/gateway/auth.ts`               | Gateway authentication      | **Critical** |
| `src/infra/net/ssrf.ts`             | SSRF protection             | **Critical** |
| `src/security/external-content.ts`  | Prompt injection mitigation | **Critical** |
| `src/agents/sandbox/tool-policy.ts` | Tool policy enforcement     | **Critical** |
| `src/routing/resolve-route.ts`      | Session isolation           | **Medium**   |

### 7.3 Glossary

| Term                 | Definition                                                |
| -------------------- | --------------------------------------------------------- |
| **ATLAS**            | MITRE's Adversarial Threat Landscape for AI Systems       |
| **ClawHub**          | OpenClaw's skill marketplace                              |
| **Gateway**          | OpenClaw's message routing and authentication layer       |
| **MCP**              | Model Context Protocol - tool provider interface          |
| **Prompt Injection** | Attack where malicious instructions are embedded in input |
| **Skill**            | Downloadable extension for OpenClaw agents                |
| **SSRF**             | Server-Side Request Forgery                               |

---

_This threat model is a living document. Report security issues to security@openclaw.ai_

## Related

- [Formal verification](/security/formal-verification)
- [Contributing to the threat model](/security/CONTRIBUTING-THREAT-MODEL)
