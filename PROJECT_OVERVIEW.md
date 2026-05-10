# Project Overview

This file describes the main project files and how the OpenNebula Research Portal works.

## What the project does

The project is a local web portal for managing OpenNebula virtual machines from the browser. A user can:

- sign in with OpenNebula credentials
- view templates, images, and their VMs
- launch a VM with custom CPU and RAM values
- enable a simulated GPU option
- enable an automatic startup task
- open a WebSSH terminal to a VM
- fetch the auto-task result and view it as a chart

## Main folders and files

### Root files

- `package.json` - project metadata, dependencies, and scripts
- `vite.config.ts` - Vite dev server config and API/WebSocket proxy rules
- `tsconfig.json` / `tsconfig.app.json` - TypeScript configuration
- `README.md` - short setup and usage instructions
- `.env` - local environment variables used by the portal
- `.env.example` - sample environment file

### `server/`

- `server/index.js` - Express API server and WebSSH backend
- `server/opennebula.js` - OpenNebula XML-RPC client and VM data parsing

### `src/`

- `src/main.tsx` - React UI for login, dashboard, VM launch, WebSSH, and charts
- `src/styles.css` - app styling
- `src/vite-env.d.ts` - Vite TypeScript typings

## How the app works

### 1. Login

The user logs in through the frontend. The browser sends the username and password to `POST /api/auth/login`.

The server validates the credentials against OpenNebula and stores a signed session cookie.

### 2. Dashboard data

After login, the frontend requests:

- `GET /api/templates`
- `GET /api/images`
- `GET /api/vms`

The server uses the OpenNebula XML-RPC API to fetch and normalize the data.

### 3. VM launch

The launch form lets the user choose:

- template
- VM name
- CPU
- RAM
- GPU simulation flag
- environment label
- auto-task option

When the user launches a VM, the frontend calls `POST /api/vms`.

The server builds an OpenNebula contextualization payload and instantiates the VM.

### 4. GPU simulation

The GPU option is not a real physical GPU passthrough.

It is a simulation flag stored in the VM contextualization data as `GPU_SIMULATION = "YES"` or `"NO"`.

The auto-task script can use that flag to produce different output or metadata, which is later shown in the UI.

### 5. Auto task

If the user enables Auto task, the portal injects a startup script into the VM context.

That script writes these files inside the guest:

- `/home/opennebula/portal-task.py`
- `/home/opennebula/portal-result.json`
- `/home/opennebula/portal-result.txt`

The script is meant to run inside the guest after boot and produce a JSON result that the portal can fetch later.

### 6. WebSSH

When the user opens a VM terminal, the frontend requests a temporary SSH token from `POST /api/ssh-token`.

The browser then opens a WebSocket connection to `/ssh?token=...`.

The server upgrades that socket, connects to the VM over SSH, and streams terminal data through the WebSocket.

If the VM is behind a nested network, the server can use a configured jump host from `.env`.

### 7. Result charts

The portal can fetch the auto-task result from the VM and render it as a chart.

The chart view is useful for showing:

- the generated sample values
- whether GPU simulation was enabled
- the selected environment

## Important environment variables

These variables are typically stored in `.env`:

- `OPENNEBULA_RPC_URL` - XML-RPC endpoint of the OpenNebula/Mint host
- `PORT` - API server port
- `CLIENT_ORIGIN` - allowed frontend origin
- `SESSION_SECRET` - cookie signing secret
- `SSH_JUMP_HOST` - optional jump host for nested VM networks
- `SSH_JUMP_PORT` - jump host SSH port
- `SSH_JUMP_USER` - jump host username
- `SSH_JUMP_PASSWORD` - jump host password
- `SSH_JUMP_PRIVATE_KEY` - jump host private key path or PEM contents
- `SSH_JUMP_MATCH_PREFIX` - IP prefix that should use the jump host

## Development flow

Run the project with:

```bash
npm install
npm run dev
```

This starts:

- the Express API server on `http://localhost:8787`
- the Vite frontend on `http://localhost:5173`

The frontend talks to the backend through the Vite proxy rules defined in `vite.config.ts`.

## High-level request flow

1. User logs in through the browser.
2. The server checks OpenNebula credentials.
3. The frontend loads templates, images, and VMs.
4. The user launches a VM or opens WebSSH.
5. The backend connects to the VM over SSH, using a jump host if needed.
6. The auto-task result can be fetched and displayed as a chart.
