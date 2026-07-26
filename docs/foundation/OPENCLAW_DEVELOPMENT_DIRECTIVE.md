---
title: "OpenClaw Development Directive"
version: "1.0"
status: "Foundational"
owner: "OpenClaw Operator"
last_reviewed: "2026-07-26"
category: "Governance"
source_document: "OPENCLAW_DEVELOPMENT_DIRECTIVE.md"
---

# OpenClaw Development Directive

Thank you for yesterday’s hard work. Before continuing, I want to reaffirm the
operating rules and long-term vision for this project.

All development must occur exclusively in the development environment and on
the `development` branch. Nothing may be moved to production until the work has
been fully implemented, tested, reviewed, and proven reliable. Production
deployment requires my explicit approval after I have personally tested and
accepted the developed application. Approval to develop, test, commit, or push
to `development` is not approval to deploy to production.

The application must eventually provide a dependable, unified system for asset
and property management. This includes integration with a Swift application
currently being developed in Cursor. The Swift application will allow me to
enter and manage assets using an iPhone as the primary front end.

The iPhone experience must support fast, natural interaction through:

- Voice input
- Quick-selection controls
- Simple asset creation and updates
- Easy access to maintenance information
- Clear review and approval workflows

The system must also process equipment manuals and other PDFs using approved
open-source AI models. It should extract useful, evidence-backed information
such as:

- Preventive-maintenance tasks and schedules
- Oil and fluid specifications
- Filter and replacement-part information
- Wrench and fastener sizes
- OEM part numbers
- Service intervals
- Capacities, tolerances, and torque specifications
- Safety warnings and operating procedures

Extracted information must remain traceable to its source document, page, and
relevant passage whenever possible. The system must clearly distinguish
verified source information from AI inference, uncertain findings, and missing
information. It must never fabricate specifications, part numbers, maintenance
requirements, or completed actions.

Reliability and usability are primary requirements. The application should be
intuitive enough for quick daily use while maintaining strong validation, audit
history, error handling, rollback protection, and data integrity. Important
actions must be reviewable, and potentially consequential changes must remain
under operator control.

The overall objective is a trustworthy, easy-to-use platform that turns voice
input, quick selections, asset records, manuals, and maintenance history into
accurate and actionable property-management information.

Development priorities should remain:

1. Correctness and safety
2. Source traceability and evidence
3. Reliability and data integrity
4. Simple, efficient user experience
5. Development testing and operator acceptance
6. Production deployment only after explicit approval
7. Keeping GitHub’s `development` and `production` branches current within
   their approved boundaries

Updating GitHub’s `development` branch is part of normal development. The
`production` branch may only be updated after explicit operator testing,
acceptance, and production authorization. Updating `development` never implies
permission to update or deploy `production`.

These principles govern all future architecture, implementation, testing,
documentation, and deployment decisions for this project.
