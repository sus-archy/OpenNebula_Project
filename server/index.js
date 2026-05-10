import { config as loadEnv } from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Client as SshClient } from 'ssh2';
import { OpenNebulaClient } from './opennebula.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ quiet: true });

const app = express();
const port = Number(process.env.PORT || 8787);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sessions = new Map();
const sshTokens = new Map();

app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(sessionSecret));

app.get('/api/health', (_req, res) => {
  loadEnv({ override: true, quiet: true });
  res.json({ ok: true, opennebulaRpcUrl: process.env.OPENNEBULA_RPC_URL || null });
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      res.status(400).json({ message: 'Username and password are required.' });
      return;
    }

    const oneSession = `${username}:${password}`;
    await getOpenNebula().verifySession(oneSession);

    const sid = crypto.randomUUID();
    sessions.set(sid, { username, oneSession, createdAt: Date.now() });
    res.cookie('portal_sid', sid, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 8,
    });
    res.json({ username });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  sessions.delete(req.sessionId);
  res.clearCookie('portal_sid');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

app.get('/api/templates', requireAuth, async (req, res, next) => {
  try {
    res.json(await getOpenNebula().getTemplates(req.user.oneSession));
  } catch (error) {
    next(error);
  }
});

app.get('/api/images', requireAuth, async (req, res, next) => {
  try {
    res.json(await getOpenNebula().getImages(req.user.oneSession));
  } catch (error) {
    next(error);
  }
});

app.get('/api/vms', requireAuth, async (req, res, next) => {
  try {
    res.json(await getOpenNebula().getVms(req.user.oneSession));
  } catch (error) {
    next(error);
  }
});

app.post('/api/vms', requireAuth, async (req, res, next) => {
  try {
    const vmId = await getOpenNebula().instantiateVm(req.user.oneSession, req.body || {});
    res.status(201).json({ id: vmId });
  } catch (error) {
    next(error);
  }
});

app.post('/api/vms/:id/action', requireAuth, async (req, res, next) => {
  try {
    const action = String(req.body?.action || '');
    const allowed = new Set(['poweroff', 'resume', 'reboot', 'terminate']);

    if (!allowed.has(action)) {
      res.status(400).json({ message: 'Unsupported VM action.' });
      return;
    }

    await getOpenNebula().vmAction(req.user.oneSession, action, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/ssh-token', requireAuth, (req, res) => {
  const token = crypto.randomUUID();
  sshTokens.set(token, { username: req.user.username, expiresAt: Date.now() + 60_000 });
  res.json({ token });
});

// Fetch auto-task result JSON from a VM via SSH. Expects body { username, password, privateKey }
app.post('/api/vms/:id/result', requireAuth, async (req, res, next) => {
  try {
    const vmId = Number(req.params.id);
    const vms = await getOpenNebula().getVms(req.user.oneSession);
    const vm = vms.find((v) => Number(v.id) === vmId);
    if (!vm) {
      res.status(404).json({ message: 'VM not found' });
      return;
    }

    const host = String(vm.ips?.[0] || '').trim();
    if (!host) {
      res.status(400).json({ message: 'VM has no IP address yet' });
      return;
    }

    const { username, password, privateKey } = req.body || {};

    // Use the same connectSsh flow as WebSSH (this honors the jump host config)
    const { ssh, jump } = await connectSsh({ host, username: username || '', password: password || '', privateKey: privateKey || '' });

    try {
      const result = await new Promise((resolve, reject) => {
        ssh.exec('cat /home/opennebula/portal-result.json', (err, stream) => {
          if (err) {
            reject(err);
            return;
          }

          let data = '';
          stream.on('data', (chunk) => (data += chunk.toString()));
          stream.on('close', (code, signal) => {
            if (!data) {
              reject(new Error('No result file found on VM'));
              return;
            }

            try {
              resolve(JSON.parse(data));
            } catch (parseErr) {
              reject(new Error('Invalid JSON in result file'));
            }
          });
          stream.stderr.on('data', (chunk) => {
            // capture stderr but don't fail immediately
          });
        });
      });

      res.json({ ok: true, result });
    } finally {
      ssh?.end();
      jump?.end();
    }
  } catch (error) {
    next(error);
  }
});

const distPath = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ssh')) {
    next();
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    next();
    return;
  }

  res.sendFile(path.join(distPath, 'index.html'));
});

app.use((error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  const status = /auth|login|password|user/i.test(message) ? 401 : 500;
  res.status(status).json({ message });
});

