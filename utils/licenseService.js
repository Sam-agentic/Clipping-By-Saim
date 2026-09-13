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

function trialFile(dataDir) { return path.join(dataDir, 'license.trial'); }

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

/** Check if any saved session exists (for stay-logged-in detection). */
function hasSession(dataDir) {
  const session = loadSession(dataDir);
  return Boolean(session && session.access_token);
}

/** Check if the user is currently in trial mode (valid until the server window). */
function getTrialStatus(dataDir) {
  try {
    const raw = fs.readFileSync(trialFile(dataDir), 'utf8');
    const text = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
      : Buffer.from(raw, 'base64').toString('utf8');
    const trial = JSON.parse(text);
    const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
    if (trial && trial.startedAt) {
      const expiresMs = trial.expiresAt
        ? new Date(trial.expiresAt).getTime()
        : new Date(trial.startedAt).getTime() + TRIAL_DURATION_MS;
      if (Date.now() < expiresMs) {
        return {
          active: true,
          startedAt: trial.startedAt,
          expiresAt: new Date(expiresMs).toISOString(),
          email: trial.email || '',
          serverVerified: trial.serverVerified === true
        };
      }
    }
    return { active: false };
  } catch (_) { return { active: false }; }
}

function saveTrialFile(dataDir, trial) {
  const file = trialFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ ...trial, email: String(trial.email || '').trim().toLowerCase() });
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text).toString('base64')
    : Buffer.from(text, 'utf8').toString('base64');
  fs.writeFileSync(file, data, { mode: 0o600 });
}

/**
 * Start a free trial.  When licensing is configured the claim is recorded on
 * the server (one trial per device, forever), so deleting local files or
 * changing the system clock cannot reset the window.  When the server is not
 * reachable (offline) a local-only trial is kept so the app still works, but
 * the watermark + 3-clip limit still apply in-app.
 */
async function startTrial(dataDir, email, appVersion) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  let serverVerified = false;

  if (enabled()) {
    let server;
    try {
      server = await call('/functions/v1/trial-claim', {
        device_hash: deviceId(),
        email: cleanEmail || undefined,
        app_version: appVersion
      });
    } catch (error) {
      saveTrialFile(dataDir, { startedAt: new Date().toISOString(), email: cleanEmail, serverVerified: false });
      resetTrialUsage(dataDir);
      return {
        success: true,
        offline: true,
        serverVerified: false,
        message: 'Offline trial started — your 3-clip limit and watermark still apply.'
      };
    }
    if (server.allowed !== true) {
      return {
        success: false,
        usedBefore: true,
        error: server.reason || 'This device has already used its free trial. Please request access instead.'
      };
    }
    saveTrialFile(dataDir, {
      startedAt: server.started_at,
      expiresAt: server.expires_at,
      email: server.email || cleanEmail,
      serverVerified: true
    });
    serverVerified = true;
  } else {
    // Development build without licensing config — plain local trial.
    saveTrialFile(dataDir, { startedAt: new Date().toISOString(), email: cleanEmail });
  }

  resetTrialUsage(dataDir);
  return { success: true, serverVerified };
}

/** Clear trial status (e.g. when a real license is obtained). */
function clearTrial(dataDir) {
  try { fs.unlinkSync(trialFile(dataDir)); } catch (_) { /* already absent */ }
  resetTrialUsage(dataDir);
}

function trialUsageFile(dataDir) { return path.join(dataDir, 'trial.usage'); }

/** Clips already rendered during this trial (not resetable by the user). */
function trialRenderCount(dataDir) {
  try { return Number(JSON.parse(fs.readFileSync(trialUsageFile(dataDir), 'utf8')).renderedCount) || 0; }
  catch (_) { return 0; }
}

/** Persist one more batch of rendered clips for the trial counter. */
function recordTrialRenders(dataDir, count) {
  try {
    const used = trialRenderCount(dataDir) + (Number(count) || 0);
    fs.writeFileSync(trialUsageFile(dataDir), JSON.stringify({ renderedCount: used }), { mode: 0o600 });
  } catch (_) { /* best-effort */ }
}

function resetTrialUsage(dataDir) {
  try { fs.unlinkSync(trialUsageFile(dataDir)); } catch (_) { /* already absent */ }
}

/**
 * Attempt to refresh an expired Supabase access_token using the stored
 * refresh_token.  Returns the updated session or null on failure.
 */
