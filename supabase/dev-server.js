// Локальный тестовый сервер: раздаёт public/ и имитирует Supabase RPC через psql.
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function rpc(fn, body) {
  return new Promise((resolve) => {
    const p = spawn('psql', ['-h', '/tmp', '-p', '5544', '-U', 'postgres', '-d', 'cz', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'p=' + body]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out: out.trim(), err }));
    p.stdin.end(`set role anon; select public.${fn}(:'p'::jsonb);`);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
  if (m && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      let p = '{}'; try { p = JSON.stringify(JSON.parse(body || '{}').p || {}); } catch (e) {}
      const r = await rpc(m[1], p);
      if (r.code === 0) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(r.out || 'null'); }
      else { const msg = (r.err.match(/ERROR:\s+(.*)/) || [, r.err])[1].trim(); res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'P0001', message: msg })); }
    });
    return;
  }
  // те же правила, что в vercel.json
  let f = url.pathname;
  if (f === '/') f = '/index.html';
  else if (/^\/admin(\/.*)?$/.test(f) && !path.extname(f)) f = '/admin/index.html';
  else if (!path.extname(f)) f = f + '.html';
  const file = path.join(ROOT, path.normalize(f));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(8080, () => console.log('http://localhost:8080'));
