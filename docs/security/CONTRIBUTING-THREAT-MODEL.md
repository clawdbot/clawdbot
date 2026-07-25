---
summary: "How to contribute to the OpenClaw threat model"
title: "Contributing to the threat model"
read_when:
  - You want to contribute security findings or threat scenarios
  - Reviewing or updating the threat model
---

The [threat model](/security/THREAT-MODEL-ATLAS) is a living document. Contributions are welcome from anyone; you do not need security or MITRE ATLAS background.

<Note>
This is for adding to the threat model, not reporting live vulnerabilities. If you found an exploitable vulnerability, follow the responsible-disclosure instructions on the [Trust page](https://trust.openclaw.ai) instead.
</Note>

## Ways to contribute

**Add a threat.** Open an issue on [openclaw/trust](https://github.com/openclaw/trust/issues) describing the attack scenario in your own words. Helpful but not required:

- The attack scenario and how it could be exploited.
- Which components are affected (CLI, gateway, channels, ClawHub, MCP servers, etc.).
- Your estimate of severity (low / medium / high / critical).
- Links to related research, CVEs, or real-world examples.

Maintainers assign the ATLAS mapping, threat ID, and risk level during review.

**Suggest a mitigation.** Open an issue or PR referencing the threat. Be specific and actionable: "per-sender rate limiting of 10 messages/minute at the gateway" is more useful than "implement rate limiting."

**Propose an attack chain.** Attack chains show how multiple threats combine into a realistic scenario. Describe the steps and how an attacker would chain them; a short narrative beats a formal template.

**Fix or improve existing content.** Typos, clarifications, outdated info, better examples: PRs welcome, no issue needed.

## Framework reference

Threats are mapped to [MITRE ATLAS](https://atlas.mitre.org/) (Adversarial Threat Landscape for AI Systems), a framework for AI/ML-specific threats like prompt injection, tool misuse, and agent exploitation. You do not need to know ATLAS to contribute; maintainers map submissions during review.

**Threat IDs.** Each threat gets an ID like `T-EXEC-003`, assigned by maintainers during review.

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

**Risk levels.** If you are unsure about the level, just describe the impact; maintainers assess it.

| Level        | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| **Critical** | Full system compromise, or high likelihood + critical impact      |
| **High**     | Significant damage likely, or medium likelihood + critical impact |
| **Medium**   | Moderate risk, or low likelihood + high impact                    |
| **Low**      | Unlikely and limited impact                                       |

## Review process

1. **Triage** - new submissions are reviewed within 48 hours.
2. **Assessment** - maintainers verify feasibility, assign ATLAS mapping and threat ID, validate risk level.
3. **Documentation** - formatting and completeness pass.
4. **Merge** - added to the threat model and visualization.

## Resources

- [ATLAS website](https://atlas.mitre.org/)
- [ATLAS techniques](https://atlas.mitre.org/techniques/)
- [ATLAS case studies](https://atlas.mitre.org/studies/)

## Contact

- **Security vulnerabilities:** [Trust page](https://trust.openclaw.ai) for reporting instructions, or `security@openclaw.ai`.
- **Threat model questions:** open an issue on [openclaw/trust](https://github.com/openclaw/trust/issues).
- **General chat:** Discord `#security` channel.

## Recognition

Contributors to the threat model are recognized in the threat model acknowledgments, release notes, and the OpenClaw security hall of fame for significant contributions.

## Related

- [Threat model](/security/THREAT-MODEL-ATLAS)
- [Incident response](/security/incident-response)
- [Formal verification](/security/formal-verification)
