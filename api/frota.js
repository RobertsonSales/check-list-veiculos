// Proxy serverless (Vercel) entre o Controle de Frota e o Google Apps Script.
// O token do Apps Script fica só no servidor — o navegador nunca o recebe.
//
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   APPS_SCRIPT_URL    (obrigatória) URL do Web App, terminada em /exec
//   APPS_SCRIPT_TOKEN  (obrigatória) mesmo valor da propriedade API_TOKEN do Apps Script
//   FROTA_ACCESS_KEY   (opcional)    se definida, o app exige essa chave de acesso (cabeçalho X-Frota-Key)
//   ALLOWED_ORIGIN     (opcional)    origem extra liberada por CORS (ex.: http://localhost:5500)

const GET_ACTIONS = new Set(['health', 'bootstrap', 'diagnostico']);
const POST_ACTIONS = new Set(['create', 'update', 'delete']);

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = process.env.ALLOWED_ORIGIN;
  if (origin && (origin === allowed || origin === 'null')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Frota-Key');
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function callAppsScript(url, init) {
  const r = await fetch(url, { ...init, redirect: 'follow' });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    const login = /accounts\.google\.com|ServiceLogin|<title>.*(Sign in|Fazer login)/i.test(text);
    return {
      ok: false,
      code: 'UPSTREAM',
      error: login
        ? 'O Apps Script pediu login. Reimplante o Web App com "Executar como: Eu" e "Quem pode acessar: Qualquer pessoa".'
        : 'O Apps Script não respondeu em JSON (HTTP ' + r.status + '). Confira APPS_SCRIPT_URL (deve terminar em /exec) e se a implantação está ativa.'
    };
  }
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const base = (process.env.APPS_SCRIPT_URL || '').trim();
  const token = (process.env.APPS_SCRIPT_TOKEN || '').trim();
  if (!base || !token) {
    return send(res, 500, { ok: false, code: 'CONFIG', error: 'Variáveis APPS_SCRIPT_URL e/ou APPS_SCRIPT_TOKEN não configuradas na Vercel (refaça o deploy após criá-las).' });
  }

  const accessKey = (process.env.FROTA_ACCESS_KEY || '').trim();
  const action = String((req.query && req.query.action) || '').trim();
  if (accessKey && action !== 'health' && req.headers['x-frota-key'] !== accessKey) {
    return send(res, 401, { ok: false, code: 'ACCESS', error: 'Chave de acesso inválida ou ausente. Informe-a em Integração.' });
  }

  try {
    if (req.method === 'GET') {
      const act = action || 'health';
      if (!GET_ACTIONS.has(act)) return send(res, 400, { ok: false, error: 'Ação GET inválida.' });
      const u = new URL(base);
      u.searchParams.set('action', act);
      if (act !== 'health') u.searchParams.set('token', token);
      const data = await callAppsScript(u.toString(), { method: 'GET' });
      if (act === 'health') data.proxy = { ok: true, accessKeyRequired: !!accessKey };
      return send(res, data.ok === false && data.code === 'UPSTREAM' ? 502 : 200, data);
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!POST_ACTIONS.has(body.action)) return send(res, 400, { ok: false, error: 'Ação POST inválida.' });
      const data = await callAppsScript(base, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...body, token })
      });
      return send(res, data.ok === false && data.code === 'UPSTREAM' ? 502 : 200, data);
    }

    return send(res, 405, { ok: false, error: 'Método não permitido.' });
  } catch (err) {
    return send(res, 502, { ok: false, code: 'PROXY', error: 'Falha ao contatar o Apps Script: ' + (err && err.message ? err.message : err) });
  }
};
