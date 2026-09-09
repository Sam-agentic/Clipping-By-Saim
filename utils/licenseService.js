/**
 * Server-verified access for the desktop application.
 *
 * The Supabase anonymous key is intentionally not a secret; Row Level Security
 * and the Edge Functions are the security boundary.  The service-role key must
 * only ever live in an Edge Function, never in this Electron bundle.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeStorage } = require('electron');

const CONFIG_FILE = path.join(__dirname, '..', 'licensing.config.json');

function config() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return {}; }
}

function enabled() {
  const c = config();
  return c.enforcement === 'required' && /^https:\/\//.test(String(c.supabaseUrl || ''))
    && String(c.supabaseAnonKey || '').length > 20;
}

function tokenFile(dataDir) { return path.join(dataDir, 'license.session'); }

function deviceId() {
  // A hash, rather than a raw hardware identifier: the licensing server needs
  // a stable device key but does not need to receive a customer's machine name.
  const raw = [os.hostname(), os.platform(), os.arch(), os.userInfo().username].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function saveSession(dataDir, session) {
  const file = tokenFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(session);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text).toString('base64')
    : Buffer.from(text, 'utf8').toString('base64');
  fs.writeFileSync(file, data, { mode: 0o600 });
}

function loadSession(dataDir) {
  try {
    const raw = fs.readFileSync(tokenFile(dataDir), 'utf8');
    const text = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
      : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text);
  } catch (_) { return null; }
}

function clearSession(dataDir) {
  try { fs.unlinkSync(tokenFile(dataDir)); } catch (_) { /* already absent */ }
}

async function call(pathname, body, token) {
  const c = config();
  const response = await fetch(`${String(c.supabaseUrl).replace(/\/$/, '')}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: c.supabaseAnonKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || 'Licensing server rejected the request.');
  return data;
}

async function requestAccess(email, appVersion) {
  if (!enabled()) return { success: false, error: 'Licensing has not been configured for this build.' };
  if (!/^\S+@\S+\.\S+$/.test(String(email || '').trim())) return { success: false, error: 'Enter a valid email address.' };
  await call('/functions/v1/request-access', { email: email.trim().toLowerCase(), appVersion });
  return { success: true };
}

async function signIn(dataDir, email, password) {
  if (!enabled()) return { success: false, error: 'Licensing has not been configured for this build.' };
  const c = config();
  const response = await fetch(`${String(c.supabaseUrl).replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: c.supabaseAnonKey },
    body: JSON.stringify({ email: String(email || '').trim().toLowerCase(), password: String(password || '') })
  });
  const session = await response.json().catch(() => ({}));
  if (!response.ok || !session.access_token) return { success: false, error: session.error_description || session.msg || 'Sign-in failed.' };
  saveSession(dataDir, session);
  return verify(dataDir);
}

async function verify(dataDir) {
  if (!enabled()) return { required: false, allowed: true, mode: 'development' };
  const session = loadSession(dataDir);
  if (!session || !session.access_token) return { required: true, allowed: false, reason: 'Sign in with an approved email to continue.' };
  try {
    const result = await call('/functions/v1/verify-license', { deviceId: deviceId() }, session.access_token);
    return { required: true, allowed: result.allowed === true, email: result.email || '', reason: result.reason || '' };
  } catch (error) {
    return { required: true, allowed: false, reason: error.message || 'Could not verify your license.' };
  }
}

async function approveCustomer(dataDir, email, deviceLimit) {
  if (!enabled()) return { success: false, error: 'Licensing has not been configured for this build.' };
  const session = loadSession(dataDir);
  if (!session || !session.access_token) return { success: false, error: 'Sign in as the owner first.' };
  try {
    return await call('/functions/v1/admin-approve', {
      email: String(email || '').trim().toLowerCase(),
      deviceLimit: Math.max(1, Math.min(10, Number(deviceLimit) || 2))
    }, session.access_token);
  } catch (error) { return { success: false, error: error.message || 'Approval failed.' }; }
}

async function listRequests(dataDir) {
  if (!enabled()) return { success: false, error: 'Licensing has not been configured for this build.' };
  const session = loadSession(dataDir);
  if (!session || !session.access_token) return { success: false, error: 'Sign in as the owner first.' };
  try {
    return await call('/functions/v1/admin-list-requests', {}, session.access_token);
  } catch (error) { return { success: false, error: error.message || 'Could not load requests.' }; }
}

async function revokeCustomer(dataDir, email, status) {
  if (!enabled()) return { success: false, error: 'Licensing has not been configured for this build.' };
  const session = loadSession(dataDir);
  if (!session || !session.access_token) return { success: false, error: 'Sign in as the owner first.' };
  try {
    return await call('/functions/v1/admin-revoke', {
      email: String(email || '').trim().toLowerCase(),
      status: status === 'active' ? 'active' : 'revoked'
    }, session.access_token);
  } catch (error) { return { success: false, error: error.message || 'Update failed.' }; }
}

async function listCustomers(dataDir) {
  if (!enabled()) return { success: false, error: 'Licensing has not been configured for this build.' };
  const session = loadSession(dataDir);
  if (!session || !session.access_token) return { success: false, error: 'Sign in as the owner first.' };
  try {
    return await call('/functions/v1/admin-list-customers', {}, session.access_token);
  } catch (error) { return { success: false, error: error.message || 'Could not load customers.' }; }
}

module.exports = { requestAccess, signIn, verify, approveCustomer, listRequests, revokeCustomer, listCustomers, clearSession, enabled };
