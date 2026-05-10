# Project Overview

This document explains what the project does, how the files fit together, and how the browser, backend, OpenNebula, and VM SSH connection flow interact.

## What this project is

This repository contains a local web portal for managing OpenNebula virtual machines from a browser.

The portal lets a user:

- log in with OpenNebula credentials
- inspect templates, images, and their VMs
- launch a VM with custom CPU and RAM values
- enable a simulated GPU flag
- enable an automatic startup task
- open a WebSSH terminal to a VM
- fetch the auto-task result and render it as a chart

The app is split into two main parts:

- a React frontend in `src/`
- an Express + SSH backend in `server/`

The backend is responsible for OpenNebula XML-RPC calls, session handling, WebSSH, and reading the VM auto-task result.

## Repository layout

### Root files

- `package.json` - dependencies and scripts
- `package-lock.json` - locked dependency versions
- `vite.config.ts` - Vite configuration and proxy setup
- `tsconfig.json` and `tsconfig.app.json` - TypeScript configuration
- `index.html` - Vite entry page
- `README.md` - short setup guide
- `PROJECT_OVERVIEW.md` - this detailed architecture guide
- `.env` - local runtime configuration
- `.env.example` - sample environment file
- `.gitignore` - ignored files such as `node_modules`, `dist`, and `.env`

### `server/`

- `server/index.js` - Express API server, session handling, WebSSH server, VM result fetch endpoint
- `server/opennebula.js` - OpenNebula XML-RPC client and data normalization helpers

### `src/`

- `src/main.tsx` - React UI for login, dashboard, launch form, WebSSH modal, and result charts
- `src/styles.css` - styling for the full UI
- `src/vite-env.d.ts` - Vite TypeScript declarations

### Build output and dependencies

- `dist/` - production build output created by Vite
- `node_modules/` - installed packages

## Architecture at a glance

The request path is:

1. User opens the frontend in the browser.
2. The React app calls the Express API for login and VM data.
3. The Express server talks to OpenNebula through XML-RPC.
4. When SSH is needed, the server connects to the VM over SSH using the `ssh2` library.
5. If the VM network is nested, the SSH connection can go through a configured jump host.
6. For WebSSH, the browser opens a WebSocket to the backend, and the backend bridges the SSH session to the browser terminal.
7. For auto-task results, the backend SSHes into the VM and reads `/home/opennebula/portal-result.json`.

## Frontend flow

The frontend lives in `src/main.tsx`.

### 1. App startup

When the page loads, `App()` checks whether the user already has a valid session by calling `GET /api/me`.

If the session exists, the dashboard is shown.

If not, the login page is shown.

### 2. Login screen

The login form sends:

- username
- password

to `POST /api/auth/login`.

If the login succeeds, the backend sets a signed cookie named `portal_sid`.

### 3. Dashboard data loading

Once logged in, `Dashboard()` requests:

- `GET /api/templates`
- `GET /api/images`
- `GET /api/vms`

Those values populate the summary cards, launch form, image list, and VM table.

### 4. VM launch form

`LaunchPanel()` lets the user select:

- template
- VM name
- CPU count
- RAM amount
- GPU simulation on/off
- environment label
- auto-task on/off

When the user clicks launch, the frontend sends a payload to `POST /api/vms`.

### 5. VM row actions

`VmPanel()` shows each VM with:

- name
- state
- size
- IP address
- actions for WebSSH, reboot, and power control

The WebSSH button opens the SSH terminal modal for that VM.

### 6. WebSSH modal

`TerminalModal()` asks for:

- host
- port
- SSH username
- password
- private key

It then either opens a terminal connection or fetches the auto-task result.

### 7. Result charts

If the user clicks the result button, the frontend calls `POST /api/vms/:id/result`.

The returned JSON is rendered as a chart with `chart.js` and `react-chartjs-2`.

## Backend flow

The backend lives in `server/index.js`.

### 1. Middleware setup

The server uses:

- `cors` to allow the frontend origin
- `express.json()` for request bodies
- `cookie-parser` for signed session cookies

### 2. Health endpoint

`GET /api/health` returns a simple status object and the OpenNebula RPC URL.

### 3. Login and session handling

`POST /api/auth/login`:

- receives username and password
- verifies them with OpenNebula
- stores the session in memory
- sets a signed `portal_sid` cookie

`requireAuth()` checks that cookie for protected routes.

### 4. OpenNebula data endpoints

The server exposes:

- `GET /api/templates`
- `GET /api/images`
- `GET /api/vms`
- `POST /api/vms`
- `POST /api/vms/:id/action`

These all use `getOpenNebula()` from `server/opennebula.js`.

### 5. SSH token endpoint

`POST /api/ssh-token` generates a short-lived token.

The browser uses that token to open the WebSocket at `/ssh?token=...`.

### 6. WebSocket upgrade

When the backend receives a WebSocket upgrade on `/ssh`, it:

- validates the token
- upgrades the connection
- waits for a `connect` message from the browser
- opens the SSH session to the VM
- relays terminal input/output between the browser and the VM

### 7. Auto-task result endpoint

