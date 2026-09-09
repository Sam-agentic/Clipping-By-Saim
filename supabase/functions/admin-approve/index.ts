import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const jwt = request.headers.get('Authorization')?.replace('Bearer ', '');
    const { email, deviceLimit = 2 } = await request.json();
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: caller } = await admin.auth.getUser(jwt || '');
    if (!caller.user) throw new Error('Please sign in again.');
    const { data: owner, error: ownerError } = await admin.from('profiles').select('role').eq('id', caller.user.id).maybeSingle();
    if (ownerError) throw ownerError;
    if (owner?.role !== 'owner') throw new Error('Owner access required.');
    const clean = String(email || '').trim().toLowerCase();
    const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(clean);
    if (error && !/already/i.test(error.message)) throw error;
    let userId = invited?.user?.id;
    if (!userId) {
      const { data: users } = await admin.auth.admin.listUsers();
      userId = users.users.find((user) => user.email?.toLowerCase() === clean)?.id;
    }
    if (!userId) throw new Error('Could not find or create the customer account.');
    await admin.from('profiles').upsert({ id: userId, email: clean, status: 'active', device_limit: Math.max(1, Math.min(10, Number(deviceLimit) || 2)) });
    await admin.from('access_requests').update({ approved_at: new Date().toISOString(), approved_by: caller.user.id }).eq('email', clean);
    return Response.json({ success: true, message: 'Approved. Supabase sent the invitation email in English.' }, { headers: cors });
  } catch (error) { const message = error instanceof Error ? error.message : String(error); return Response.json({ error: message }, { status: 400, headers: cors }); }
});