const server = app.listen(port, () => {
  console.log(`OpenNebula portal API listening on http://localhost:${port}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/ssh') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  const record = token ? sshTokens.get(token) : null;
  if (!token || !record || record.expiresAt < Date.now()) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  sshTokens.delete(token);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, record);
  });
});

wss.on('connection', (ws) => {
  let ssh;
  let jump;
  let shell;

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      if (message.type === 'connect') {
        connectSsh(message)
          .then(({ ssh: connectedSsh, jump: connectedJump }) => {
            ssh = connectedSsh;
            jump = connectedJump;

            if (ws.readyState !== 1) {
              ssh?.end();
              jump?.end();
              return;
            }

          ssh.shell({ term: 'xterm-256color', cols: 100, rows: 32 }, (error, stream) => {
            if (error) {
              ws.send(JSON.stringify({ type: 'error', message: error.message }));
              ws.close();
              return;
            }

            shell = stream;
            ws.send(JSON.stringify({ type: 'ready' }));
            stream.on('data', (data) => ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') })));
            stream.on('close', () => ws.close());
          });
          })
          .catch((error) => {
            ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'SSH connection failed' }));
          });
        return;
      }

      if (message.type === 'data' && shell) {
        shell.write(Buffer.from(message.data, 'base64'));
      }

      if (message.type === 'resize' && shell) {
        shell.setWindow(message.rows, message.cols);
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Bad SSH message' }));
    }
  });

  ws.on('close', () => {
    shell?.end();
    ssh?.end();
    jump?.end();
  });
});

function requireAuth(req, res, next) {
  const sid = req.signedCookies?.portal_sid;
  const user = sid ? sessions.get(sid) : null;

  if (!sid || !user) {
    res.status(401).json({ message: 'Not logged in.' });
    return;
  }

  req.sessionId = sid;
  req.user = user;
  next();
}

function getOpenNebula() {
  loadEnv({ override: true, quiet: true });
  return new OpenNebulaClient(process.env.OPENNEBULA_RPC_URL);
}

async function connectSsh(message) {
  const host = String(message.host || '').trim();
  const username = String(message.username || '').trim();
  const portNumber = Number(message.port || 22);
  const privateKey = String(message.privateKey || process.env.SSH_JUMP_PRIVATE_KEY || '').trim() || undefined;

  if (!host || !username) {
    throw new Error('SSH host and username are required.');
  }

  const jumpConfig = getJumpConfig(host);
  if (jumpConfig) {
    return connectSshViaJump({ host, port: portNumber, username, password: message.password, privateKey }, jumpConfig);
  }

  const ssh = await connectSshClient({ host, port: portNumber, username, password: message.password, privateKey });
  return { ssh, jump: null };
}

function getJumpConfig(targetHost) {
  loadEnv({ override: true, quiet: true });

  const host = String(process.env.SSH_JUMP_HOST || '').trim();
  const matchPrefix = String(process.env.SSH_JUMP_MATCH_PREFIX || '').trim();

  if (!host || host === targetHost) {
    return null;
  }

  if (matchPrefix && !targetHost.startsWith(matchPrefix)) {
    return null;
  }

  return {
    host,
    port: Number(process.env.SSH_JUMP_PORT || 22),
    username: String(process.env.SSH_JUMP_USER || '').trim(),
    password: process.env.SSH_JUMP_PASSWORD || undefined,
    privateKey: resolvePrivateKey(process.env.SSH_JUMP_PRIVATE_KEY),
  };
}

async function connectSshViaJump(target, jumpConfig) {
  if (!jumpConfig.username) {
    throw new Error('SSH jump host is configured, but SSH_JUMP_USER is missing in .env.');
  }

  const jump = await connectSshClient(jumpConfig);

  try {
    const stream = await new Promise((resolve, reject) => {
      jump.forwardOut('127.0.0.1', 0, target.host, target.port, (error, forwardedStream) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(forwardedStream);
      });
    });

    const ssh = await connectSshClient({ ...target, sock: stream });
    return { ssh, jump };
  } catch (error) {
    jump.end();
    throw error;
  }
}

function connectSshClient(config) {
  const ssh = new SshClient();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ssh.off('ready', handleReady);
      ssh.off('error', handleError);
    };

    const handleReady = () => {
      cleanup();
      resolve(ssh);
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    ssh.once('ready', handleReady);
    ssh.once('error', handleError);
    ssh.connect({
      host: config.host,
      port: Number(config.port || 22),
      username: config.username,
      password: config.password || undefined,
      privateKey: resolvePrivateKey(config.privateKey),
      sock: config.sock,
      readyTimeout: 20_000,
    });
  });
}

function resolvePrivateKey(value) {
  const privateKey = String(value || '').trim();

  if (!privateKey) {
    return undefined;
  }

  if (
    privateKey.includes('BEGIN OPENSSH PRIVATE KEY') ||
    privateKey.includes('BEGIN RSA PRIVATE KEY') ||
    privateKey.includes('BEGIN PRIVATE KEY')
  ) {
    return privateKey;
  }

  if (fs.existsSync(privateKey)) {
    return fs.readFileSync(privateKey, 'utf8');
  }

  return privateKey;
}
