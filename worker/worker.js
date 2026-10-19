/**
 * Mila Music Dance — intermediario gratuito (Cloudflare Worker)
 * Guarda la llave de ElevenLabs, limita el uso y devuelve el MP3.
 *
 * Rutas:
 *   GET  /coins?device=ID          -> { coins, dailyLimit, monthLeft }
 *   POST /song  { device, lyrics, style, voice, bpm, seconds, ts, pin? } -> audio/mpeg
 *   Protegido por: origen permitido, Turnstile, tope global diario y limite por IP.
 */

// Solo la app publicada puede pedir canciones
const ALLOWED_ORIGINS = [
  'https://lparra-alku.github.io',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
  'https://localhost',        // app nativa iOS y Android (Capacitor)
  'capacitor://localhost',
];
const baseCors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Expose-Headers': 'X-Coins, X-Free, X-Paid, X-Month-Left',
  'Vary': 'Origin',
});
let CORS = baseCors('');

const STYLE_PROMPTS = {
  pop:      ['upbeat kids pop', 'bright synths', 'catchy chorus', 'happy', 'modern radio production'],
  reg:      ['kids reggaeton', 'dembow beat', 'playful', 'latin urban', 'clean fun vibe'],
  rock:     ['fun kids rock', 'electric guitar riffs', 'energetic drums', 'anthemic'],
  cumbia:   ['cumbia', 'accordion', 'guira percussion', 'festive latin', 'danceable'],
  ranchera: ['ranchera mexicana', 'mariachi trumpets', 'vihuela and guitarron', 'proud and warm', 'traditional mexican'],
  mariachi: ['mariachi festivo', 'trumpet fanfare', 'violins', 'son jalisciense', 'celebratory'],
  banda:    ['banda sinaloense', 'brass section', 'tuba bassline', 'snare shuffle', 'norteno party'],
  norteno:  ['norteno', 'accordion and bajo sexto', 'polka rhythm', 'cheerful mexican'],
  salsa:    ['salsa', 'montuno piano', 'congas and timbales', 'brass stabs', 'tropical dance'],
  hiphop:   ['kid friendly hip hop', 'boom bap drums', 'playful bassline', 'fun rap flow', 'clean'],
  disco:    ['disco funk', 'four on the floor', 'slap bass', 'strings and claps', 'groovy'],
  electro:  ['kids edm dance', 'festival synths', 'big drop', 'energetic build', 'bright'],
  balada:   ['balada latina', 'piano and strings', 'emotional', 'gentle tempo'],
  navidad:  ['christmas song', 'sleigh bells', 'festive choir', 'warm and joyful'],
  sueno:    ['gentle lullaby pop', 'soft piano', 'dreamy pads', 'warm and calm'],
};

const VOICE_PROMPTS = {
  nina:   ['young girl lead vocals', 'child singer', 'sweet bright voice'],
  nino:   ['young boy lead vocals', 'child singer', 'playful bright voice'],
  mujer:  ['female lead vocals', 'adult woman singer', 'clear warm voice'],
  hombre: ['male lead vocals', 'adult man singer', 'clear warm voice'],
  coro:   ['kids choir vocals', 'group of children singing together', 'unison chorus'],
};
const VOICE_NEGATIVE = {
  nina:   ['male vocals', 'deep voice'],
  nino:   ['female vocals', 'deep voice'],
  mujer:  ['male vocals', 'child vocals'],
  hombre: ['female vocals', 'child vocals'],
  coro:   ['solo vocals'],
};


const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);

async function counter(env, key) { return parseInt((await env.COINS.get(key)) || '0', 10); }
/* ===================== MONEDERO =====================
 * Dos bolsillos por usuario:
 *  - gratis: FREE_DAILY monedas al día (contador dev:<uid>:<día>), se gastan primero
 *  - compradas: saldo permanente en wallet:<uid>, solo lo suben compras confirmadas
 * El uid hoy es el identificador del dispositivo; después será la cuenta del papá.
 */
