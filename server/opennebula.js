import { XMLParser } from 'fast-xml-parser';

const responseParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
});

const poolParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
});

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function serializeValue(value) {
  if (typeof value === 'boolean') {
    return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  }

  if (Number.isInteger(value)) {
    return `<value><int>${value}</int></value>`;
  }

  if (typeof value === 'number') {
    return `<value><double>${value}</double></value>`;
  }

  return `<value><string>${escapeXml(value ?? '')}</string></value>`;
}

function normalizeArray(value) {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function decodeValue(node) {
  if (node === undefined || node === null) {
    return '';
  }

  if (typeof node !== 'object') {
    return node;
  }

  if ('string' in node) {
    return node.string ?? '';
  }

  if ('int' in node) {
    return Number(node.int);
  }

  if ('i4' in node) {
    return Number(node.i4);
  }

  if ('double' in node) {
    return Number(node.double);
  }

  if ('boolean' in node) {
    return node.boolean === '1' || node.boolean === 1 || node.boolean === true;
  }

  if ('array' in node) {
    return normalizeArray(node.array?.data?.value).map(decodeValue);
  }

  if ('struct' in node) {
    return normalizeArray(node.struct?.member).reduce((acc, member) => {
      acc[member.name] = decodeValue(member.value);
      return acc;
    }, {});
  }

  return node;
}

function parseOpenNebulaResponse(xml) {
  const parsed = responseParser.parse(xml);
  const fault = parsed?.methodResponse?.fault?.value;

  if (fault) {
    const decoded = decodeValue(fault);
    throw new Error(decoded?.faultString || 'OpenNebula XML-RPC fault');
  }

  const params = normalizeArray(parsed?.methodResponse?.params?.param);
  if (!params.length) {
    throw new Error('OpenNebula returned an empty XML-RPC response');
  }

  return decodeValue(params[0].value);
}

export class OpenNebulaClient {
  constructor(endpoint) {
    this.endpoint = endpoint || '';
  }

  async call(method, params) {
    if (!this.endpoint) {
      throw new Error('OPENNEBULA_RPC_URL is not configured. Set it to the Mint VM endpoint, for example http://MINT_VM_IP:2633/RPC2.');
    }

    const body = [
      '<?xml version="1.0"?>',
      '<methodCall>',
      `<methodName>${escapeXml(method)}</methodName>`,
      '<params>',
      ...params.map((param) => `<param>${serializeValue(param)}</param>`),
      '</params>',
      '</methodCall>',
    ].join('');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response;

    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`Could not reach OpenNebula RPC at ${this.endpoint}: ${formatFetchError(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    const xml = await response.text();
    if (!response.ok) {
      throw new Error(`OpenNebula HTTP ${response.status}: ${xml.slice(0, 160)}`);
    }

    const decoded = parseOpenNebulaResponse(xml);
    if (!Array.isArray(decoded)) {
      return decoded;
    }

    const [success, payload, errorCode] = decoded;
    if (!success) {
      throw new Error(payload || `OpenNebula call failed${errorCode ? ` (${errorCode})` : ''}`);
    }

    return payload;
  }

  async verifySession(session) {
    return this.call('one.user.info', [session, -1]);
  }

  async getTemplates(session) {
    const xml = await this.call('one.templatepool.info', [session, -2, -1, -1]);
    return parsePool(xml, 'VMTEMPLATE_POOL', 'VMTEMPLATE').map((template) => ({
      id: Number(template.ID),
      name: String(template.NAME || `Template ${template.ID}`),
      cpu: readTemplateNumber(template.TEMPLATE, 'CPU'),
      vcpu: readTemplateNumber(template.TEMPLATE, 'VCPU'),
      memoryMb: readTemplateNumber(template.TEMPLATE, 'MEMORY'),
      description: readTemplateString(template.TEMPLATE, 'DESCRIPTION'),
    }));
  }

  async getImages(session) {
    const xml = await this.call('one.imagepool.info', [session, -2, -1, -1]);
    return parsePool(xml, 'IMAGE_POOL', 'IMAGE').map((image) => ({
      id: Number(image.ID),
      name: String(image.NAME || `Image ${image.ID}`),
      state: Number(image.STATE ?? -1),
      runningVms: Number(image.RUNNING_VMS ?? 0),
      type: String(image.TYPE ?? ''),
    }));
  }

  async getVms(session) {
    const xml = await this.call('one.vmpool.info', [session, -2, -1, -1, -1]);
    return parsePool(xml, 'VM_POOL', 'VM').map(mapVm);
  }

  async instantiateVm(session, { templateId, name, cpu, vcpu, memoryMb, gpu, environment, autoTask }) {
    const extraTemplate = buildExtraTemplate({ cpu, vcpu, memoryMb, gpu, environment, autoTask });
    const vmId = await this.call('one.template.instantiate', [
      session,
      Number(templateId),
      name || '',
      false,
      extraTemplate,
    ]);
    return Number(vmId);
  }

  async vmAction(session, action, vmId) {
    return this.call('one.vm.action', [session, action, Number(vmId)]);
  }
}

function formatFetchError(error) {
  if (!(error instanceof Error)) {
    return 'unknown network error';
  }

  if (error.name === 'AbortError') {
    return 'connection timed out after 10 seconds';
  }

  const cause = error.cause;
  if (cause && typeof cause === 'object') {
    const code = 'code' in cause ? cause.code : '';
    const address = 'address' in cause ? cause.address : '';
    const port = 'port' in cause ? cause.port : '';
    const syscall = 'syscall' in cause ? cause.syscall : '';
    const details = [code, syscall, address && port ? `${address}:${port}` : address || port].filter(Boolean);

    if (details.length) {
      return details.join(' ');
    }
  }

  return error.message;
}

function parsePool(xml, rootKey, itemKey) {
  if (!xml) {
    return [];
  }

  const parsed = poolParser.parse(xml);
  return normalizeArray(parsed?.[rootKey]?.[itemKey]);
}

function readTemplateNumber(template, key) {
  const value = readTemplateString(template, key);
  return value === '' ? null : Number(value);
}

function readTemplateString(template, key) {
  if (!template || template[key] === undefined || template[key] === null) {
    return '';
  }

  return String(template[key]);
}

function mapVm(vm) {
  const template = vm.TEMPLATE || {};
  const nics = normalizeArray(template.NIC);
  const ips = nics
    .flatMap((nic) => [nic?.IP, nic?.IP6_GLOBAL, nic?.IP6_ULA])
    .filter(Boolean)
    .map(String);

  return {
    id: Number(vm.ID),
    name: String(vm.NAME || `VM ${vm.ID}`),
    uid: Number(vm.UID ?? -1),
    uname: String(vm.UNAME || ''),
    state: Number(vm.STATE ?? -1),
    lcmState: Number(vm.LCM_STATE ?? -1),
    stateLabel: vmStateLabel(Number(vm.STATE ?? -1), Number(vm.LCM_STATE ?? -1)),
    cpu: readTemplateNumber(template, 'CPU'),
    vcpu: readTemplateNumber(template, 'VCPU'),
    memoryMb: readTemplateNumber(template, 'MEMORY'),
    ips,
    templateId: Number(vm.TEMPLATE_ID ?? -1),
  };
}

function vmStateLabel(state, lcmState) {
  if (state === 3 && lcmState === 3) {
    return 'RUNNING';
  }

  const states = {
    0: 'INIT',
    1: 'PENDING',
    2: 'HOLD',
    3: 'ACTIVE',
    4: 'STOPPED',
    5: 'SUSPENDED',
    6: 'DONE',
    8: 'POWEROFF',
    9: 'UNDEPLOYED',
  };

  return states[state] || `STATE ${state}`;
}

function buildExtraTemplate({ cpu, vcpu, memoryMb, gpu, environment, autoTask }) {
  const context = [
    `PORTAL_ENVIRONMENT = "${escapeTemplateValue(environment || 'base-linux')}"`,
    `GPU_SIMULATION = "${gpu ? 'YES' : 'NO'}"`,
  ];

  if (autoTask) {
    context.push(`START_SCRIPT = "${escapeTemplateValue(buildAutoTaskScript(environment, gpu))}"`);
  }

  return [
    `CPU = "${Number(cpu || 1)}"`,
    `VCPU = "${Number(vcpu || cpu || 1)}"`,
    `MEMORY = "${Number(memoryMb || 1024)}"`,
    'CONTEXT = [',
    context.map((line) => `  ${line}`).join(',\n'),
    ']',
  ].join('\n');
}

function buildAutoTaskScript(environment, gpu) {
  const envName = environment || 'base-linux';
  return [
    '#!/bin/sh',
    'set -eu',
    'mkdir -p /home/opennebula',
    'cat > /home/opennebula/portal-task.py <<PY',
    'import json',
    'import math',
    'from pathlib import Path',
    'result = {',
    `    "environment": ${JSON.stringify(envName)},`,
    `    "gpu_simulation": ${gpu ? 'True' : 'False'},`,
    '    "samples": [math.sqrt(i) for i in range(1, 8)],',
    '}',
    'Path("/home/opennebula/portal-result.json").write_text(json.dumps(result, indent=2))',
    'print(json.dumps(result, indent=2))',
    'PY',
    'python3 /home/opennebula/portal-task.py > /home/opennebula/portal-result.txt 2>&1 || true',
  ].join('\n');
}

function escapeTemplateValue(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}
