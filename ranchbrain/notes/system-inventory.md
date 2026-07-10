# System Inventory

## Core Hosts

### Intel mini

Role: Always-on OpenClaw server
Runs:

- OpenClaw Gateway
- Dashboard
- PropertyManager API
- Ranch Bot Telegram polling
- PostgreSQL
- Redis
- Home Assistant
- Scrypted
- Portainer

### M4 Mac

Role: AI model host and Time Machine client
Runs:

- Ollama
- M4 model inventory
- Time Machine to QNAP

## Network Storage

### QNAP

Time Machine share:

- MacTimeMachine
- Current IP: 192.168.50.86

## AI

### M4 Ollama

Current working IP from Intel mini:

- 192.168.50.233
