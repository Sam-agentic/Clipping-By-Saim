import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
const TRIAL_DAYS = 7;

/**
 * POST /functions/v1/trial-claim
 * { device_hash, email?, app_version? }
 *
 * One trial per device, enforced server-side: a fresh claim stores the expiry,
 * a re-claim inside the window is idempotent (offline retries keep the same
 * window), and a claim after the window is denied — local deletion or clock
 * changes cannot reset it.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    let body = {};
    try { body = await request.json(); } catch (_) { /* empty body */ }
    const deviceHash = String(body.device_hash || '').trim();
    const email = String(body.email || '').trim().toLowerCase() || null;
    const appVersion = String(body.app_version || '').trim() || null;

    if (!deviceHash || deviceHash.length < 8 || deviceHash.length > 128) {
      throw new Error('Missing a valid device identifier.');
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: existing, error: readError } = await admin
      .from('free_trials')
      .select('claimed_at, expires_at, email, app_version')
      .eq('device_hash', deviceHash)
      .maybeSingle();
    if (readError) throw readError;

    const nowMs = Date.now();
    if (existing) {
      const expiresAt = new Date(existing.expires_at).getTime();
      if (expiresAt > nowMs) {
        // Window still open — return the same expiry so a re-claim restores it.
        return Response.json({
          success: true, allowed: true, already: true,
          started_at: existing.claimed_at,
          expires_at: existing.expires_at,
          email: existing.email,
        }, { headers: cors });
      }
      return Response.json({
        success: true, allowed: false, already: true,
        claimed_at: existing.claimed_at,
        expires_at: existing.expires_at,
        reason: 'The free trial for this device has already been used.',
      }, { headers: cors });
    }

    // Fresh claim — store the expiry server-side.
    const expiresAt = new Date(nowMs + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: inserted, error: insertError } = await admin
      .from('free_trials')
      .insert({ device_hash: deviceHash, email, app_version: appVersion, expires_at: expiresAt })
      .select('claimed_at, expires_at, email')
      .single();
    if (insertError) throw insertError;

    return Response.json({
      success: true, allowed: true, already: false,
      started_at: inserted.claimed_at,
      expires_at: inserted.expires_at,
      email: inserted.email,
    }, { headers: cors });
  } catch (error) {
    // Errors can arrive as plain objects; flatten them to a usable message.
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message?: unknown }).message ?? '')
          : JSON.stringify(error);
    const text = message || JSON.stringify(error);
    return Response.json({ error: text }, { status: 400, headers: cors });
  }
});