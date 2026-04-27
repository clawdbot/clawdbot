---
summary: "How to contribute to the OpenClaw threat model"
title: "Contributing to the threat model"
read_when:
  - You want to contribute security findings or threat scenarios
  - Reviewing or updating the threat model
---

# Contributing to the OpenClaw Threat Model

Thanks for helping make OpenClaw more secure. This threat model is a living document and we welcome contributions from anyone - you don't need to be a security expert.

## Ways to Contribute

### Add a Threat

Spotted an attack vector or risk we haven't covered? Open an issue on [openclaw/trust](https://github.com/openclaw/trust/issues) and describe it in your own words. You don't need to know any frameworks or fill in every field - just describe the scenario.

**Helpful to include (but not required):**

- The attack scenario and how it could be exploited
- Which parts of OpenClaw are affected (CLI, gateway, channels, ClawHub, MCP servers, etc.)
- How severe you think it is (low / medium / high / critical)
- Any links to related research, CVEs, or real-world examples

We'll handle the ATLAS mapping, threat IDs, and risk assessment during review. If you want to include those details, great - but it's not expected.

> **This is for adding to the threat model, not reporting live vulnerabilities.** If you've found an exploitable vulnerability, see our [Trust page](https://trust.openclaw.ai) for responsible disclosure instructions.

### Suggest a Mitigation

Have an idea for how to address an existing threat? Open an issue or PR referencing the threat. Useful mitigations are specific and actionable - for example, "per-sender rate limiting of 10 messages/minute at the gateway" is better than "implement rate limiting."

### Propose an Attack Chain

Attack chains show how multiple threats combine into a realistic attack scenario. If you see a dangerous combination, describe the steps and how an attacker would chain them together. A short narrative of how the attack unfolds in practice is more valuable than a formal template.

### Fix or Improve Existing Content

Typos, clarifications, outdated info, better examples - PRs welcome, no issue needed.

## What we use

### MITRE ATLAS

This threat model is built on [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems), a framework designed specifically for AI/ML threats like prompt injection, tool misuse, and agent exploitation. You don't need to know ATLAS to contribute - we map submissions to the framework during review.

### Threat IDs

Each threat gets an ID like `T-EXEC-003`. The categories are:

| Code    | Category                                   |
| ------- | ------------------------------------------ |
| RECON   | Reconnaissance - information gathering     |
| ACCESS  | Initial access - gaining entry             |
| EXEC    | Execution - running malicious actions      |
| PERSIST | Persistence - maintaining access           |
| EVADE   | Defense evasion - avoiding detection       |
| DISC    | Discovery - learning about the environment |
| EXFIL   | Exfiltration - stealing data               |
| IMPACT  | Impact - damage or disruption              |

IDs are assigned by maintainers during review. You don't need to pick one.

### Risk levels

| Level        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| **Critical** | Full system compromise, or high likelihood + critical impact      |
| **High**     | Significant damage likely, or medium likelihood + critical impact |
| **Medium**   | Moderate risk, or low likelihood + high impact                    |
| **Low**      | Unlikely and limited impact                                       |

If you're unsure about the risk level, just describe the impact and we'll assess it.

## Review process

1. **Triage** - We review new submissions within 48 hours
2. **Assessment** - We verify feasibility, assign ATLAS mapping and threat ID, validate risk level
3. **Documentation** - We ensure everything is formatted and complete
4. **Merge** - Added to the threat model and visualization

## Resources

- [ATLAS Website](https://atlas.mitre.org/)
- [ATLAS Techniques](https://atlas.mitre.org/techniques/)
- [ATLAS Case Studies](https://atlas.mitre.org/studies/)
- [OpenClaw Threat Model](/security/THREAT-MODEL-ATLAS)

## Contact

- **Security vulnerabilities:** See our [Trust page](https://trust.openclaw.ai) for reporting instructions
- **Threat model questions:** Open an issue on [openclaw/trust](https://github.com/openclaw/trust/issues)
- **General chat:** Discord #security channel

## Recognition

Contributors to the threat model are recognized in the threat model acknowledgments, release notes, and the OpenClaw security hall of fame for significant contributions.

## Related

- [Threat model](/security/THREAT-MODEL-ATLAS)
- [Formal verification](/security/formal-verification)
