import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const jwt = request.headers.get('Authorization')?.replace('Bearer ', '');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: caller } = await admin.auth.getUser(jwt || '');
    if (!caller.user) throw new Error('Please sign in again.');
    const { data: owner, error: ownerError } = await admin.from('profiles').select('role').eq('id', caller.user.id).maybeSingle();
    if (ownerError) throw ownerError;
    if (owner?.role !== 'owner') throw new Error('Owner access required.');
    const { data: customers, error } = await admin
      .from('profiles')
      .select('id, email, role, status, device_limit, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return Response.json({ success: true, customers }, { headers: cors });
  } catch (error) { const message = error instanceof Error ? error.message : String(error); return Response.json({ error: message }, { status: 400, headers: cors }); }
});