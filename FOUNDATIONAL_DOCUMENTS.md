# OpenClaw Foundational Documentation

Version: 1.0
Status: Foundational
Owner: OpenClaw Architecture
Last Updated: 2026-07-19

---

# Purpose

This document is the master index for the foundational documentation that defines the OpenClaw platform.

Every major architectural decision should be documented in one of the referenced documents below rather than duplicated elsewhere.

This document serves as the starting point for developers, operators, and AI agents.

---

# Guiding Principles

- Local-first whenever practical.
- Safety before automation.
- Verify before trusting.
- Recover before replacing.
- Documentation is part of the product.
- AI assists but does not bypass governance.

---

# Foundation Library

## Project Vision

PROJECT_OVERVIEW.md

Defines the mission, scope, and long-term direction of OpenClaw.

---

## Architecture

RANCHBOT_ARCHITECTURE.md

Defines system architecture, service relationships, routing, and component responsibilities.

---

## Operational Philosophy

SOUL.md

Defines the long-term philosophy, values, and operating principles of OpenClaw.

---

## Disaster Recovery

RESTORE_MANIFEST.md

Authoritative specification governing all backup verification, restore operations, rollback behavior, and disaster recovery.

---

## Dashboard

DASHBOARD_REPORT.md

Documents the Backup & Recovery Center and dashboard architecture.

---

## Engineering

TOOLS.md

Documents engineering tools, workflows, utilities, and development practices.

---

## AI Knowledge

PROJECT_CONTEXT.md

Provides project context for AI assistants and development sessions.

---

## RanchBrain

knowledge/
ranchbrain/

Authoritative knowledge repository for property management, operational procedures, and institutional memory.

---

# Governance Rules

Foundational documents should:

- describe policy rather than implementation
- avoid duplication
- remain stable over time
- be version controlled
- be reviewed before major architectural changes

---

# Document Hierarchy

Mission
↓
Architecture
↓
Governance
↓
Implementation
↓
Operations

Implementation must never contradict governance.

---

# Change Control

Changes to foundational documents should accompany major architectural changes and be reviewed before implementation.

---

# Future Foundation Documents

Reserved for:

- Security Manifest
- AI Governance Manifest
- Coding Standards
- Service Contracts
- Database Standards
- API Standards
- Monitoring Standards
- Testing Standards
- Deployment Standards
- Operations Runbook
- Incident Response Guide
- Home Assistant Integration Guide

---

# Foundational Statement

A healthy system is built on shared understanding.

Documentation preserves that understanding across time, people, and AI systems.
