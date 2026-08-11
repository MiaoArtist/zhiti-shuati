// 刷题云同步：Cloudflare Workers + KV
// GET  /api/sync   -> { data: <JSON 或 null> }
// PUT  /api/sync   -> 保存数据（body 为完整数据 JSON），需 X-Auth-Token
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname !== '/api/sync') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    const token = request.headers.get('X-Auth-Token') || '';
    if (!env.SYNC_TOKEN || token !== env.SYNC_TOKEN) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (request.method === 'GET') {
      const stored = await env.SYNC_KV.get('data', 'json');
      return new Response(JSON.stringify({ data: stored || null }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      await env.SYNC_KV.put('data', JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
