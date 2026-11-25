/**
 * GET /api/gasolina-rj  — preço médio da gasolina comum no estado (padrão RJ)
 * Fonte: ANP — Série Histórica de Preços de Combustíveis, arquivo "últimas 4 semanas — gasolina e etanol"
 * (Levantamento de Preços de Combustíveis, coleta semanal em postos revendedores).
 * Parâmetros opcionais: ?uf=RJ
 * Resposta: { ok, uf, produto, preco, amostras, inicio, fim, fonte, url, consultadoEm }
 * O resultado fica em cache por 6 horas na Vercel (a ANP publica uma vez por semana).
 */
const ANP_URLS = [
  'https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-gasolina-etanol.csv'
];
let memo = null; // { key, at, data }
const TTL = 6 * 3600 * 1000;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^﻿/, '').trim().toUpperCase();
const toISO = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s).trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : (/^\d{4}-\d{2}-\d{2}/.test(s) ? String(s).slice(0, 10) : ''); };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function splitLine(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === sep && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur); return out;
}

async function download() {
  let lastErr;
  for (const url of ANP_URLS) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Labmedic Controle de Frota)' } });
      if (!r.ok) throw new Error('ANP respondeu HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      let txt = buf.toString('utf8');
      if (txt.includes('�')) txt = buf.toString('latin1');
      return { url, txt };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('falha ao baixar o arquivo da ANP');
}

function compute(txt, uf) {
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('arquivo da ANP vazio');
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const head = splitLine(lines[0], sep).map(norm);
  const col = names => head.findIndex(h => names.some(n => h === n || h.includes(n)));
  const iUF = col(['ESTADO - SIGLA', 'ESTADO']), iProd = col(['PRODUTO']), iData = col(['DATA DA COLETA']), iVal = col(['VALOR DE VENDA']);
  if ([iUF, iProd, iData, iVal].some(i => i < 0)) throw new Error('layout do arquivo da ANP mudou (colunas não encontradas)');
  const rows = [];
  for (let k = 1; k < lines.length; k++) {
    const c = splitLine(lines[k], sep);
    if (norm(c[iUF]) !== uf || norm(c[iProd]) !== 'GASOLINA') continue; // gasolina comum (exclui aditivada)
    const v = Number(String(c[iVal]).replace(/\./g, '').replace(',', '.')), d = toISO(c[iData]);
    if (isFinite(v) && v > 0 && d) rows.push({ d, v });
  }
  if (!rows.length) throw new Error('nenhuma coleta de gasolina encontrada para ' + uf);
  const fim = rows.reduce((m, r) => r.d > m ? r.d : m, ''), ini = addDays(fim, -6);
  const sem = rows.filter(r => r.d >= ini);
  const preco = sem.reduce((s, r) => s + r.v, 0) / sem.length;
  const inicio = sem.reduce((m, r) => r.d < m ? r.d : m, fim);
  return { preco: Math.round(preco * 1000) / 1000, amostras: sem.length, inicio, fim };
}

export default async function handler(req, res) {
  const uf = norm((req.query && req.query.uf) || 'RJ').slice(0, 2) || 'RJ';
  try {
    if (!memo || memo.key !== uf || Date.now() - memo.at > TTL) {
      const { url, txt } = await download();
      memo = { key: uf, at: Date.now(), data: { ...compute(txt, uf), url } };
    }
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({ ok: true, uf, produto: 'Gasolina comum', ...memo.data,
      fonte: 'ANP — Levantamento de Preços de Combustíveis (série histórica, últimas 4 semanas)',
      consultadoEm: new Date(memo.at).toISOString() });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ ok: false, error: 'Não foi possível obter o preço da ANP: ' + e.message });
  }
}
