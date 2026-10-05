'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const path = require('node:path');

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version !== 6) return true;

  const ip = address.toLowerCase().split('%')[0];
  // Conservatively reject IPv4-mapped IPv6 so it cannot bypass the IPv4 checks.
  if (ip.startsWith('::ffff:')) return true;
  return ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') ||
    /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.startsWith('2001:db8:');
}

function hostnameOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

async function assertPublicHttpUrl(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  } catch {
    throw new Error('Некорректный URL. Нужен полный адрес http:// или https://.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Разрешены только URL с протоколом http или https.');
  }
  if (url.username || url.password) throw new Error('URL с логином или паролем запрещены.');

  const hostname = hostnameOf(url);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Доступ к локальным адресам из веб-инструмента запрещён.');
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion) {
    if (isPrivateIp(hostname)) throw new Error('Доступ к частным и локальным IP-адресам запрещён.');
    return url;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Не удалось найти публичный адрес сайта: ${hostname}`);
  }
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('Сайт разрешается в частный или локальный IP-адрес; запрос заблокирован.');
  }
  return url;
}

function isLoopbackHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

function normalizeLocalServiceUrl(value, fallback) {
  let url;
  try {
    url = new URL(String(value || fallback));
  } catch {
    throw new Error('Укажите корректный URL локального сервиса.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname) || url.username || url.password) {
    throw new Error('Генератор изображений должен быть локальным: localhost, 127.0.0.1 или ::1.');
  }
  return url.origin;
}

function resolveWorkspacePath(workspaceRoot, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) {
    throw new Error('Нужен непустой относительный путь внутри рабочей папки.');
  }
  const root = path.resolve(workspaceRoot);
  const normalized = candidate.replace(/[\\/]+/g, path.sep);
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  if (!relative || relative === '.' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    if (relative === '.' || relative === '') return root;
    throw new Error('Путь выходит за пределы рабочей папки.');
  }
  return target;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

module.exports = {
  assertPublicHttpUrl,
  isLoopbackHost,
  isPathInside,
  isPrivateIp,
  normalizeLocalServiceUrl,
  resolveWorkspacePath,
};