async function refreshSession(dataDir) {
  const session = loadSession(dataDir);
  if (!session || !session.refresh_token) return null;
  const c = config();
  try {
    const response = await fetch(`${String(c.supabaseUrl).replace(/\/$/, '')}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: c.supabaseAnonKey },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    const refreshed = await response.json().catch(() => ({}));
    if (!response.ok || !refreshed.access_token) return null;
    const merged = { ...session, ...refreshed };
    saveSession(dataDir, merged);
    return merged;
  } catch (_) { return null; }
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
  // Clear trial since the user now has a real license
  clearTrial(dataDir);
  return verify(dataDir);
}

/**
 * Register a new account (first-time sign-up with email + password +
 * confirm password).  Because the owner controls account creation on the
 * server, registration always lands in the owner's approval queue — either the
 * sign-up went through (profile is 'pending' until approval) or sign-ups are
 * closed and the email is submitted as an access request instead.
 */
async function register(dataDir, email, password, confirmPassword, appVersion) {
  if (!enabled()) return { success: false, error: 'Licensing has not been configured for this build.' };
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(password || '');
  const cleanConfirm = String(confirmPassword || '');

  if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return { success: false, error: 'Enter a valid email address.' };
  if (cleanPassword.length < 6) return { success: false, error: 'Password must be at least 6 characters.' };
  if (cleanPassword !== cleanConfirm) return { success: false, error: 'Passwords do not match.' };

  const c = config();
  // Sign up via Supabase Auth — RLS + the trigger creates a 'pending' profile.
  const response = await fetch(`${String(c.supabaseUrl).replace(/\/$/, '')}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: c.supabaseAnonKey },
    body: JSON.stringify({ email: cleanEmail, password: cleanPassword })
  });
  const result = await response.json().catch(() => ({}));

  // Public sign-up is switched off on the server (403 / "signups not allowed").
  // Route the email into the access-request queue so the owner can invite it.
  if (!response.ok && (response.status === 403 || /signup|invite|closed|disabled/i.test(String(result.error_description || result.msg || result.error || '')))) {
    try { await requestAccess(cleanEmail, appVersion); } catch (_) { /* best-effort */ }
    return {
      success: false,
      requested: true,
      error: 'Account creation is closed on the server, so we sent the owner an access request for this email. You will get an invite link once they approve you — the password you typed is not needed; you will set one from the invite.'
    };
  }

  if (result.access_token) {
    saveSession(dataDir, result);
    clearTrial(dataDir);
    // Keep the owner approval queue in sync so pending users show up.
    try { await requestAccess(cleanEmail, appVersion); } catch (_) { /* best-effort */ }
    return verify(dataDir);
  }
  if (response.ok && result.id) {
    try { await requestAccess(cleanEmail, appVersion); } catch (_) { /* best-effort */ }
    return { success: true, needsConfirmation: true, message: 'Account created. Please confirm your email, then sign in once the owner approves your account.' };
  }
  if (result.msg && /already/i.test(String(result.msg))) {
    // The account exists but is almost certainly still 'pending' approval.
    try { await requestAccess(cleanEmail, appVersion); } catch (_) { /* best-effort */ }
    return { success: false, error: 'This email is already registered and waiting for approval. We nudged the owner again — try signing in once it is approved.' };
  }
  return { success: false, error: result.error_description || result.msg || result.error || 'Registration failed. Make sure you have been invited by the owner.' };
}

async function verify(dataDir) {
  if (!enabled()) return { required: false, allowed: true, mode: 'development' };
  const session = loadSession(dataDir);

  // No session at all → show login gate
  if (!session || !session.access_token) {
    const trial = getTrialStatus(dataDir);
    if (trial.active) {
      return { required: true, allowed: true, trial: true, email: trial.email, reason: '' };
    }
    return { required: true, allowed: false, reason: 'Sign in with an approved email to continue.' };
  }

  try {
    const result = await call('/functions/v1/verify-license', { deviceId: deviceId() }, session.access_token);
    if (result.allowed === true) {
      clearTrial(dataDir);
      return { required: true, allowed: true, email: result.email || '', reason: '' };
    }
    return { required: true, allowed: false, email: result.email || '', reason: result.reason || '' };
  } catch (error) {
    // Token might have expired — try to refresh it transparently
    const refreshed = await refreshSession(dataDir);
    if (refreshed && refreshed.access_token) {
      try {
        const retry = await call('/functions/v1/verify-license', { deviceId: deviceId() }, refreshed.access_token);
        if (retry.allowed === true) {
          clearTrial(dataDir);
          return { required: true, allowed: true, email: retry.email || '', reason: '' };
        }
        return { required: true, allowed: false, email: retry.email || '', reason: retry.reason || '' };
      } catch (retryError) {
        return { required: true, allowed: false, reason: retryError.message || 'Could not verify your license.' };
      }
    }
    // Refresh failed — check trial as fallback
    const trial = getTrialStatus(dataDir);
    if (trial.active) {
      return { required: true, allowed: true, trial: true, email: trial.email, reason: '' };
    }
    return { required: true, allowed: false, reason: error.message || 'Could not verify your license. Please sign in again.' };
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

module.exports = { requestAccess, signIn, register, verify, approveCustomer, listRequests, revokeCustomer, listCustomers, clearSession, hasSession, getTrialStatus, startTrial, clearTrial, trialRenderCount, recordTrialRenders, enabled };
