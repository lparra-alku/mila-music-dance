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
  'https://play.musicdance.app',
  'https://musicdance-play.pages.dev',   // dirección provisional de Cloudflare Pages
  'http://localhost:8765',
  'http://127.0.0.1:8765',
  'https://localhost',        // app nativa iOS y Android (Capacitor)
  'capacitor://localhost',
];
const baseCors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
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
/* --- Correo y contraseña ---
 * La contraseña se guarda como PBKDF2-SHA256 (100 000 vueltas, sal aleatoria). Nunca en claro.
 * El correo se indexa por su huella: email:<sha256(correo)> -> id de la cuenta.
 */
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 120);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
async function hashPassword(pw, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  const hex = (u) => [...new Uint8Array(u)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { salt: hex(salt), hash: hex(bits) };
}
async function emailKey(email) { return `email:${await sha256('email:' + normEmail(email))}`; }
async function sendMail(env, to, subject, html) {
  // Odoo manda el correo con su servidor de salida
  const id = await odoo(env, 'mail.mail', 'create', [{ email_to: to, subject, body_html: html, auto_delete: true }]);
  await odoo(env, 'mail.mail', 'send', [[id]]);
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

/* ===================== VENTAS CON ODOO =====================
 * Odoo avisa (webhook) cuando un pedido se confirma. El Worker NO confía en el aviso:
 * relee el pedido en Odoo con su propia llave, exige un pago con estado "hecho" que cubra
 * el total, y solo entonces crea un código BOLSA de un solo uso y se lo manda al cliente
 * con un mensaje en el pedido (Odoo lo envía por correo).
 */
async function odoo(env, model, method, args, kw = {}) {
  const r = await fetch(`${env.ODOO_URL}/jsonrpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service: 'object', method: 'execute_kw',
      args: [env.ODOO_DB, parseInt(env.ODOO_UID, 10), env.ODOO_API_KEY, model, method, args, kw] } }),
  });
  const j = await r.json();
  if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message);
  return j.result;
}
function makeBagCode() {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const c = [...r].map(b => CODE_ABC[b % CODE_ABC.length]).join('');
  return `BOLSA-${c.slice(0, 4)}-${c.slice(4, 8)}`;
}
const APP_URL = 'https://play.musicdance.app/';
async function processPaidOrder(env, orderId) {
  const done = await env.COINS.get(`order:${orderId}`);
  if (done) return { ok: true, yaProcesado: true, code: done };
  let o = null, paid = false;
  // Odoo puede avisar un instante antes de terminar de guardar el pago: reintenta unos segundos
  for (let i = 0; i < 6 && !paid; i++) {
    if (i) await new Promise(r => setTimeout(r, 2500));
    [o] = await odoo(env, 'sale.order', 'read', [[orderId]], { fields: ['name', 'state', 'amount_total', 'partner_id', 'order_line', 'transaction_ids', 'currency_id'] });
    if (!o || !['sale', 'done'].includes(o.state)) continue;
    const txs = o.transaction_ids.length ? await odoo(env, 'payment.transaction', 'read', [o.transaction_ids], { fields: ['state', 'amount'] }) : [];
    const cobrado = txs.filter(t => t.state === 'done').reduce((a, t) => a + t.amount, 0);
    paid = cobrado + 0.01 >= o.amount_total && o.amount_total > 0;
  }
  if (!paid) return { ok: false, motivo: 'pedido sin pago confirmado' };
  const lines = await odoo(env, 'sale.order.line', 'read', [o.order_line], { fields: ['product_id', 'product_uom_qty'] });
  const prodIds = [...new Set(lines.filter(l => l.product_id).map(l => l.product_id[0]))];
  const prods = prodIds.length ? await odoo(env, 'product.product', 'read', [prodIds], { fields: ['default_code'] }) : [];
  const codeOf = Object.fromEntries(prods.map(p => [p.id, p.default_code || '']));
  let coins = 0;
  for (const l of lines) { const m = /^MD-BOLSA-(\d+)$/.exec(codeOf[l.product_id && l.product_id[0]] || ''); if (m) coins += parseInt(m[1], 10) * Math.round(l.product_uom_qty); }
  if (!coins) return { ok: false, motivo: 'el pedido no tiene bolsas de canciones' };
  const code = makeBagCode();
  await env.COINS.put(`bag:${code}`, JSON.stringify({ coins, order: o.name, orderId, created: new Date().toISOString(), used: false }));
  await env.COINS.put(`order:${orderId}`, code);
  const link = `${APP_URL}?codigo=${code}`;
  const body = `<p>¡Gracias por tu compra! 🎶</p>
<p>Tu código para <b>${coins} canciones</b> en Music Dance es:</p>
<p style="font-size:22px;font-weight:bold;letter-spacing:2px">${code}</p>
<p><a href="${link}" style="display:inline-block;background:#ffd43b;color:#1a0b3d;font-weight:bold;padding:10px 18px;border-radius:12px;text-decoration:none">Abrir Music Dance y canjear</a></p>
<p>El botón abre la app con el código ya escrito. Entra con tu correo o crea tu cuenta (es gratis) y toca <b>Canjear</b>. El código sirve una sola vez y las canciones no caducan.</p>`;
  await odoo(env, 'sale.order', 'write', [[orderId], { x_md_codigo: code }]); // lo muestra la página de confirmación del pago
  await odoo(env, 'sale.order', 'message_post', [[orderId]], { body, body_is_html: true, partner_ids: [o.partner_id[0]], message_type: 'comment', subtype_xmlid: 'mail.mt_comment' });
  return { ok: true, code, coins, order: o.name };
}

/* ===================== COBRO DIRECTO CON STRIPE =====================
 * /buy?pack=MD-BOLSA-60 crea una sesión de Stripe Checkout con el precio del producto en Odoo
 * y redirige a la página de pago. Al pagar, Stripe regresa a la app con ?pago=<sesión>.
 * El Worker NUNCA confía en la URL: le pregunta a Stripe si la sesión está pagada.
 * Luego crea la bolsa de canciones y registra y confirma el pedido en Odoo.
 */
async function stripe(env, method, path, params) {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { method, body,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}
async function packFromOdoo(env, code) {
  const ck = `packcache:${code}`;
  const c = await env.COINS.get(ck);
  if (c) return JSON.parse(c);
  const [p] = await odoo(env, 'product.product', 'search_read', [[['default_code', '=', code], ['sale_ok', '=', true]]], { fields: ['id', 'name', 'list_price'], limit: 1 });
  if (!p) return null;
  const m = /^MD-BOLSA-(\d+)$/.exec(code);
  const pack = { productId: p.id, name: p.name, price: p.list_price, coins: parseInt(m[1], 10), code };
  await env.COINS.put(ck, JSON.stringify(pack), { expirationTtl: 600 });
  return pack;
}
async function processStripeSession(env, sid) {
  const prev = JSON.parse((await env.COINS.get(`stripe:${sid}`)) || 'null');
  if (prev) return { ok: true, ...prev };
  const ses = await stripe(env, 'GET', `checkout/sessions/${encodeURIComponent(sid)}`);
  if (ses.payment_status !== 'paid') return { ok: false, pending: true, status: ses.payment_status };
  const coins = parseInt(ses.metadata && ses.metadata.coins, 10);
  if (!coins) return { ok: false, error: 'Sesión sin bolsa' };
  const code = makeBagCode();
  const email = (ses.customer_details && ses.customer_details.email) || '';
  const name = (ses.customer_details && ses.customer_details.name) || email;
  const rec = { code, coins, email, amount: ses.amount_total / 100 };
  await env.COINS.put(`bag:${code}`, JSON.stringify({ coins, order: `Stripe ${sid.slice(-8)}`, stripe: sid, created: new Date().toISOString(), used: false }));
  await env.COINS.put(`stripe:${sid}`, JSON.stringify(rec));
  // Registro en Odoo (si falla, la venta y el código ya existen; se reintenta con /admin/stripe/odoo)
  try { rec.order = await recordInOdoo(env, ses, rec); await env.COINS.put(`stripe:${sid}`, JSON.stringify(rec)); }
  catch (e) { await env.COINS.put(`stripeerr:${sid}`, JSON.stringify({ when: new Date().toISOString(), error: String(e) }), { expirationTtl: 60 * 60 * 24 * 30 }); }
  return { ok: true, ...rec };
}
async function recordInOdoo(env, ses, rec) {
  const pack = await packFromOdoo(env, ses.metadata.pack);
  const email = rec.email || 'sin-correo@musicdance.app';
  let [partner] = await odoo(env, 'res.partner', 'search_read', [[['email', '=ilike', email]]], { fields: ['id'], limit: 1 });
  const partnerId = partner ? partner.id : await odoo(env, 'res.partner', 'create', [{ name: (ses.customer_details && ses.customer_details.name) || email, email }]);
  const orderId = await odoo(env, 'sale.order', 'create', [{ partner_id: partnerId, client_order_ref: `Stripe ${ses.id}`, x_md_codigo: rec.code,
    order_line: [[0, 0, { product_id: pack.productId, product_uom_qty: 1, price_unit: rec.amount, tax_ids: [[6, 0, []]] }]] }]);
  await env.COINS.put(`order:${orderId}`, rec.code);   // la automatización de Odoo ve que ya se procesó
  await odoo(env, 'sale.order', 'action_confirm', [[orderId]]);
  const link = `${APP_URL}?codigo=${rec.code}`;
  await odoo(env, 'sale.order', 'message_post', [[orderId]], { partner_ids: [partnerId], message_type: 'comment', subtype_xmlid: 'mail.mt_comment', body_is_html: true,
    body: `<p>¡Gracias por tu compra! 🎶 Pagaste ${rec.coins} canciones para Music Dance.</p><p>Si al pagar ya entraste a tu cuenta en la app, las canciones ya están ahí. Si no, este es tu código de respaldo:</p><p style="font-size:22px;font-weight:bold;letter-spacing:2px">${rec.code}</p><p><a href="${link}">Toca aquí para abrir Music Dance y canjearlo</a>.</p>` });
  return orderId;
}
async function verifyStripeSignature(secret, header, body) {
  const parts = Object.fromEntries(String(header || '').split(',').map(kv => kv.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(parts.t, 10)) > 600) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${body}`));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === parts.v1;
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
  async fetch(req, env, ctx) {
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

    // ---- Cobro directo con Stripe ----
    if (url.pathname === '/buy' && req.method === 'GET') {
      if (!env.STRIPE_SECRET_KEY) return json({ error: 'Pagos aún no configurados' }, 503);
      const pack = await packFromOdoo(env, String(url.searchParams.get('pack') || '').toUpperCase());
      if (!pack) return json({ error: 'Esa bolsa no existe' }, 404);
      const params = {
        mode: 'payment', locale: 'es-419',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'mxn',
        'line_items[0][price_data][unit_amount]': String(Math.round(pack.price * 100)),
        'line_items[0][price_data][product_data][name]': `${pack.name} · Music Dance`,
        'line_items[0][price_data][product_data][description]': 'Canciones cantadas por IA. No caducan.',
        'metadata[pack]': pack.code, 'metadata[coins]': String(pack.coins),
        'payment_intent_data[description]': `Music Dance: ${pack.name}`,
        success_url: `${APP_URL}?pago={CHECKOUT_SESSION_ID}`,
        cancel_url: 'https://www.musicdance.app/#bolsas',
      };
      const em = normEmail(url.searchParams.get('email'));
      if (validEmail(em)) params.customer_email = em;
      const ses = await stripe(env, 'POST', 'checkout/sessions', params);
      return Response.redirect(ses.url, 303);
    }
    if (url.pathname === '/packs' && req.method === 'GET') {
      let list = JSON.parse((await env.COINS.get('packcache:list')) || 'null');
      if (!list) {
        const rows = await odoo(env, 'product.product', 'search_read', [[['default_code', '=like', 'MD-BOLSA-%'], ['sale_ok', '=', true], ['is_published', '=', true]]], { fields: ['default_code', 'name', 'list_price'], order: 'list_price' });
        list = rows.map(r => ({ code: r.default_code, name: r.name, price: r.list_price, coins: parseInt(r.default_code.split('-')[2], 10) }));
        await env.COINS.put('packcache:list', JSON.stringify(list), { expirationTtl: 600 });
      }
      return json({ packs: list, ready: !!env.STRIPE_SECRET_KEY });
    }
    if (url.pathname === '/buy/status' && req.method === 'GET') {
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Esta app no está autorizada.' }, 403);
      const sid = String(url.searchParams.get('session') || '');
      if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sid)) return json({ error: 'Pago inválido' }, 400);
      try { const r = await processStripeSession(env, sid); const bag = r.code && JSON.parse((await env.COINS.get(`bag:${r.code}`)) || 'null');
        return json({ ...r, used: bag ? bag.used : false }); }
      catch (e) { return json({ ok: false, error: String(e.message || e) }, 502); }
    }
    if (url.pathname === '/stripe/webhook' && req.method === 'POST') {
      const body = await req.text();
      const secret = await env.COINS.get('stripe_whsec');
      if (!secret || !(await verifyStripeSignature(secret, req.headers.get('Stripe-Signature'), body))) return json({ error: 'Firma inválida' }, 400);
      const ev = JSON.parse(body);
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type)) ctx.waitUntil(processStripeSession(env, ev.data.object.id).catch(() => {}));
      return json({ received: true });
    }
    // Registra el aviso de Stripe hacia este Worker (una sola vez, administrador)
    if (url.pathname === '/admin/stripe/setup' && req.method === 'POST') {
      if (!env.ADMIN_KEY || req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return json({ error: 'No autorizado' }, 401);
      const wh = await stripe(env, 'POST', 'webhook_endpoints', { url: `${url.origin}/stripe/webhook`, 'enabled_events[0]': 'checkout.session.completed', 'enabled_events[1]': 'checkout.session.async_payment_succeeded', description: 'Music Dance Worker' });
      await env.COINS.put('stripe_whsec', wh.secret);
      return json({ ok: true, webhook: wh.id, livemode: wh.livemode });
    }

    // Aviso de Odoo: un pedido cambió a confirmado
    if (url.pathname === '/odoo/paid' && req.method === 'POST') {
      if (!env.ODOO_WEBHOOK_SECRET || url.searchParams.get('t') !== env.ODOO_WEBHOOK_SECRET) return json({ error: 'No autorizado' }, 401);
      const b = await req.json().catch(() => ({}));
      const orderId = parseInt(b._id || b.id, 10);
      if (!orderId) return json({ error: 'Falta el pedido' }, 400);
      // Responde de inmediato a Odoo y procesa en segundo plano (con reintentos)
      ctx.waitUntil(processPaidOrder(env, orderId).then(async (res) => {
        if (!res.ok) await env.COINS.put(`ordererr:${orderId}`, JSON.stringify({ when: new Date().toISOString(), ...res }), { expirationTtl: 60 * 60 * 24 * 30 });
      }).catch(async (e) => { await env.COINS.put(`ordererr:${orderId}`, JSON.stringify({ when: new Date().toISOString(), error: String(e) }), { expirationTtl: 60 * 60 * 24 * 30 }); }));
      return json({ ok: true, recibido: orderId });
    }
    // Reprocesar un pedido a mano (administrador), por ejemplo si el correo no salió
    if (url.pathname === '/odoo/process' && req.method === 'POST') {
      if (!env.ADMIN_KEY || req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) return json({ error: 'No autorizado' }, 401);
      const b = await req.json().catch(() => ({}));
      try { return json(await processPaidOrder(env, parseInt(b.orderId, 10))); }
      catch (e) { return json({ ok: false, error: String(e) }, 500); }
    }

    // ---- Mudanza de la app web de la dirección vieja a play.musicdance.app ----
    // Paquete temporal: datos del dispositivo (identificador, sesión) y canciones de la biblioteca.
    // Caduca en 24 h y se borra al terminar. Solo lo pueden usar la app vieja y la nueva.
    if (url.pathname.startsWith('/transfer/')) {
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Esta app no está autorizada.' }, 403);
      const parts = url.pathname.split('/').filter(Boolean); // transfer, token?, item?, i?
      const TTL = { expirationTtl: 60 * 60 * 24 };
      if (parts[1] === 'start' && req.method === 'POST') {
        if (!(await ipLimit(env, req, 'transfer', 20))) return json({ error: 'Demasiadas mudanzas desde esta conexión.' }, 429);
        const b = await req.json().catch(() => ({}));
        const token = randomId(24);
        const meta = { device: cleanUid(b.device), session: typeof b.session === 'string' ? b.session.slice(0, 128) : '', songs: Math.min(60, parseInt(b.songs || '0', 10) || 0), created: new Date().toISOString() };
        await env.COINS.put(`transfer:${token}:meta`, JSON.stringify(meta), TTL);
        return json({ ok: true, token });
      }
      const token = String(parts[1] || '').replace(/[^a-f0-9]/g, '');
      if (token.length !== 48) return json({ error: 'Mudanza inválida' }, 400);
      const meta = JSON.parse((await env.COINS.get(`transfer:${token}:meta`)) || 'null');
      if (!meta) return json({ error: 'La mudanza ya no existe o caducó.' }, 404);
      if (parts[2] === 'item') {
        const i = parseInt(parts[3], 10);
        if (!(i >= 0 && i < meta.songs)) return json({ error: 'Canción fuera de rango' }, 400);
        const k = `transfer:${token}:song:${i}`;
        if (req.method === 'PUT') {
          const body = await req.text();
          if (body.length > 20 * 1024 * 1024) return json({ error: 'Canción demasiado grande' }, 413);
          await env.COINS.put(k, body, TTL);
          return json({ ok: true });
        }
        const v = await env.COINS.get(k);
        return v ? new Response(v, { headers: { 'Content-Type': 'application/json', ...CORS } }) : json({ error: 'No encontrada' }, 404);
      }
      if (req.method === 'DELETE') {
        for (let i = 0; i < meta.songs; i++) await env.COINS.delete(`transfer:${token}:song:${i}`);
        await env.COINS.delete(`transfer:${token}:meta`);
        return json({ ok: true, borrada: true });
      }
      return json({ ok: true, ...meta });
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

      if (op === 'register') {
        if (!(await ipLimit(env, req, 'acctnew', 5))) return json({ error: 'Demasiadas cuentas nuevas desde esta conexión. Prueba en una hora.' }, 429);
        const email = normEmail(b.email), pw = String(b.password || '');
        if (!validEmail(email)) return json({ error: 'Escribe un correo válido.' }, 400);
        if (pw.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres.' }, 400);
        const ek = await emailKey(email);
        if (await env.COINS.get(ek)) return json({ error: 'Ya existe una cuenta con ese correo. Toca "Entrar".', exists: true }, 409);
        const acct = { id: randomId(12), created: new Date().toISOString(), sessions: [], devices: [], email, pw: await hashPassword(pw) };
        acct.codeKey = await familyKey(makeFamilyCode());   // código interno, ya no se muestra
        await env.COINS.put(acct.codeKey, acct.id);
        await env.COINS.put(ek, acct.id);
        const session = await newSession(env, acct, b.device);
        const moved = await mergeDeviceIntoAccount(env, b.device, `acct_${acct.id}`);
        return json({ ok: true, session, email, moved, wallet: await walletView(env, `acct_${acct.id}`, FREE) });
      }

      if (op === 'login') {
        if (!(await ipLimit(env, req, 'acctlogin', 15))) return json({ error: 'Demasiados intentos. Prueba en una hora.' }, 429);
        const email = normEmail(b.email);
        const id = await env.COINS.get(await emailKey(email));
        const acct = id && JSON.parse((await env.COINS.get(`acct:${id}`)) || 'null');
        const ok = acct && acct.pw && (await hashPassword(String(b.password || ''), acct.pw.salt)).hash === acct.pw.hash;
        if (!ok) return json({ error: 'Correo o contraseña incorrectos.' }, 401);
        const session = await newSession(env, acct, b.device);
        const moved = await mergeDeviceIntoAccount(env, b.device, `acct_${acct.id}`);
        return json({ ok: true, session, email: acct.email, moved, wallet: await walletView(env, `acct_${acct.id}`, FREE) });
      }

      if (op === 'forgot') {
        // Siempre responde igual, exista o no la cuenta, para no revelar qué correos están registrados
        if (!(await ipLimit(env, req, 'acctforgot', 5))) return json({ error: 'Demasiados intentos. Prueba en una hora.' }, 429);
        const email = normEmail(b.email);
        const id = validEmail(email) && await env.COINS.get(await emailKey(email));
        if (id) {
          const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
          await env.COINS.put(`reset:${id}`, JSON.stringify({ code, tries: 0 }), { expirationTtl: 60 * 30 });
          ctx.waitUntil(sendMail(env, email, 'Tu código para cambiar la contraseña de Music Dance',
            `<p>Tu código para cambiar la contraseña de Music Dance es:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>Vence en 30 minutos. Si no lo pediste, ignora este correo.</p>`).catch(() => {}));
        }
        return json({ ok: true });
      }

      if (op === 'reset') {
        if (!(await ipLimit(env, req, 'acctreset', 10))) return json({ error: 'Demasiados intentos. Prueba en una hora.' }, 429);
        const email = normEmail(b.email), pw = String(b.password || '');
        if (pw.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres.' }, 400);
        const id = await env.COINS.get(await emailKey(email));
        const rk = id && `reset:${id}`;
        const r = rk && JSON.parse((await env.COINS.get(rk)) || 'null');
        if (!r) return json({ error: 'El código venció o no es válido. Pide uno nuevo.' }, 400);
        if (String(b.code || '').trim() !== r.code) {
          r.tries++; if (r.tries >= 5) await env.COINS.delete(rk); else await env.COINS.put(rk, JSON.stringify(r), { expirationTtl: 60 * 30 });
          return json({ error: 'Código incorrecto.' }, 400);
        }
        await env.COINS.delete(rk);
        const acct = JSON.parse(await env.COINS.get(`acct:${id}`));
        acct.pw = await hashPassword(pw);
        const session = await newSession(env, acct, b.device);
        return json({ ok: true, session, email: acct.email, wallet: await walletView(env, `acct_${acct.id}`, FREE) });
      }

      const acct = await sessionAccount(env, b.session);
      if (!acct) return json({ error: 'Tu sesión terminó. Vuelve a entrar con tu correo.', noSession: true }, 401);

      if (op === 'set-email') {
        // Cuentas antiguas (con código familiar) agregan correo y contraseña
        const email = normEmail(b.email), pw = String(b.password || '');
        if (!validEmail(email)) return json({ error: 'Escribe un correo válido.' }, 400);
        if (pw.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres.' }, 400);
        const ek = await emailKey(email);
        const owner = await env.COINS.get(ek);
        if (owner && owner !== acct.id) return json({ error: 'Ese correo ya tiene otra cuenta.' }, 409);
        if (acct.email && acct.email !== email) await env.COINS.delete(await emailKey(acct.email));
        acct.email = email; acct.pw = await hashPassword(pw);
        await env.COINS.put(ek, acct.id);
        await env.COINS.put(`acct:${acct.id}`, JSON.stringify(acct));
        return json({ ok: true, email });
      }

      if (op === 'me') {
        return json({ ok: true, created: acct.created, email: acct.email || null, devices: (acct.devices || []).length, wallet: await walletView(env, `acct_${acct.id}`, FREE) });
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
        if (acct.email) await env.COINS.delete(await emailKey(acct.email));
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
      // Bolsa de canciones comprada: un solo uso, suma monedas compradas
      const bag = JSON.parse((await env.COINS.get(`bag:${code}`)) || 'null');
      if (bag) {
        if (!uid.startsWith('acct_')) return json({ error: 'Primero crea tu cuenta familiar (arriba, es gratis) para no perder tus canciones si borras la app.', needAccount: true }, 409);
        if (bag.used) return json({ error: bag.usedBy === uid ? 'Ya canjeaste este código.' : 'Este código ya se canjeó.' }, 410);
        bag.used = true; bag.usedBy = uid; bag.usedAt = new Date().toISOString();
        await env.COINS.put(`bag:${code}`, JSON.stringify(bag));
        const w = await getWallet(env, uid);
        w.paid += bag.coins;
        w.log.push({ t: new Date().toISOString(), delta: bag.coins, why: `bolsa ${bag.order}`, ref: code });
        await saveWallet(env, uid, w);
        return json({ ok: true, bag: bag.coins, ...(await walletView(env, uid, FREE)) });
      }
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
        await env.COINS.put('lasterror', JSON.stringify({ when: new Date().toISOString(), status: r.status, detail: txt.slice(0, 800), lines: plan.chunks.map(c => c.text) }), { expirationTtl: 60 * 60 * 24 * 7 }); // la letra de un niño no se guarda más de 7 días
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
