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
async function walletView(env, uid, FREE) {
  const usedFree = await counter(env, `dev:${uid}:${today()}`);
  const w = await getWallet(env, uid);
  const free = Math.max(0, FREE - usedFree);
  return { free, freeMax: FREE, paid: w.paid, total: free + w.paid };
}
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
      return json(await walletView(env, cleanUid(url.searchParams.get('uid')), FREE));
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
      const uid = cleanUid(b0.device);
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
