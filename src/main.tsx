import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Activity, Gauge, HardDrive, KeyRound, Laptop, LogOut, Play, Power, RefreshCw, Rocket, SquareTerminal, Zap } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend } from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

type Template = {
  id: number;
  name: string;
  cpu: number | null;
  vcpu: number | null;
  memoryMb: number | null;
  description: string;
};

type Image = {
  id: number;
  name: string;
  state: number;
  runningVms: number;
  type: string;
};

type Vm = {
  id: number;
  name: string;
  stateLabel: string;
  cpu: number | null;
  vcpu: number | null;
  memoryMb: number | null;
  ips: string[];
};

type User = {
  username: string;
};

type Notice = {
  type: 'info' | 'error';
  text: string;
};

const environments = [
  { value: 'base-linux', label: 'Base Linux' },
  { value: 'python-data', label: 'Python Data Lab' },
  { value: 'web-tools', label: 'Web Tools' },
  { value: 'security-lab', label: 'Security Lab' },
];

const api = {
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.message || `Request failed: ${response.status}`);
    }

    return payload as T;
  },
  get<T>(path: string) {
    return api.request<T>(path);
  },
  post<T>(path: string, body?: unknown) {
    return api.request<T>(path, { method: 'POST', body: JSON.stringify(body || {}) });
  },
};

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api.get<User>('/api/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return <Splash />;
  }

  return user ? <Dashboard user={user} onLogout={() => setUser(null)} /> : <Login onLogin={setUser} />;
}

function Splash() {
  return (
    <main className="center-page">
      <div className="brand-lockup">
        <div className="brand-mark">
          <Activity size={26} />
        </div>
        <div>
          <p>OpenNebula</p>
          <h1>Research Portal</h1>
        </div>
      </div>
    </main>
  );
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setNotice(null);

    try {
      const loggedIn = await api.post<User>('/api/auth/login', { username, password });
      onLogin(loggedIn);
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Login failed' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Activity size={26} />
          </div>
          <div>
            <p>OpenNebula</p>
            <h1>Research Portal</h1>
          </div>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
          </label>
          {notice && <NoticeLine notice={notice} />}
          <button className="primary-button" disabled={loading}>
            <KeyRound size={18} />
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </section>
      <section className="login-visual">
        <div className="metric-strip">
          <span>VM Portal</span>
          <strong>CPU / RAM / WebSSH</strong>
        </div>
      </section>
    </main>
  );
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [images, setImages] = useState<Image[]>([]);
  const [vms, setVms] = useState<Vm[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [terminalVm, setTerminalVm] = useState<Vm | null>(null);

  async function refresh() {
    setLoading(true);
    setNotice(null);
    try {
      const [nextTemplates, nextImages, nextVms] = await Promise.all([
        api.get<Template[]>('/api/templates'),
        api.get<Image[]>('/api/images'),
        api.get<Vm[]>('/api/vms'),
      ]);
      setTemplates(nextTemplates);
      setImages(nextImages);
      setVms(nextVms);
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not load OpenNebula data' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function logout() {
    await api.post('/api/auth/logout').catch(() => null);
    onLogout();
  }

  async function createVm(payload: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      await api.post('/api/vms', payload);
      setNotice({ type: 'info', text: 'VM launch request sent to OpenNebula.' });
      await refresh();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not launch VM' });
    } finally {
      setBusy(false);
    }
  }

  async function vmAction(vm: Vm, action: string) {
    setBusy(true);
    setNotice(null);
    try {
      await api.post(`/api/vms/${vm.id}/action`, { action });
      setNotice({ type: 'info', text: `${action} sent for ${vm.name}.` });
      await refresh();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'VM action failed' });
    } finally {
      setBusy(false);
    }
  }

  const runningCount = vms.filter((vm) => vm.stateLabel === 'RUNNING').length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup compact">
          <div className="brand-mark">
            <Activity size={22} />
          </div>
          <div>
            <p>OpenNebula</p>
            <h1>Research Portal</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="user-pill">{user.username}</span>
          <button className="icon-button" onClick={refresh} disabled={loading} title="Refresh">
            <RefreshCw size={18} />
          </button>
          <button className="icon-button" onClick={logout} title="Sign out">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="summary-grid">
        <SummaryTile icon={<Laptop size={20} />} label="VMs" value={vms.length} />
        <SummaryTile icon={<Power size={20} />} label="Running" value={runningCount} />
        <SummaryTile icon={<Rocket size={20} />} label="Templates" value={templates.length} />
        <SummaryTile icon={<HardDrive size={20} />} label="Images" value={images.length} />
      </section>

      {notice && <NoticeLine notice={notice} />}

      <section className="workspace-grid">
        <LaunchPanel templates={templates} busy={busy || loading} onCreate={createVm} />
        <ResourcePanel images={images} />
      </section>

      <VmPanel vms={vms} busy={busy || loading} onAction={vmAction} onOpenTerminal={setTerminalVm} />

      {terminalVm && <TerminalModal vm={terminalVm} onClose={() => setTerminalVm(null)} />}
    </main>
  );
}

function SummaryTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <article className="summary-tile">
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function LaunchPanel({ templates, busy, onCreate }: { templates: Template[]; busy: boolean; onCreate: (payload: Record<string, unknown>) => void }) {
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [cpu, setCpu] = useState(1);
  const [memoryMb, setMemoryMb] = useState(1024);
  const [gpu, setGpu] = useState(false);
  const [environment, setEnvironment] = useState(environments[1].value);
  const [autoTask, setAutoTask] = useState(true);

  useEffect(() => {
    if (!templateId && templates[0]) {
      setTemplateId(String(templates[0].id));
    }
  }, [templateId, templates]);

  const selectedTemplate = templates.find((template) => String(template.id) === templateId);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onCreate({
      templateId: Number(templateId),
      name: name || `${selectedTemplate?.name || 'research-vm'}-${Date.now().toString().slice(-4)}`,
      cpu,
      vcpu: cpu,
      memoryMb,
      gpu,
      environment,
      autoTask,
    });
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p>Launch</p>
          <h2>New VM</h2>
        </div>
        <Rocket size={22} />
      </div>

      <form className="launch-form" onSubmit={submit}>
        <label>
          Template
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)} required>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          VM name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="research-vm" />
        </label>

        <div className="slider-row">
          <label>
            <span>
              CPU
              <strong>{cpu}</strong>
            </span>
            <input type="range" min="1" max="8" value={cpu} onChange={(event) => setCpu(Number(event.target.value))} />
          </label>
          <label>
            <span>
              RAM
              <strong>{memoryMb} MB</strong>
            </span>
            <input type="range" min="512" max="8192" step="512" value={memoryMb} onChange={(event) => setMemoryMb(Number(event.target.value))} />
          </label>
        </div>

        <label>
          Environment
          <select value={environment} onChange={(event) => setEnvironment(event.target.value)}>
            {environments.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <div className="toggle-grid">
          <label className="toggle-line">
            <input type="checkbox" checked={gpu} onChange={(event) => setGpu(event.target.checked)} />
            <span>
              <Zap size={16} />
              GPU simulation
            </span>
          </label>
          <label className="toggle-line">
            <input type="checkbox" checked={autoTask} onChange={(event) => setAutoTask(event.target.checked)} />
            <span>
              <Play size={16} />
              Auto task
            </span>
          </label>
        </div>

        <button className="primary-button" disabled={busy || !templateId}>
          <Rocket size={18} />
          Launch VM
        </button>
      </form>
    </section>
  );
}

function ResourcePanel({ images }: { images: Image[] }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p>Resources</p>
          <h2>Images</h2>
        </div>
        <HardDrive size={22} />
      </div>
      <div className="image-list">
        {images.length ? (
          images.map((image) => (
            <article className="image-row" key={image.id}>
              <div>
                <strong>{image.name}</strong>
                <span>ID {image.id}</span>
              </div>
              <span>{image.runningVms} VM</span>
            </article>
          ))
        ) : (
          <p className="empty-text">No images visible for this OpenNebula user.</p>
        )}
      </div>
    </section>
  );
}

function VmPanel({ vms, busy, onAction, onOpenTerminal }: { vms: Vm[]; busy: boolean; onAction: (vm: Vm, action: string) => void; onOpenTerminal: (vm: Vm) => void }) {
  return (
    <section className="panel vm-panel">
      <div className="panel-heading">
        <div>
          <p>Control</p>
          <h2>Virtual Machines</h2>
        </div>
        <Gauge size={22} />
      </div>
      <div className="vm-table">
        <div className="vm-table-head">
          <span>Name</span>
          <span>State</span>
          <span>Size</span>
          <span>IP</span>
          <span>Actions</span>
        </div>
        {vms.length ? (
          vms.map((vm) => (
            <article className="vm-row" key={vm.id}>
              <div>
                <strong>{vm.name}</strong>
                <span>ID {vm.id}</span>
              </div>
              <span className={`state-badge ${vm.stateLabel.toLowerCase()}`}>{vm.stateLabel}</span>
              <span>
                {vm.vcpu || vm.cpu || 1} CPU / {vm.memoryMb || 0} MB
              </span>
              <span>{vm.ips[0] || 'Waiting'}</span>
              <div className="row-actions">
                <button className="icon-button" onClick={() => onOpenTerminal(vm)} disabled={busy || !vm.ips.length} title="WebSSH">
                  <SquareTerminal size={17} />
                </button>
                <button className="icon-button" onClick={() => onAction(vm, 'reboot')} disabled={busy} title="Reboot">
                  <RefreshCw size={17} />
                </button>
                <button className="icon-button" onClick={() => onAction(vm, vm.stateLabel === 'POWEROFF' ? 'resume' : 'poweroff')} disabled={busy} title="Power">
                  <Power size={17} />
                </button>
              </div>
            </article>
          ))
        ) : (
          <p className="empty-text">No VMs visible for this OpenNebula user.</p>
        )}
      </div>
    </section>
  );
}

