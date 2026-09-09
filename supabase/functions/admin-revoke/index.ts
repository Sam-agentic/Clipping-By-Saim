import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const jwt = request.headers.get('Authorization')?.replace('Bearer ', '');
    const { email, status = 'revoked' } = await request.json();
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: caller } = await admin.auth.getUser(jwt || '');
    if (!caller.user) throw new Error('Please sign in again.');
    const { data: owner, error: ownerError } = await admin.from('profiles').select('role').eq('id', caller.user.id).maybeSingle();
    if (ownerError) throw ownerError;
    if (owner?.role !== 'owner') throw new Error('Owner access required.');
    const clean = String(email || '').trim().toLowerCase();
    if (!clean) throw new Error('An email is required.');
    const allowed = ['active', 'revoked'];
    if (!allowed.includes(status)) throw new Error('Status must be "active" or "revoked".');
    const { data: profile } = await admin.from('profiles').select('id').eq('email', clean).maybeSingle();
    if (!profile) throw new Error('No profile found for that email.');
    const { error } = await admin.from('profiles').update({ status }).eq('id', profile.id);
    if (error) throw error;
    return Response.json({ success: true, email: clean, status }, { headers: cors });
  } catch (error) { const message = error instanceof Error ? error.message : String(error); return Response.json({ error: message }, { status: 400, headers: cors }); }
});