const WALLET_LOG = 30;
async function getWallet(env, uid) {
  const w = JSON.parse((await env.COINS.get(`wallet:${uid}`)) || 'null');
  return w || { paid: 0, created: new Date().toISOString(), log: [] };
}
async function saveWallet(env, uid, w) {
  w.updated = new Date().toISOString();
  w.log = (w.log || []).slice(-WALLET_LOG);
  await env.COINS.put(`wallet:${uid}`, JSON.stringify(w));
}
function promoActive(w) {
  return w.promo && (!w.promo.until || w.promo.until > new Date().toISOString()) ? w.promo : null;
}
async function walletView(env, uid, FREE) {
  const usedFree = await counter(env, `dev:${uid}:${today()}`);
  const w = await getWallet(env, uid);
  const pr = promoActive(w);
  const daily = Math.max(FREE, pr ? pr.daily : 0);
  const free = Math.max(0, daily - usedFree);
  return { free, freeMax: daily, paid: w.paid, total: free + w.paid, promo: pr ? { code: pr.code, daily: pr.daily, until: pr.until || null } : null };
}
// Códigos legibles: sin 0/O ni 1/I para que no se confundan al teclearlos
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(prefix) {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}-` + [...r].map(b => CODE_ABC[b % CODE_ABC.length]).join('');
}
/* ===================== CUENTA FAMILIAR =====================
 * El saldo comprado y los códigos de promoción viven en la cuenta, no en el dispositivo.
 * Acceso con un código familiar secreto (80 bits). El servidor solo guarda su huella SHA-256.
 * Cada dispositivo enlazado recibe una sesión; con ella el uid efectivo es "acct_<id>".
 */
async function sha256(t) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomId(n) { return [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join(''); }
function makeFamilyCode() {
  const r = crypto.getRandomValues(new Uint8Array(16));
  const c = [...r].map(b => CODE_ABC[b % CODE_ABC.length]).join('');
  return `FAM-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}`;
}
const normFamily = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^FAM/, '');
async function familyKey(code) { return `fam:${await sha256('fam:' + normFamily(code))}`; }
async function sessionAccount(env, session) {
  if (!session || typeof session !== 'string' || session.length < 32) return null;
  const id = await env.COINS.get(`sess:${await sha256(session)}`);
  if (!id) return null;
  const a = JSON.parse((await env.COINS.get(`acct:${id}`)) || 'null');
  return a;
}
// uid efectivo: la cuenta si la sesión es válida; si no, el dispositivo
async function resolveUid(env, device, session) {
  const a = await sessionAccount(env, session);
  return a ? `acct_${a.id}` : cleanUid(device);
}
// Pasa el saldo comprado y la promo del dispositivo a la cuenta, una sola vez
async function mergeDeviceIntoAccount(env, device, acctUid) {
  const dev = cleanUid(device);
  if (dev === 'anon' || dev.startsWith('acct_')) return 0;
  const dw = await getWallet(env, dev);
  if (!dw.paid && !dw.promo) return 0;
  const aw = await getWallet(env, acctUid);
  const moved = dw.paid;
  aw.paid += moved;
  if (dw.promo && (!aw.promo || dw.promo.daily > aw.promo.daily)) aw.promo = dw.promo;
  aw.log.push({ t: new Date().toISOString(), delta: moved, why: `traspaso desde dispositivo` });
  dw.paid = 0; dw.promo = null;
  dw.log.push({ t: new Date().toISOString(), delta: -moved, why: `traspaso a la cuenta` });
  await saveWallet(env, acctUid, aw);
  await saveWallet(env, dev, dw);
  return moved;
}
async function newSession(env, acct, device) {
  const token = randomId(32);
  await env.COINS.put(`sess:${await sha256(token)}`, acct.id);
  acct.sessions = [...(acct.sessions || []), await sha256(token)].slice(-20);
  acct.devices = [...new Set([...(acct.devices || []), cleanUid(device)])].slice(-20);
  await env.COINS.put(`acct:${acct.id}`, JSON.stringify(acct));
  return token;
}
async function ipLimit(env, req, name, max) {
  const ip = req.headers.get('CF-Connecting-IP') || 'sin-ip';
  const k = `${name}:${ip}:${new Date().toISOString().slice(0, 13)}`;
  if ((await counter(env, k)) >= max) return false;
  await bump(env, k, 1, 60 * 60 * 2);
  return true;
}

const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
const cleanUid = (v) => String(v || 'anon').replace(/[^A-Za-z0-9_\-:.]/g, '').slice(0, 64) || 'anon';

async function bump(env, key, by, ttl) { await env.COINS.put(key, String((await counter(env, key)) + by), { expirationTtl: ttl }); }

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
}

// Parte líneas largas en versos de ~7 palabras (ElevenLabs admite máximo 200 caracteres por línea)
function normalizeLines(lyrics) {
  const out = [];
  for (const raw of lyrics.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const words = line.split(' ');
    if (line.length <= 60 && words.length <= 9) { out.push(line); continue; }
    let cur = [];
    for (const w of words) {
      cur.push(w);
      const txt = cur.join(' ');
      if (cur.length >= 7 || /[.,;!?]$/.test(w) && cur.length >= 4 || txt.length > 150) { out.push(txt.replace(/[,;]$/, '')); cur = []; }
    }
    if (cur.length) out.push(cur.join(' '));
  }
  return out.map(l => l.slice(0, 200)).slice(0, 24);
}

function buildPlan(lyrics, style, bpm, seconds, voice) {
  const lines = normalizeLines(lyrics);
  const styles = STYLE_PROMPTS[style] || STYLE_PROMPTS.pop;
  const vox = VOICE_PROMPTS[voice] || VOICE_PROMPTS.nina;
  const base = [...styles, ...vox, `${bpm} bpm`, 'child-friendly lyrics', 'clear diction', 'spanish lyrics', 'great production quality'];
  const negative = ['explicit', 'dark', 'aggressive', 'sad', ...(VOICE_NEGATIVE[voice] || VOICE_NEGATIVE.nina)];
  // Máximo 2 trozos (verso y coro) para canciones cortas
  const half = Math.ceil(lines.length / 2);
  const parts = lines.length <= 4
    ? [{ name: 'Verse', lines }]
    : [{ name: 'Verse', lines: lines.slice(0, half) }, { name: 'Chorus', lines: lines.slice(half) }];
  const per = Math.max(3000, Math.floor((seconds * 1000) / parts.length));
  return {
    chunks: parts.map((s, i) => ({
      text: `[${s.name}]\n` + s.lines.join('\n'),
      duration_ms: per,
      positive_styles: i === 0 ? base : [...styles.slice(0, 2), ...vox.slice(0, 1), 'catchy', 'bigger drums'],
      negative_styles: negative,
    })),
  };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    CORS = baseCors(origin);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const MONTH_CREDITS = parseInt(env.MONTHLY_CREDITS || '9000', 10);
    const CREDITS_PER_SEC = 12.5; // ElevenLabs cobra ~375 créditos por canción de 30 s

    const FREE = parseInt(env.FREE_DAILY || env.DAILY_PER_DEVICE || '5', 10);

    // Saldo del monedero
    if (url.pathname === '/wallet' && req.method === 'GET') {
      const uidQ = await resolveUid(env, url.searchParams.get('uid'), url.searchParams.get('session'));
      return json({ ...(await walletView(env, uidQ, FREE)), account: uidQ.startsWith('acct_') });
    }

    // Abonar monedas compradas. Solo con la llave de administrador (después: aviso de RevenueCat).
    // 'ref' identifica la compra: si llega dos veces, se abona una sola vez.
    if (url.pathname === '/wallet/grant' && req.method === 'POST') {
      if (!env.ADMIN_KEY || req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return json({ error: 'No autorizado' }, 401);
      const b = await req.json().catch(() => ({}));
      const uid = cleanUid(b.uid), coins = parseInt(b.coins, 10), ref = String(b.ref || '').slice(0, 120);
      if (!uid || uid === 'anon' || !Number.isFinite(coins) || coins === 0 || Math.abs(coins) > 1000) return json({ error: 'Datos inválidos' }, 400);
      if (!ref) return json({ error: 'Falta ref (identificador de la compra)' }, 400);
      if (await env.COINS.get(`grant:${ref}`)) return json({ ok: true, duplicado: true, ...(await walletView(env, uid, FREE)) });
      const w = await getWallet(env, uid);
      w.paid = Math.max(0, w.paid + coins);
      w.log.push({ t: new Date().toISOString(), delta: coins, why: String(b.reason || 'abono').slice(0, 60), ref });
      await saveWallet(env, uid, w);
      await env.COINS.put(`grant:${ref}`, uid);
      return json({ ok: true, ...(await walletView(env, uid, FREE)) });
    }

    // ---- Cuenta familiar ----
    if (url.pathname.startsWith('/account/') && req.method === 'POST') {
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Esta app no está autorizada.' }, 403);
      const b = await req.json().catch(() => ({}));
      const op = url.pathname.slice('/account/'.length);

      if (op === 'create') {
        if (!(await ipLimit(env, req, 'acctnew', 5))) return json({ error: 'Demasiadas cuentas nuevas desde esta conexión. Prueba en una hora.' }, 429);
        const acct = { id: randomId(12), created: new Date().toISOString(), sessions: [], devices: [] };
        const code = makeFamilyCode();
        acct.codeKey = await familyKey(code);
        await env.COINS.put(acct.codeKey, acct.id);
        const session = await newSession(env, acct, b.device);
        const moved = await mergeDeviceIntoAccount(env, b.device, `acct_${acct.id}`);
        return json({ ok: true, familyCode: code, session, moved, wallet: await walletView(env, `acct_${acct.id}`, FREE) });
      }

      if (op === 'link') {
        if (!(await ipLimit(env, req, 'acctlink', 10))) return json({ error: 'Demasiados intentos. Prueba en una hora.' }, 429);
        const id = await env.COINS.get(await familyKey(b.code));
        const acct = id && JSON.parse((await env.COINS.get(`acct:${id}`)) || 'null');
        if (!acct) return json({ error: 'Ese código familiar no existe. Revísalo letra por letra.' }, 404);
        const session = await newSession(env, acct, b.device);
        const moved = await mergeDeviceIntoAccount(env, b.device, `acct_${acct.id}`);
        return json({ ok: true, session, moved, wallet: await walletView(env, `acct_${acct.id}`, FREE) });
      }

      const acct = await sessionAccount(env, b.session);
      if (!acct) return json({ error: 'La sesión ya no es válida. Vuelve a entrar con tu código familiar.', noSession: true }, 401);

      if (op === 'me') {
        return json({ ok: true, created: acct.created, devices: (acct.devices || []).length, wallet: await walletView(env, `acct_${acct.id}`, FREE) });
      }
      if (op === 'logout') {
        const h = await sha256(b.session);
        await env.COINS.delete(`sess:${h}`);
        acct.sessions = (acct.sessions || []).filter(x => x !== h);
        await env.COINS.put(`acct:${acct.id}`, JSON.stringify(acct));
        return json({ ok: true });
      }
      if (op === 'rotate') {
        // Código nuevo: el anterior deja de servir. Las sesiones abiertas siguen activas.
        await env.COINS.delete(acct.codeKey);
        const code = makeFamilyCode();
        acct.codeKey = await familyKey(code);
        await env.COINS.put(acct.codeKey, acct.id);
        await env.COINS.put(`acct:${acct.id}`, JSON.stringify(acct));
        return json({ ok: true, familyCode: code });
      }
      if (op === 'delete') {
        // Borrado completo (requisito de Apple): cuenta, código, sesiones y saldo
        if (b.confirm !== 'BORRAR') return json({ error: 'Falta confirmar' }, 400);
        for (const h of acct.sessions || []) await env.COINS.delete(`sess:${h}`);
        await env.COINS.delete(acct.codeKey);
        await env.COINS.delete(`wallet:acct_${acct.id}`);
        await env.COINS.delete(`acct:${acct.id}`);
        return json({ ok: true, borrada: true });
      }
      return json({ error: 'Operación desconocida' }, 404);
    }

    // Crear un código de promoción (solo administrador)
    // { daily: monedas gratis al día, maxUses: cuántas personas, days: días de beneficio (0 = sin fin), code?: propio, label? }
    if (url.pathname === '/promo/create' && req.method === 'POST') {
      if (!env.ADMIN_KEY || req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return json({ error: 'No autorizado' }, 401);
      const b = await req.json().catch(() => ({}));
      const daily = Math.min(20, Math.max(1, parseInt(b.daily || '5', 10)));
      const maxUses = Math.min(10000, Math.max(1, parseInt(b.maxUses || '50', 10)));
      const days = Math.max(0, parseInt(b.days || '0', 10));
      const code = b.code ? cleanCode(b.code) : makeCode('MUSIC');
      if (code.length < 6) return json({ error: 'El código debe tener al menos 6 caracteres' }, 400);
      if (await env.COINS.get(`promo:${code}`)) return json({ error: 'Ese código ya existe' }, 409);
      const promo = { code, daily, maxUses, uses: 0, days, label: String(b.label || '').slice(0, 60), created: new Date().toISOString(), active: true };
      await env.COINS.put(`promo:${code}`, JSON.stringify(promo));
      return json({ ok: true, ...promo });
    }

    // Consultar o desactivar un código (solo administrador)
    if (url.pathname === '/promo/info' && req.method === 'POST') {
      if (!env.ADMIN_KEY || req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return json({ error: 'No autorizado' }, 401);
      const b = await req.json().catch(() => ({}));
      const code = cleanCode(b.code);
      const promo = JSON.parse((await env.COINS.get(`promo:${code}`)) || 'null');
      if (!promo) return json({ error: 'No existe' }, 404);
      if (b.active === false) { promo.active = false; await env.COINS.put(`promo:${code}`, JSON.stringify(promo)); }
      return json(promo);
    }

    // Canjear un código desde la app
    if (url.pathname === '/promo/redeem' && req.method === 'POST') {
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Esta app no está autorizada.' }, 403);
      // Freno contra quien intente adivinar códigos: 10 intentos por hora por conexión
      const ip = req.headers.get('CF-Connecting-IP') || 'sin-ip';
      const tryKey = `promotry:${ip}:${new Date().toISOString().slice(0, 13)}`;
      if ((await counter(env, tryKey)) >= 10) return json({ error: 'Demasiados intentos. Prueba en una hora.' }, 429);
      await bump(env, tryKey, 1, 60 * 60 * 2);
      const b = await req.json().catch(() => ({}));
      const uid = await resolveUid(env, b.uid, b.session), code = cleanCode(b.code);
      if (uid === 'anon' || !code) return json({ error: 'Escribe el código' }, 400);
      const promo = JSON.parse((await env.COINS.get(`promo:${code}`)) || 'null');
      if (!promo || !promo.active) return json({ error: 'Ese código no existe o ya no está activo.' }, 404);
      const w = await getWallet(env, uid);
      if (w.promo && w.promo.code === code) return json({ ok: true, yaTenias: true, ...(await walletView(env, uid, FREE)) });
      if (promo.uses >= promo.maxUses) return json({ error: 'Ese código ya se usó todas las veces posibles.' }, 410);
      promo.uses += 1;
      await env.COINS.put(`promo:${code}`, JSON.stringify(promo));
      const until = promo.days ? new Date(Date.now() + promo.days * 86400000).toISOString() : null;
      w.promo = { code, daily: promo.daily, until, since: new Date().toISOString() };
      w.log.push({ t: new Date().toISOString(), delta: 0, why: `promo ${code}` });
      await saveWallet(env, uid, w);
      return json({ ok: true, ...(await walletView(env, uid, FREE)) });
    }

    if (url.pathname === '/coins') {
      const device = url.searchParams.get('device') || 'anon';
      // compatibilidad con versiones anteriores de la app
      const v = await walletView(env, cleanUid(device), FREE);
      return json({ coins: v.total, dailyLimit: FREE, free: v.free, paid: v.paid });
    }

    if (url.pathname === '/status') {
      const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } });
      const j = await r.json().catch(() => ({}));
      const usedMonth = await counter(env, `global:${month()}`);
      const lastError = JSON.parse((await env.COINS.get('lasterror')) || 'null');
      return json({ ultimo_error: lastError, elevenlabs: { plan: j.tier, usados: j.character_count, limite: j.character_limit, se_renueva: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : null }, worker: { usados_mes: usedMonth, tope_mes: MONTH_CREDITS, restante: MONTH_CREDITS - usedMonth, canciones_hoy: await counter(env, `globalday:${today()}`), tope_dia: parseInt(env.DAILY_GLOBAL_SONGS || '40', 10) } });
    }

    if (url.pathname === '/song' && req.method === 'POST') {
      // 1) Solo desde la app publicada
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Esta app no está autorizada.' }, 403);

      // 2) Turnstile: comprueba que quien pide es un navegador real, no un script
      const requireTs = (env.REQUIRE_TURNSTILE || '1') === '1';
      if (requireTs && env.TURNSTILE_SECRET) {
        const body0 = await req.clone().json().catch(() => ({}));
        const tsToken = body0.ts;
        if (!tsToken) return json({ error: 'Falta la verificación de seguridad. Recarga la app.' }, 403);
        const form = new FormData();
        form.append('secret', env.TURNSTILE_SECRET);
        form.append('response', tsToken);
        form.append('remoteip', req.headers.get('CF-Connecting-IP') || '');
        const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form }).then(r => r.json()).catch(() => null);
        if (!v || !v.success) return json({ error: 'No pudimos verificar la app. Recarga la página.' }, 403);
      }

      // 3) ¿De qué bolsillo se paga esta canción? Gratis primero, luego compradas.
      const b0 = await req.clone().json().catch(() => ({}));
      const uid = await resolveUid(env, b0.device, b0.session);
      const wv = await walletView(env, uid, FREE);
      if (wv.total <= 0) return json({ error: 'Se acabaron tus monedas 🪙 Pídele a un adulto que consiga más.', needCoins: true, ...wv }, 402);
      const payWithFree = wv.free > 0;

      // Candado: evita que dos toques seguidos gasten de más mientras se genera
      if (await env.COINS.get(`lock:${uid}`)) return json({ error: 'Ya se está creando una canción, espera un momento 🎶' }, 409);
      await env.COINS.put(`lock:${uid}`, '1', { expirationTtl: 60 });
      try {

      // 4) Los topes anti-abuso aplican solo a monedas gratis: las compradas ya están pagadas
      if (payWithFree) {
      const GLOBAL_DAY = parseInt(env.DAILY_GLOBAL_SONGS || '40', 10);
      const gKey = `globalday:${today()}`;
      if ((await counter(env, gKey)) >= GLOBAL_DAY) return json({ error: 'Hoy ya se hicieron muchas canciones 😅 Vuelve mañana.' }, 429);

      // 4) Límite por conexión (IP), contra quien borre los datos del navegador
      const ip = req.headers.get('CF-Connecting-IP') || 'sin-ip';
      const ipH = `ip:${ip}:${new Date().toISOString().slice(0, 13)}`, ipD = `ip:${ip}:${today()}`;
      const IP_HOUR = parseInt(env.IP_HOUR || '6', 10), IP_DAY = parseInt(env.IP_DAY || '12', 10);
      if ((await counter(env, ipH)) >= IP_HOUR || (await counter(env, ipD)) >= IP_DAY) return json({ error: 'Demasiadas canciones seguidas desde esta conexión. Descansa un rato 🎈' }, 429);
      }

      let body; try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
      const device = String(body.device || 'anon').slice(0, 64);
      const lyrics = String(body.lyrics || '').slice(0, 2000);
      const style = String(body.style || 'pop');
      const voice = String(body.voice || 'nina');
      const bpm = Math.min(160, Math.max(70, parseInt(body.bpm || '110', 10)));
      const seconds = Math.min(60, Math.max(20, parseInt(body.seconds || '30', 10)));
      if (!lyrics.trim()) return json({ error: 'Falta la letra' }, 400);

      // Filtro básico de palabras (ampliar según necesidad)
      const banned = /\b(mierda|puta|puto|idiota|estúpid[oa]|matar|sangre)\b/i;
      if (banned.test(lyrics)) return json({ error: 'Esa palabra no va en la canción 🙈' }, 422);

      const cost = seconds * CREDITS_PER_SEC;
      const monthKey = `global:${month()}`;
      const usedMonth = await counter(env, monthKey);

      // Saldo REAL de ElevenLabs (deja una reserva de seguridad)
      const RESERVE = parseInt(env.RESERVE_CREDITS || '1000', 10);
      const sub = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } }).then(r => r.json()).catch(() => null);
      if (sub && sub.character_limit && sub.character_limit - sub.character_count - RESERVE < cost) return json({ error: 'Se acabaron las canciones de este mes 😴 Se renuevan el ' + (sub.next_character_count_reset_unix ? new Date(sub.next_character_count_reset_unix * 1000).toLocaleDateString('es-MX') : 'próximo ciclo') }, 429);
      if (!sub && usedMonth + cost > MONTH_CREDITS) return json({ error: 'Se acabaron las canciones de este mes 😴' }, 429);

      const plan = buildPlan(lyrics, style, bpm, seconds, voice);
      const call = () => fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ composition_plan: plan, model_id: 'music_v2_5' }),
      });
      let r = await call();
      if (r.status >= 500) r = await call(); // reintenta una vez si ElevenLabs tuvo un error pasajero
      if (!r.ok) {
        const txt = await r.text();
        await env.COINS.put('lasterror', JSON.stringify({ when: new Date().toISOString(), status: r.status, detail: txt.slice(0, 800), lines: plan.chunks.map(c => c.text) }));
        return json({ error: 'La IA no pudo con esa letra 😅 Prueba con versos más cortos, uno por línea.', detail: txt.slice(0, 500) }, 502);
      }
      // Cobra solo si salió bien, del bolsillo que corresponde
      if (payWithFree) {
        await bump(env, `dev:${uid}:${today()}`, 1, 60 * 60 * 48);
        await bump(env, `globalday:${today()}`, 1, 60 * 60 * 48);
        await bump(env, `ip:${req.headers.get('CF-Connecting-IP') || 'sin-ip'}:${new Date().toISOString().slice(0, 13)}`, 1, 60 * 60 * 3);
        await bump(env, `ip:${req.headers.get('CF-Connecting-IP') || 'sin-ip'}:${today()}`, 1, 60 * 60 * 48);
      } else {
        const w = await getWallet(env, uid);
        w.paid = Math.max(0, w.paid - 1);
        w.log.push({ t: new Date().toISOString(), delta: -1, why: 'cancion' });
        await saveWallet(env, uid, w);
      }
      await bump(env, monthKey, cost, 60 * 60 * 24 * 40);
      const after = await walletView(env, uid, FREE);
      return new Response(r.body, { headers: { 'Content-Type': 'audio/mpeg', ...CORS, 'X-Coins': String(after.total), 'X-Free': String(after.free), 'X-Paid': String(after.paid), 'X-Month-Left': String(MONTH_CREDITS - usedMonth - cost) } });

      } finally {
        await env.COINS.delete(`lock:${uid}`);
      }
    }
    return json({ ok: true, app: 'Music Dance' });
  },
};