`POST /api/vms/:id/result`:

- looks up the VM by ID
- gets the VM IP
- connects to the VM over SSH
- reads `/home/opennebula/portal-result.json`
- parses the JSON and returns it to the frontend

This endpoint reuses the same SSH connection logic as WebSSH, including jump-host support.

## How the SSH connection works

The SSH flow is the most important part of the project for nested VM networking.

### Direct SSH path

If the VM is reachable directly, the backend calls `ssh2` with:

- host
- port
- username
- password or private key

### Jump host path

If the VM IP matches `SSH_JUMP_MATCH_PREFIX`, the server connects to `SSH_JUMP_HOST` first.

Then it uses `forwardOut()` to open a tunnel from the jump host to the VM.

That means the browser does not connect to the VM directly. The backend creates the SSH route on behalf of the browser.

### Private key handling

`SSH_JUMP_PRIVATE_KEY` can be:

- PEM text
- or a file path to the key on disk

The backend resolves the value before passing it to `ssh2`.

## What the GPU option means

The GPU option in the launch form is a simulation flag, not real GPU passthrough.

When enabled, the portal injects:

- `GPU_SIMULATION = "YES"`

into the VM contextualization data.

When disabled, it injects:

- `GPU_SIMULATION = "NO"`

The guest script can use that flag to produce different sample data or different task metadata.

This is useful for demonstrating how an application might react to GPU-enabled versus non-GPU-enabled workloads without needing actual GPU hardware.

## How the auto-task works

The Auto task feature is also a simulation of guest-side work.

When the user enables Auto task during VM launch, the backend injects a contextualization `START_SCRIPT`.

That script writes:

- `/home/opennebula/portal-task.py`
- `/home/opennebula/portal-result.json`
- `/home/opennebula/portal-result.txt`

The script currently generates a JSON object with fields like:

- `environment`
- `gpu_simulation`
- `samples`

Later, the portal fetches the JSON file and draws the chart from the `samples` data.

## Important environment variables

These are usually stored in `.env`:

- `OPENNEBULA_RPC_URL` - XML-RPC endpoint of the OpenNebula or Mint host
- `PORT` - backend API port
- `CLIENT_ORIGIN` - allowed frontend origin
- `SESSION_SECRET` - cookie signing secret
- `SSH_JUMP_HOST` - jump host used for nested VM networks
- `SSH_JUMP_PORT` - SSH port of the jump host
- `SSH_JUMP_USER` - jump host username
- `SSH_JUMP_PASSWORD` - jump host password
- `SSH_JUMP_PRIVATE_KEY` - jump host private key path or PEM contents
- `SSH_JUMP_MATCH_PREFIX` - VM IP prefix that should use the jump host

## Development workflow

Start the project with:

```bash
npm install
npm run dev
```

That runs:

- the backend on `http://localhost:8787`
- the frontend on `http://localhost:5173`

The Vite dev server proxies `/api` and `/ssh` requests to the backend.

## File-by-file explanation

### `package.json`

Defines the scripts and dependencies used by the app.

Key dependencies include:

- `express` for the API server
- `ssh2` for SSH connections
- `ws` for WebSocket handling
- `fast-xml-parser` for OpenNebula XML-RPC parsing
- `react`, `react-dom`, and Vite for the frontend
- `chart.js` and `react-chartjs-2` for result charts

### `vite.config.ts`

Configures the frontend dev server and proxy routes so the browser can call the backend using the same origin.

### `server/opennebula.js`

Contains the OpenNebula XML-RPC client.

It handles:

- XML-RPC request serialization
- XML response parsing
- template, image, and VM data normalization
- contextualization payload construction
- auto-task script generation

### `server/index.js`

Contains the app server and SSH bridge.

It handles:

- login and cookie sessions
- OpenNebula API endpoints
- SSH token generation
- WebSocket upgrade for WebSSH
- SSH jump-host routing
- auto-task result retrieval

### `src/main.tsx`

Contains the user interface.

It handles:

- login form
- dashboard loading
- VM launch form
- VM actions
- WebSSH modal
- result chart display

### `src/styles.css`

Contains the visual design for the portal.

### `README.md`

Contains the quick setup instructions for new users.

## High-level flow summary

1. User logs in through the browser.
2. The backend verifies OpenNebula credentials and sets a session.
3. The dashboard loads templates, images, and VM data.
4. The user launches a VM with CPU, RAM, GPU simulation, and auto-task options.
5. OpenNebula contextualization starts the guest with the requested settings.
6. The user opens WebSSH or fetches the auto-task result.
7. The backend reaches the VM directly or through the jump host, depending on the IP range.
8. The portal renders the SSH terminal or the chart result in the browser.

## What a reader should understand from this project

This project is not just a UI for OpenNebula.

It demonstrates a full stack workflow:

- browser UI for VM management
- backend API that talks to OpenNebula
- SSH bridging into guest VMs
- jump-host handling for nested networks
- contextualization-based automation inside the guest
- chart visualization of guest-generated results

That combination is what makes the portal useful for showing how an OpenNebula deployment can be controlled and observed from one interface.
