---
title: OrbStack
icon: Expand
---

# OrbStack

[OrbStack](https://orbstack.dev/) is a fast, light, and easy way to run Docker containers and Linux machines on macOS. It's a great alternative to Docker Desktop, offering a seamless and efficient development experience. This guide will walk you through setting up Clawdbot on an OrbStack Linux machine.

## Prerequisites

- [OrbStack](https://orbstack.dev/) installed on your macOS.
- Basic familiarity with the command line.

## Setting Up a New Linux Machine

You can create a new Linux machine with a single command. For this guide, we'll use Ubuntu, but you can choose any distribution you prefer.

```bash
orb create ubuntu clawdbot-dev
```

This command creates a new Ubuntu machine named `clawdbot-dev`.

## Accessing the Machine

You can easily access the machine's shell using the `orb` command:

```bash
orb shell -m clawdbot-dev
```

## Installing Clawdbot

Once you're inside the machine, you can install Clawdbot using the standard installation script:

```bash
/bin/bash -c "$(curl -fsSL https://clawd.bot/install.sh)"
```

This will install the latest version of Clawdbot and its dependencies.

## Verifying the Installation

After the installation is complete, you can verify that Clawdbot is working correctly by running the `status` command:

```bash
clawdbot status
```

You should see a status report indicating that the Clawdbot services are running.

## Running Clawdbot Services

With OrbStack, your Linux machine's services are accessible on `localhost` on your Mac. This means you can run the Clawdbot gateway on your OrbStack machine and interact with it as if it were running directly on your Mac.

To start the Clawdbot gateway, run the following command inside your OrbStack machine:

```bash
clawdbot gateway run
```

You can now access the gateway and other Clawdbot services from your Mac.

## File Sharing

OrbStack automatically mounts your Mac's files at `/mnt/mac` within the Linux machine. This is useful for sharing configuration files or other data between your Mac and your Clawdbot environment.

For example, you can access your Mac's home directory at `/mnt/mac/Users/<your-username>`.

## Conclusion

Using OrbStack provides a powerful and efficient way to run Clawdbot in a sandboxed Linux environment on your Mac. The seamless integration between the host and the virtual machine makes it easy to manage your Clawdbot setup and develop your bot with ease.

## Exposing Your Clawdbot Instance with Cloudflare Tunnel

To securely access your Clawdbot instance from the internet, you can use [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/). This allows you to expose your local Clawdbot gateway to the world without opening up any ports on your firewall.

### 1. Install `cloudflared`

First, you need to install the `cloudflared` command-line tool on your Mac.

```bash
brew install cloudflared
```

### 2. Authenticate `cloudflared`

Next, authenticate `cloudflared` with your Cloudflare account. This command will open a browser window and ask you to log in to your Cloudflare account.

```bash
cloudflared tunnel login
```

### 3. Create a Tunnel

Now, create a tunnel that will point to your Clawdbot instance.

```bash
cloudflared tunnel create clawdbot-tunnel
```

This command will create a tunnel and give you a unique ID for it. You'll also see a `cert.pem` file created in a `.cloudflared` directory in your user's home directory.

### 4. Create a Configuration File

Create a configuration file for your tunnel. Create a file named `config.yml` in the `.cloudflared` directory (`~/.cloudflared/config.yml`).

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /Users/<YOUR_USERNAME>/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: clawdbot.your-domain.com
    service: http://localhost:8787
  - service: http_status:404
```

Replace `<YOUR_TUNNEL_ID>` with the ID you got in the previous step, `<YOUR_USERNAME>` with your macOS username, and `clawdbot.your-domain.com` with the domain or subdomain you want to use.

### 5. Start the Tunnel

Now you can start the tunnel:

```bash
cloudflared tunnel run clawdbot-tunnel
```

Your Clawdbot instance will now be accessible at the hostname you configured.

### 6. Keep Your Mac Awake

To ensure that your Clawdbot instance is always accessible, you'll need to prevent your Mac from sleeping. You can use the built-in `caffeinate` command for this.

Open a new terminal window and run:

```bash
caffeinate -d
```

This will prevent your Mac from sleeping as long as the command is running.

By following these steps, you can securely expose your Clawdbot instance running on an OrbStack machine to the internet, allowing you to access it from anywhere.

