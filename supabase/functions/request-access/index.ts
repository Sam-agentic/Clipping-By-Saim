import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { email, appVersion } = await request.json();
    const clean = String(email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(clean)) throw new Error('A valid email is required.');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // Upsert resets approved_at so a re-request appears in the pending queue
    // again even if this email was approved before.
    const { error } = await admin.from('access_requests').upsert(
      { email: clean, app_version: String(appVersion || ''), approved_at: null },
      { onConflict: 'email' }
    );
    if (error) throw error;
    return Response.json({ success: true, message: 'Request received.' }, { headers: cors });
  } catch (error) { const message = error instanceof Error ? error.message : String(error); return Response.json({ error: message }, { status: 400, headers: cors }); }
});
