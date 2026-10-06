'use strict';

const dns = require('node:dns/promises');
const net = require('node:net');
const path = require('node:path');

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Words(address) {
  const ip = String(address).toLowerCase().split('%')[0];
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const words = [];
    for (const part of half.split(':')) {
      if (part.includes('.')) {
        if (part !== half.split(':').at(-1) || net.isIP(part) !== 4) return null;
        const octets = part.split('.').map(Number);
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[\da-f]{1,4}$/i.test(part)) return null;
        words.push(Number.parseInt(part, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves.length === 2 ? halves[1] : '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing < 1 ? null : [...left, ...Array(missing).fill(0), ...right];
}

function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version !== 6) return true;

  const words = ipv6Words(address);
  if (!words) return true;
  // Conservatively reject IPv4-mapped IPv6 so it cannot bypass IPv4 checks.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) return true;
  const [first, second] = words;
  // Only global-unicast space is usable by public web tools. This rejects
  // unspecified, loopback, ULA, link-local, multicast, NAT64 and reserved ranges.
  if ((first & 0xe000) !== 0x2000) return true;
  if ((first === 0x2000 && second <= 0x01ff) ||
      (first === 0x2001 && second <= 0x01ff) ||
      (first === 0x2001 && second === 0x0db8) ||
      first === 0x2002 ||
      (first === 0x3fff && second <= 0x0fff)) return true;
  return false;
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

function resolveWorkspacePath(workspaceRoot, candidate, { allowOutside = false } = {}) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) {
    throw new Error('Нужен непустой путь к файлу.');
  }
  const root = path.resolve(workspaceRoot);
  const normalized = candidate.replace(/[\\/]+/g, path.sep);
  const target = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(root, normalized);
  if (allowOutside) return target;
  const relative = path.relative(root, target);
  if (!relative || relative === '.' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    if (relative === '.' || relative === '') return root;
    throw new Error('Путь выходит за пределы рабочей папки.');
  }
  return target;
}

function normalizePathForContainment(value) {
  let resolved = path.resolve(value);
  if (process.platform === 'win32') {
    const extendedPrefix = `${path.sep}${path.sep}?${path.sep}`;
    const extendedUncPrefix = `${extendedPrefix}UNC${path.sep}`;
    const lower = resolved.toLowerCase();
    if (lower.startsWith(extendedUncPrefix.toLowerCase())) resolved = `${path.sep}${path.sep}${resolved.slice(extendedUncPrefix.length)}`;
    else if (lower.startsWith(extendedPrefix.toLowerCase())) resolved = resolved.slice(extendedPrefix.length);
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

function isPathInside(root, candidate) {
  const resolvedRoot = normalizePathForContainment(root);
  const resolvedCandidate = normalizePathForContainment(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
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
