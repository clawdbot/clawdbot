---
summary: "Adds the WhatsApp channel surface for sending and receiving OpenClaw messages."
read_when:
  - You are installing, configuring, or auditing the whatsapp plugin
title: "WhatsApp plugin"
---

# WhatsApp plugin

Adds the WhatsApp channel surface for sending and receiving OpenClaw messages.

## Distribution

- Package: `@openclaw/whatsapp`
- Install route: npm; ClawHub

## Surface

channels: whatsapp

## Windows install note

On Windows, the WhatsApp plugin needs Git on `PATH` during npm install because one of its Baileys/libsignal dependencies is fetched from a git URL. Install Git for Windows, then restart the shell and rerun the install:

```powershell
winget install --id Git.Git -e
```

Portable Git also works if its `bin` directory is on `PATH`.

## Related docs

- [whatsapp](/channels/whatsapp)
