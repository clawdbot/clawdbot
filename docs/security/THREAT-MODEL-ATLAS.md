---
summary: "OpenClaw threat model mapped to the MITRE ATLAS framework"
title: "Threat model (MITRE ATLAS)"
read_when:
  - Reviewing security posture or threat scenarios
  - Working on security features or audit responses
---

**Version:** 1.0-draft | **Framework:** [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems) + data flow diagrams

This threat model documents adversarial threats to the OpenClaw AI agent platform and ClawHub skill marketplace. It is a living document maintained by the OpenClaw community. See [Contributing to the threat model](/security/CONTRIBUTING-THREAT-MODEL) for how to report new threats, propose attack chains, or suggest mitigations.

**Key ATLAS resources:** [Techniques](https://atlas.mitre.org/techniques/) | [Tactics](https://atlas.mitre.org/tactics/) | [Case studies](https://atlas.mitre.org/studies/) | [ATLAS GitHub](https://github.com/mitre-atlas/atlas-data) | [Contributing to ATLAS](https://atlas.mitre.org/resources/contribute)

---

## 1. Scope

| Component              | Included | Notes                                            |
| ---------------------- | -------- | ------------------------------------------------ |
| OpenClaw agent runtime | Yes      | Core agent execution, tool calls, sessions       |
| Gateway                | Yes      | Authentication, routing, channel integration     |
| Channel integrations   | Yes      | WhatsApp, Telegram, Discord, Signal, Slack, etc. |
| ClawHub marketplace    | Yes      | Skill publishing, moderation, distribution       |
| MCP servers            | Yes      | External tool providers                          |
| User devices           | Partial  | Mobile apps, desktop clients                     |

Out-of-scope reports and false-positive patterns (public internet exposure, prompt-injection-only chains without a boundary bypass, mutually untrusted operators sharing one gateway host, and others) are enumerated in [`SECURITY.md`](https://github.com/openclaw/openclaw/blob/main/SECURITY.md); that file is the current source of truth for vulnerability-report scope, not this page.

## 2. System architecture

### 2.1 Trust boundaries

```text
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
│  │  • Device pairing (1h DM pairing / 5m node pairing TTL)   │   │
│  │  • AllowFrom / allowlist validation                       │   │
│  │  • Token / password / Tailscale auth                      │   │
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
│  │  • Docker sandbox (default) or host (exec approvals)      │   │
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
│  │  • External content wrapping (random-boundary XML tags)   │   │
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
│  │  • Static pattern + AST-adjacent moderation scanning      │   │
│  │  • LLM-based agentic risk review + VirusTotal scanning    │   │
│  │  • GitHub account age verification (14 days)              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Data flows

| Flow | Source  | Destination | Data                 | Protection           |
| ---- | ------- | ----------- | -------------------- | -------------------- |
| F1   | Channel | Gateway     | User messages        | TLS, AllowFrom       |
| F2   | Gateway | Agent       | Routed messages      | Session isolation    |
| F3   | Agent   | Tools       | Tool invocations     | Policy enforcement   |
| F4   | Agent   | External    | `web_fetch` requests | SSRF blocking        |
| F5   | ClawHub | Agent       | Skill code           | Moderation, scanning |
| F6   | Agent   | Channel     | Responses            | Output filtering     |

---

## 3. Threat analysis by ATLAS tactic

### 3.1 Reconnaissance (AML.TA0002)

#### T-RECON-001: Agent endpoint discovery

| Attribute               | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                          |
| **Description**         | Attacker scans for exposed OpenClaw gateway endpoints                |
| **Attack vector**       | Network scanning, Shodan queries, DNS enumeration                    |
| **Affected components** | Gateway, exposed API endpoints                                       |
| **Current mitigations** | Tailscale auth option, bind to loopback by default                   |
| **Residual risk**       | Medium - public gateways discoverable                                |
| **Recommendations**     | Document secure deployment, add rate limiting on discovery endpoints |

#### T-RECON-002: Channel integration probing

| Attribute               | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0006 - Active Scanning                                        |
| **Description**         | Attacker probes messaging channels to identify AI-managed accounts |
| **Attack vector**       | Sending test messages, observing response patterns                 |
| **Affected components** | All channel integrations                                           |
| **Current mitigations** | None specific                                                      |
| **Residual risk**       | Low - limited value from discovery alone                           |
| **Recommendations**     | Consider response timing randomization                             |

---

### 3.2 Initial access (AML.TA0004)

#### T-ACCESS-001: Pairing code interception

| Attribute               | Value                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                                                             |
| **Description**         | Attacker intercepts a pairing code during the pairing window (1h DM/generic pairing, 5m node pairing) |
| **Attack vector**       | Shoulder surfing, network sniffing, social engineering                                                |
| **Affected components** | Device pairing system                                                                                 |
| **Current mitigations** | 1h TTL (DM/generic pairing), 5m TTL (node pairing); codes sent via the existing channel               |
| **Residual risk**       | Medium - pairing window exploitable                                                                   |
| **Recommendations**     | Reduce pairing window, add a confirmation step                                                        |

#### T-ACCESS-002: AllowFrom spoofing

| Attribute               | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                                      |
| **Description**         | Attacker spoofs an allowed sender identity on a channel                        |
| **Attack vector**       | Channel-dependent - phone number spoofing, username impersonation              |
| **Affected components** | Per-channel AllowFrom validation                                               |
| **Current mitigations** | Channel-specific identity verification                                         |
| **Residual risk**       | Medium - some channels remain vulnerable to spoofing                           |
| **Recommendations**     | Document channel-specific risks, add cryptographic verification where possible |

#### T-ACCESS-003: Token theft

| Attribute               | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access                          |
| **Description**         | Attacker steals authentication tokens from config/credential files |
| **Attack vector**       | Malware, unauthorized device access, config backup exposure        |
| **Affected components** | Channel/provider credential storage, config storage                |
| **Current mitigations** | File permissions                                                   |
| **Residual risk**       | High - tokens stored in plaintext on disk                          |
| **Recommendations**     | Implement token encryption at rest, add token rotation             |

---

### 3.3 Execution (AML.TA0005)

#### T-EXEC-001: Direct prompt injection

| Attribute               | Value                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                                                                                                 |
| **Description**         | Attacker sends crafted prompts to manipulate agent behavior                                                                                  |
| **Attack vector**       | Channel messages containing adversarial instructions                                                                                         |
| **Affected components** | Agent LLM, all input surfaces                                                                                                                |
| **Current mitigations** | Pattern detection, external content wrapping; treated as out-of-scope for vulnerability reports absent a boundary bypass (see `SECURITY.md`) |
| **Residual risk**       | Critical - detection only, no blocking; sophisticated attacks bypass                                                                         |
| **Recommendations**     | Output validation and user confirmation for sensitive actions, layered on top of existing detection                                          |

#### T-EXEC-002: Indirect prompt injection

| Attribute               | Value                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0051.001 - LLM Prompt Injection: Indirect                                                                        |
| **Description**         | Attacker embeds malicious instructions in fetched content                                                             |
| **Attack vector**       | Malicious URLs, poisoned emails, compromised webhooks                                                                 |
| **Affected components** | `web_fetch`, email ingestion, external data sources                                                                   |
| **Current mitigations** | Content wrapping with random-boundary XML-style markers, homoglyph/special-token normalization, and a security notice |
| **Residual risk**       | High - LLM may still ignore wrapper instructions                                                                      |
| **Recommendations**     | Separate execution contexts for wrapped content                                                                       |

#### T-EXEC-003: Tool argument injection

| Attribute               | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| **ATLAS ID**            | AML.T0051.000 - LLM Prompt Injection: Direct                 |
| **Description**         | Attacker manipulates tool arguments through prompt injection |
| **Attack vector**       | Crafted prompts that influence tool parameter values         |
| **Affected components** | All tool invocations                                         |
| **Current mitigations** | Exec approvals for dangerous commands                        |
| **Residual risk**       | High - relies on user judgment                               |
| **Recommendations**     | Argument validation, parameterized tool calls                |

#### T-EXEC-004: Exec approval bypass

| Attribute               | Value                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                                                                                                                                |
| **Description**         | Attacker crafts commands that bypass the approval allowlist                                                                                                                       |
| **Attack vector**       | Command obfuscation, alias exploitation, path manipulation                                                                                                                        |
| **Affected components** | `src/infra/exec-approvals*.ts`, command allowlist                                                                                                                                 |
| **Current mitigations** | Allowlist + ask mode, plus command normalization (dispatch-wrapper unwrapping, inline-eval detection, shell-chain analysis)                                                       |
| **Residual risk**       | High - normalization narrows but does not eliminate obfuscation bypass; parity-only findings between exec paths are treated as hardening, not vulnerabilities (see `SECURITY.md`) |
| **Recommendations**     | Continue expanding command-normalization coverage against new obfuscation techniques                                                                                              |

---

### 3.4 Persistence (AML.TA0006)

#### T-PERSIST-001: Malicious skill installation

| Attribute               | Value                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                                                                      |
| **Description**         | Attacker publishes a malicious skill to ClawHub                                                                           |
| **Attack vector**       | Create account, publish skill with hidden malicious code                                                                  |
| **Affected components** | ClawHub, skill loading, agent execution                                                                                   |
| **Current mitigations** | GitHub account age verification, static pattern/AST-adjacent scanning, LLM-based agentic risk review, VirusTotal scanning |
| **Residual risk**       | High - detection layers exist but skills still run with agent privileges and no execution sandboxing                      |
| **Recommendations**     | Skill execution sandboxing, expanded community review                                                                     |

#### T-PERSIST-002: Skill update poisoning

| Attribute               | Value                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.001 - Supply Chain Compromise: AI Software                    |
| **Description**         | Attacker compromises a popular skill and pushes a malicious update      |
| **Attack vector**       | Account compromise, social engineering of skill owner                   |
| **Affected components** | ClawHub versioning, auto-update flows                                   |
| **Current mitigations** | Version fingerprinting, moderation/scanning re-run on new versions      |
| **Residual risk**       | High - auto-updates may pull malicious versions before review completes |
| **Recommendations**     | Update signing, rollback capability, version pinning                    |

#### T-PERSIST-003: Agent configuration tampering

| Attribute               | Value                                                           |
| ----------------------- | --------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0010.002 - Supply Chain Compromise: Data                   |
| **Description**         | Attacker modifies agent configuration to persist access         |
| **Attack vector**       | Config file modification, settings injection                    |
| **Affected components** | Agent config, tool policies                                     |
| **Current mitigations** | File permissions                                                |
| **Residual risk**       | Medium - requires local access                                  |
| **Recommendations**     | Config integrity verification, audit logging for config changes |

---

### 3.5 Defense evasion (AML.TA0007)

#### T-EVADE-001: Moderation pattern bypass

| Attribute               | Value                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                                    |
| **Description**         | Attacker crafts skill content to evade ClawHub moderation checks                      |
| **Attack vector**       | Unicode homoglyphs, encoding tricks, dynamic loading                                  |
| **Affected components** | ClawHub moderation/scanning pipeline                                                  |
| **Current mitigations** | Static pattern rules, AST-adjacent code scanning, LLM agentic-risk review, VirusTotal |
| **Residual risk**       | Medium - novel obfuscation can still slip past layered heuristics                     |
| **Recommendations**     | Continue expanding the pattern/behavioral corpus as new evasions are found            |

#### T-EVADE-002: Content wrapper escape

| Attribute               | Value                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0043 - Craft Adversarial Data                                                                            |
| **Description**         | Attacker crafts content that escapes the external-content wrapper context                                     |
| **Attack vector**       | Tag manipulation, context confusion, instruction override                                                     |
| **Affected components** | External content wrapping                                                                                     |
| **Current mitigations** | Random-boundary XML-style markers + security notice, plus homoglyph/whitespace-variant marker-spoof detection |
| **Residual risk**       | Medium - novel escapes discovered regularly                                                                   |
| **Recommendations**     | Output-side validation in addition to input-side wrapping                                                     |

---

### 3.6 Discovery (AML.TA0008)

#### T-DISC-001: Tool enumeration

| Attribute               | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access             |
| **Description**         | Attacker enumerates available tools through prompting |
| **Attack vector**       | "What tools do you have?" style queries               |
| **Affected components** | Agent tool registry                                   |
| **Current mitigations** | None specific                                         |
| **Residual risk**       | Low - tools are generally documented                  |
| **Recommendations**     | Consider tool visibility controls                     |

#### T-DISC-002: Session data extraction

| Attribute               | Value                                                   |
| ----------------------- | ------------------------------------------------------- |
| **ATLAS ID**            | AML.T0040 - AI Model Inference API Access               |
| **Description**         | Attacker extracts sensitive data from session context   |
| **Attack vector**       | "What did we discuss?" queries, context probing         |
| **Affected components** | Session transcripts, context window                     |
| **Current mitigations** | Session isolation per sender (`agent:channel:peer` key) |
| **Residual risk**       | Medium - within-session data is accessible by design    |
| **Recommendations**     | Sensitive-data redaction in context                     |

---

### 3.7 Collection and exfiltration (AML.TA0009, AML.TA0010)

#### T-EXFIL-001: Data theft via web_fetch

| Attribute               | Value                                                                            |
| ----------------------- | -------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                                           |
| **Description**         | Attacker exfiltrates data by instructing the agent to send it to an external URL |
| **Attack vector**       | Prompt injection causing the agent to POST data to an attacker server            |
| **Affected components** | `web_fetch` tool                                                                 |
| **Current mitigations** | SSRF blocking for internal/private networks (DNS pinning + IP blocking)          |
| **Residual risk**       | High - arbitrary external URLs remain permitted                                  |
| **Recommendations**     | URL allowlisting, data-classification awareness                                  |

#### T-EXFIL-002: Unauthorized message sending

| Attribute               | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                               |
| **Description**         | Attacker causes the agent to send messages containing sensitive data |
| **Attack vector**       | Prompt injection causing the agent to message the attacker           |
| **Affected components** | Message tool, channel integrations                                   |
| **Current mitigations** | Outbound messaging gating                                            |
| **Residual risk**       | Medium - gating may be bypassed                                      |
| **Recommendations**     | Explicit confirmation for new recipients                             |

#### T-EXFIL-003: Credential harvesting

| Attribute               | Value                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0009 - Collection                                                                                                                                  |
| **Description**         | Malicious skill harvests credentials from the agent context                                                                                             |
| **Attack vector**       | Skill code reads environment variables, config files                                                                                                    |
| **Affected components** | Skill execution environment                                                                                                                             |
| **Current mitigations** | ClawHub credential-pattern scanning (hardcoded secrets, credential env access paired with network sends); no execution sandboxing for skills at runtime |
| **Residual risk**       | Critical - skills run with agent privileges                                                                                                             |
| **Recommendations**     | Skill execution sandboxing, credential isolation                                                                                                        |

---

### 3.8 Impact (AML.TA0011)

#### T-IMPACT-001: Unauthorized command execution

| Attribute               | Value                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                                                                 |
| **Description**         | Attacker executes arbitrary commands on the user system                                              |
| **Attack vector**       | Prompt injection combined with exec approval bypass                                                  |
| **Affected components** | Bash tool, command execution                                                                         |
| **Current mitigations** | Exec approvals, Docker sandbox option (default runtime backend)                                      |
| **Residual risk**       | Critical - host execution possible when sandbox is disabled                                          |
| **Recommendations**     | Improve approval UX; sandbox-off deployments remain a deliberate operator choice, documented as such |

#### T-IMPACT-002: Resource exhaustion (DoS)

| Attribute               | Value                                              |
| ----------------------- | -------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity               |
| **Description**         | Attacker exhausts API credits or compute resources |
| **Attack vector**       | Automated message flooding, expensive tool calls   |
| **Affected components** | Gateway, agent sessions, API provider              |
| **Current mitigations** | None                                               |
| **Residual risk**       | High - no per-sender rate limiting                 |
| **Recommendations**     | Per-sender rate limits, cost budgets               |

#### T-IMPACT-003: Reputation damage

| Attribute               | Value                                                       |
| ----------------------- | ----------------------------------------------------------- |
| **ATLAS ID**            | AML.T0031 - Erode AI Model Integrity                        |
| **Description**         | Attacker causes the agent to send harmful/offensive content |
| **Attack vector**       | Prompt injection causing inappropriate responses            |
| **Affected components** | Output generation, channel messaging                        |
| **Current mitigations** | LLM provider content policies                               |
| **Residual risk**       | Medium - provider filters are imperfect                     |
| **Recommendations**     | Output filtering layer, user controls                       |

---

## 4. ClawHub supply chain analysis

### 4.1 Current security controls

| Control                        | Implementation                                                                        | Effectiveness                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| GitHub account age             | `requireGitHubAccountAge()` (14-day minimum)                                          | Medium - raises the bar for new attackers                           |
| Path sanitization              | `sanitizePath()`                                                                      | High - prevents path traversal                                      |
| File type validation           | `isTextFile()`                                                                        | Medium - only text files scanned, but still exploitable             |
| Size limits                    | 50MB total bundle (`MAX_PUBLISH_TOTAL_BYTES`)                                         | High - prevents resource exhaustion                                 |
| Required SKILL.md              | Mandatory readme on publish                                                           | Low security value - informational only                             |
| Static + AST-adjacent scanning | Pattern engine covering exec, exfiltration, credential-harvest, obfuscation, and more | Medium-High - covers many known abuse patterns, still pattern-based |
| LLM-based agentic risk review  | Security-prompt-driven verdict on publish                                             | Medium-High - catches behavior static patterns miss                 |
| VirusTotal scanning            | Wired to skill and package-release publish/rescan flows, gated on operator API key    | High when enabled - static engine detection                         |
| Moderation status              | `moderationStatus` field                                                              | Medium - manual review possible                                     |

### 4.2 Moderation limitations

ClawHub's static scanning inspects skill code content directly (not just slug/metadata/frontmatter), covering dangerous exec calls, dynamic code execution, credential harvesting, exfiltration patterns, obfuscated payloads, and more. Known gaps:

- Pattern-based detection can still be bypassed by sufficiently novel obfuscation.
- LLM-based review and VirusTotal scanning depend on operator-side API keys/config being enabled.
- No runtime execution sandbox isolates a skill from the agent's own privileges once installed.

### 4.3 Badges

Skills and packages carry moderator-assigned badges: `highlighted`, `official`, `deprecated`, `redactionApproved` (skills only). Community reporting (`skillReports`) and audit logging (`auditLogs`) back moderation workflows.

---

## 5. Risk matrix

### 5.1 Likelihood vs impact

| Threat ID     | Likelihood | Impact   | Risk level   | Priority |
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

### 5.2 Critical path attack chains

**Chain 1: Skill-based data theft**

```text
T-PERSIST-001 → T-EVADE-001 → T-EXFIL-003
(Publish malicious skill) → (Evade moderation) → (Harvest credentials)
```

**Chain 2: Prompt injection to RCE**

```text
T-EXEC-001 → T-EXEC-004 → T-IMPACT-001
(Inject prompt) → (Bypass exec approval) → (Execute commands)
```

**Chain 3: Indirect injection via fetched content**

```text
T-EXEC-002 → T-EXFIL-001 → External exfiltration
(Poison URL content) → (Agent fetches & follows instructions) → (Data sent to attacker)
```

---

## 6. Recommendations summary

### 6.1 Immediate (P0)

| ID    | Recommendation                              | Addresses                  |
| ----- | ------------------------------------------- | -------------------------- |
| R-002 | Implement skill execution sandboxing        | T-PERSIST-001, T-EXFIL-003 |
| R-003 | Add output validation for sensitive actions | T-EXEC-001, T-EXEC-002     |

### 6.2 Short-term (P1)

| ID    | Recommendation                                                        | Addresses    |
| ----- | --------------------------------------------------------------------- | ------------ |
| R-004 | Implement per-sender rate limiting                                    | T-IMPACT-002 |
| R-005 | Add token encryption at rest                                          | T-ACCESS-003 |
| R-006 | Improve exec approval UX and continue expanding command normalization | T-EXEC-004   |
| R-007 | Implement URL allowlisting for `web_fetch`                            | T-EXFIL-001  |

### 6.3 Medium-term (P2)

| ID    | Recommendation                                        | Addresses     |
| ----- | ----------------------------------------------------- | ------------- |
| R-008 | Add cryptographic channel verification where possible | T-ACCESS-002  |
| R-009 | Implement config integrity verification               | T-PERSIST-003 |
| R-010 | Add update signing and version pinning                | T-PERSIST-002 |

---

## 7. Appendices

### 7.1 ATLAS technique mapping

| ATLAS ID      | Technique name                 | OpenClaw threats                                                 |
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

### 7.2 Key security files

| Path                                | Purpose                        | Risk level   |
| ----------------------------------- | ------------------------------ | ------------ |
| `src/infra/exec-approvals.ts`       | Command approval logic         | **Critical** |
| `src/gateway/auth.ts`               | Gateway authentication         | **Critical** |
| `src/infra/net/ssrf.ts`             | SSRF protection                | **Critical** |
| `src/security/external-content.ts`  | Prompt injection mitigation    | **Critical** |
| `src/agents/sandbox/tool-policy.ts` | Sandbox tool allow/deny policy | **Critical** |
| `src/routing/resolve-route.ts`      | Session isolation / routing    | **Medium**   |

### 7.3 Glossary

| Term                 | Definition                                                |
| -------------------- | --------------------------------------------------------- |
| **ATLAS**            | MITRE's Adversarial Threat Landscape for AI Systems       |
| **ClawHub**          | OpenClaw's skill marketplace                              |
| **Gateway**          | OpenClaw's message routing and authentication layer       |
| **MCP**              | Model Context Protocol - tool provider interface          |
| **Prompt injection** | Attack where malicious instructions are embedded in input |
| **Skill**            | Downloadable extension for OpenClaw agents                |
| **SSRF**             | Server-Side Request Forgery                               |

---

_This threat model is a living document. Report security issues to `security@openclaw.ai` or see the [Trust page](https://trust.openclaw.ai)._

## Related

- [Contributing to the threat model](/security/CONTRIBUTING-THREAT-MODEL)
- [Incident response](/security/incident-response)
- [Network proxy](/security/network-proxy)
- [Formal verification](/security/formal-verification)
