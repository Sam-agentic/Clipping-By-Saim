import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const jwt = request.headers.get('Authorization')?.replace('Bearer ', '');
    const deviceId = String((await request.json()).deviceId || '');
    if (!jwt || deviceId.length !== 64) throw new Error('Invalid session.');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) throw new Error('Please sign in again.');
    const user = userData.user;
    const { data: profile } = await admin.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (!profile || profile.status !== 'active') return Response.json({ allowed: false, reason: 'This email is not approved.' }, { headers: cors });
    const { count } = await admin.from('licensed_devices').select('*', { count: 'exact', head: true }).eq('user_id', user.id);
    const { data: exists } = await admin.from('licensed_devices').select('id').eq('user_id', user.id).eq('device_hash', deviceId).maybeSingle();
    if (!exists && (count || 0) >= profile.device_limit) return Response.json({ allowed: false, reason: 'Your device limit has been reached. Contact support.' }, { headers: cors });
    await admin.from('licensed_devices').upsert({ user_id: user.id, device_hash: deviceId, last_seen_at: new Date().toISOString() }, { onConflict: 'user_id,device_hash' });
    return Response.json({ allowed: true, email: profile.email }, { headers: cors });
  } catch (error) { const message = error instanceof Error ? error.message : String(error); return Response.json({ allowed: false, reason: message }, { status: 401, headers: cors }); }
});