function TerminalModal({ vm, onClose }: { vm: Vm; onClose: () => void }) {
  const [host, setHost] = useState(vm.ips[0] || '');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [loadingResult, setLoadingResult] = useState(false);

  const canConnect = host.trim() && username.trim() && (password || privateKey);
  const handleTerminalError = useCallback((message: string) => {
    setError(message);
    setConnected(false);
  }, []);

  return (
    <div className="modal-backdrop">
      <section className="terminal-modal">
        <header>
          <div>
            <p>WebSSH</p>
            <h2>{vm.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close">
            x
          </button>
        </header>

        {!connected && (
          <form className="ssh-form" onSubmit={(event) => event.preventDefault()}>
            <label>
              Host
              <input value={host} onChange={(event) => setHost(event.target.value)} />
            </label>
            <label>
              Port
              <input value={port} onChange={(event) => setPort(Number(event.target.value))} type="number" min="1" max="65535" />
            </label>
            <label>
              SSH user
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </label>
            <label>
              Password
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
            </label>
            <label className="wide-field">
              Private key
              <textarea value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} rows={5} />
            </label>
            {error && <NoticeLine notice={{ type: 'error', text: error }} />}
            <button className="primary-button" disabled={!canConnect} onClick={() => setConnected(true)}>
              <SquareTerminal size={18} />
              Open terminal
            </button>
            <button className="secondary-button" disabled={!canConnect || loadingResult} onClick={async () => {
              setLoadingResult(true);
              setError('');
              try {
                const resp = await api.post<{ ok: boolean, result?: any }>(`/api/vms/${vm.id}/result`, { username, password, privateKey });
                if (resp.ok) {
                  setResult(resp.result || null);
                } else {
                  setError('No result available');
                }
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to fetch result');
              } finally {
                setLoadingResult(false);
              }
            }}>
              View Auto-Task Result
            </button>
          </form>
        )}

        {connected && (
          <WebTerminal
            host={host}
            port={port}
            username={username}
            password={password}
            privateKey={privateKey}
            onError={handleTerminalError}
          />
        )}

        {result && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p>Auto Task</p>
                <h2>Result</h2>
              </div>
            </div>
            <div className="panel-body">
              <p>Environment: {String(result.environment)}</p>
              <p>GPU simulation: {String(result.gpu_simulation)}</p>
              <div style={{ width: '100%', height: 240 }}>
                <Line
                  data={{
                    labels: (result.samples || []).map((_: any, i: number) => `#${i+1}`),
                    datasets: [{ label: 'Samples', data: result.samples || [], borderColor: '#47d7ac', backgroundColor: 'rgba(71,215,172,0.1)' }]
                  }}
                  options={{ responsive: true, plugins: { legend: { display: true } } }}
                />
              </div>
            </div>
          </section>
        )}
      </section>
    </div>
  );
}

function WebTerminal({ host, port, username, password, privateKey, onError }: { host: string; port: number; username: string; password: string; privateKey: string; onError: (message: string) => void }) {
  const terminalId = useMemo(() => `terminal-${createClientId()}`, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: {
        background: '#101820',
        foreground: '#f5f7fa',
        cursor: '#47d7ac',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const node = document.getElementById(terminalId);

    async function connect() {
      if (!node) {
        return;
      }

      terminal.open(node);
      fitAddon.fit();
      terminal.writeln('Connecting...');

      try {
        const { token } = await api.post<{ token: string }>('/api/ssh-token');
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}/ssh?token=${token}`);

        ws.addEventListener('open', () => {
          ws?.send(JSON.stringify({ type: 'connect', host, port, username, password, privateKey }));
        });

        ws.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'ready') {
              terminal.clear();
              return;
            }

            if (message.type === 'data') {
              terminal.write(Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0)));
              return;
            }

            if (message.type === 'error') {
              onError(message.message || 'SSH connection failed');
            }
          } catch {
            onError('Received an invalid WebSSH message from the server.');
          }
        });

        ws.addEventListener('error', () => {
          onError('WebSSH socket failed. Restart the portal server and try again.');
        });

        terminal.onData((data) => {
          ws?.send(JSON.stringify({ type: 'data', data: btoa(data) }));
        });

        resizeObserver = new ResizeObserver(() => {
          fitAddon.fit();
          ws?.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        });
        resizeObserver.observe(node);
      } catch (error) {
        onError(error instanceof Error ? error.message : 'SSH connection failed');
      }
    }

    connect();

    return () => {
      resizeObserver?.disconnect();
      ws?.close();
      terminal.dispose();
    };
  }, [host, onError, password, port, privateKey, terminalId, username]);

  return <div id={terminalId} className="terminal-surface" />;
}

function createClientId() {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function NoticeLine({ notice }: { notice: Notice }) {
  return <div className={`notice ${notice.type}`}>{notice.text}</div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
