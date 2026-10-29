// Password sign-in with per-device session keys. Anyone signed in can make agents run code on this
// machine, so the password can only be first set from the machine itself and keys are stored hashed.
import crypto from 'node:crypto';
import type http from 'node:http';
import type { Store, Device } from './store.ts';

const SESSION_IDLE_MS = 30 * 24 * 3600 * 1000;
const COOKIE = 'shed_session';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded'];
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

// A request through a tunnel or reverse proxy arrives from loopback too; proxy headers reveal it.
export function isLocalRequest(req: http.IncomingMessage): boolean {
  return LOOPBACK.has(req.socket.remoteAddress || '') && !PROXY_HEADERS.some(name => req.headers[name]);
}

export function clientIp(req: http.IncomingMessage): string {
  const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function cookies(req: http.IncomingMessage): Record<string, string> {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=')).filter(([k, v]) => k && v).map(([k, v]) => [k, decodeURIComponent(v)]));
}

export class Auth {
  store: Store;
  failures = new Map<string, number[]>();

  constructor(store: Store, initialPassword = '') {
    this.store = store;
    if (initialPassword && !this.configured) {
      if (initialPassword.length < 8) throw new Error('SHED_PASSWORD must be at least 8 characters.');
      store.settings.passwordHash = hashPassword(initialPassword);
      store.saveSettings();
    }
  }

  get configured() { return String(this.store.settings.passwordHash || '').startsWith('scrypt$'); }
  get devices(): Device[] { return (this.store.settings.devices ||= []); }

  setup(req: http.IncomingMessage, password: string) {
    if (this.configured) throw Object.assign(new Error('A password is already set.'), { status: 409 });
    if (!isLocalRequest(req)) throw Object.assign(new Error('Set the first password from this machine (http://localhost).'), { status: 403 });
    if (typeof password !== 'string' || password.length < 8) throw Object.assign(new Error('Use at least 8 characters.'), { status: 400 });
    this.store.settings.passwordHash = hashPassword(password);
    this.store.saveSettings();
    return this.createDevice(req);
  }

  login(req: http.IncomingMessage, password: unknown) {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (this.failures.get(ip) || []).filter(at => now - at < 15 * 60 * 1000);
    if (recent.length >= 10) throw Object.assign(new Error('Too many attempts. Try again in 15 minutes.'), { status: 429 });
    if (typeof password !== 'string' || !verifyPassword(password, this.store.settings.passwordHash)) {
      this.failures.set(ip, [...recent, now]);
      throw Object.assign(new Error('Wrong password.'), { status: 401 });
    }
    this.failures.delete(ip);
    return this.createDevice(req);
  }

  createDevice(req: http.IncomingMessage): { cookie: string } {
    const key = crypto.randomBytes(32).toString('base64url');
    const at = new Date().toISOString();
    const agent = String(req.headers['user-agent'] || '');
    const name = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : 'Browser';
    this.devices.push({ id: crypto.randomUUID(), keyHash: sha256(key), name, createdAt: at, lastSeenAt: at });
    this.store.saveSettings();
    return { cookie: this.cookie(req, key, SESSION_IDLE_MS / 1000) };
  }

  cookie(req: http.IncomingMessage, value: string, maxAge: number): string {
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  device(req: http.IncomingMessage): Device | null {
    const key = cookies(req)[COOKIE];
    if (!key) return null;
    const hash = sha256(key);
    const device = this.devices.find(d => d.keyHash === hash);
    if (!device || Date.now() - Date.parse(device.lastSeenAt) > SESSION_IDLE_MS) return null;
    if (Date.now() - Date.parse(device.lastSeenAt) > 3600 * 1000) { device.lastSeenAt = new Date().toISOString(); this.store.saveSettings(); }
    return device;
  }

  logout(req: http.IncomingMessage): string {
    const device = this.device(req);
    if (device) { this.store.settings.devices = this.devices.filter(d => d.id !== device.id); this.store.saveSettings(); }
    return this.cookie(req, '', 0);
  }
}
