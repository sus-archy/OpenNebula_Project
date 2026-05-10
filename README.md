# OpenNebula Research Portal

A local web portal for the OpenNebula project bonus tasks:

- users sign in with their OpenNebula credentials
- users can see templates, images, and their VMs
- users can launch a VM with dynamic CPU and RAM
- users can select a simulated GPU flag
- users can select a preconfigured environment label
- users can request an automatic startup task
- users can control VMs and open WebSSH from the browser

## Setup On Arch

1. Create the local environment file:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set the OpenNebula XML-RPC endpoint for the Linux Mint VM:

   ```bash
   OPENNEBULA_RPC_URL=http://MINT_VM_IP:2633/RPC2
   PORT=8787
   CLIENT_ORIGIN=http://localhost:5173
   SESSION_SECRET=replace-with-a-long-random-string
   ```

3. Confirm Arch can reach OpenNebula inside Mint:

   ```bash
   curl http://MINT_VM_IP:2633/RPC2
   ```

   Any HTTP response from that port is enough to prove the portal can reach the XML-RPC service.

4. Install and run:

   ```bash
   npm install
   npm run dev
   ```

5. Open the portal:

   ```text
   http://localhost:5173
   ```

## WebSSH Requirements

The portal opens SSH from the Arch machine to the selected VM IP. Each deployed VM must have:

- network access from Arch to the VM IP
- SSH server installed and running
- a known SSH username plus password or private key
- firewall rules allowing TCP port `22`

If a VM has no IP in the dashboard yet, wait for OpenNebula networking/contextualization to finish, then refresh.

## Auto Task Output

When `Auto task` is enabled, the portal injects a contextualization startup script that writes:

```text
/home/opennebula/portal-task.py
/home/opennebula/portal-result.json
/home/opennebula/portal-result.txt
```

This depends on the guest image supporting OpenNebula contextualization and running the `START_SCRIPT`.
