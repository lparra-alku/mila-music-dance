/**
 * Mila Music Dance — intermediario gratuito (Cloudflare Worker)
 * Guarda la llave de ElevenLabs, limita el uso y devuelve el MP3.
 *
 * Rutas:
 *   GET  /coins?device=ID          -> { coins, dailyLimit, monthLeft }
 *   POST /song  { device, lyrics, style, bpm, seconds, pin? } -> audio/mpeg
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Expose-Headers': 'X-Coins, X-Month-Left',
};

const STYLE_PROMPTS = {
  pop:    ['upbeat kids pop', 'bright synths', 'catchy chorus', 'happy'],
  reg:    ['kids reggaeton', 'dembow beat', 'playful', 'latin'],
  rock:   ['fun kids rock', 'electric guitar', 'energetic', 'clean'],
  cumbia: ['cumbia infantil', 'accordion', 'festive', 'latin'],
  sueño:  ['gentle lullaby pop', 'soft piano', 'dreamy', 'warm'],
};

const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);

async function counter(env, key) { return parseInt((await env.COINS.get(key)) || '0', 10); }
async function bump(env, key, by, ttl) { await env.COINS.put(key, String((await counter(env, key)) + by), { expirationTtl: ttl }); }

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
}

function buildPlan(lyrics, style, bpm, seconds) {
  const lines = lyrics.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 24);
  const styles = STYLE_PROMPTS[style] || STYLE_PROMPTS.pop;
  const base = [...styles, `${bpm} bpm`, 'child-friendly', 'clear vocals', 'spanish lyrics', 'kid singer', 'great production quality'];
  const negative = ['explicit', 'dark', 'aggressive', 'sad'];
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
      positive_styles: i === 0 ? base : [...styles.slice(0, 2), 'catchy', 'bigger drums'],
      negative_styles: negative,
    })),
  };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const DAILY = parseInt(env.DAILY_PER_DEVICE || '2', 10);
    const MONTH_CREDITS = parseInt(env.MONTHLY_CREDITS || '9000', 10);
    const CREDITS_PER_SEC = 15; // 900 créditos por minuto en ElevenLabs

    if (url.pathname === '/coins') {
      const device = url.searchParams.get('device') || 'anon';
      const used = await counter(env, `dev:${device}:${today()}`);
      const usedMonth = await counter(env, `global:${month()}`);
      return json({ coins: Math.max(0, DAILY - used), dailyLimit: DAILY, monthLeft: Math.max(0, MONTH_CREDITS - usedMonth) });
    }

    if (url.pathname === '/song' && req.method === 'POST') {
      let body; try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
      const device = String(body.device || 'anon').slice(0, 64);
      const lyrics = String(body.lyrics || '').slice(0, 2000);
      const style = String(body.style || 'pop');
      const bpm = Math.min(160, Math.max(70, parseInt(body.bpm || '110', 10)));
      const seconds = Math.min(60, Math.max(20, parseInt(body.seconds || '30', 10)));
      if (!lyrics.trim()) return json({ error: 'Falta la letra' }, 400);

      // Filtro básico de palabras (ampliar según necesidad)
      const banned = /\b(mierda|puta|puto|idiota|estúpid[oa]|matar|sangre)\b/i;
      if (banned.test(lyrics)) return json({ error: 'Esa palabra no va en la canción 🙈' }, 422);

      const cost = seconds * CREDITS_PER_SEC;
      const devKey = `dev:${device}:${today()}`, monthKey = `global:${month()}`;
      const usedToday = await counter(env, devKey);
      const usedMonth = await counter(env, monthKey);
      const parentOk = env.PARENT_PIN && body.pin === env.PARENT_PIN;

      if (usedMonth + cost > MONTH_CREDITS) return json({ error: 'Se acabaron las canciones de este mes 😴' }, 429);
      if (!parentOk && usedToday >= DAILY) return json({ error: 'Ya usaste tus monedas de hoy. Pide el PIN a un adulto 🔐', needPin: true }, 429);

      const plan = buildPlan(lyrics, style, bpm, seconds);
      const r = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ composition_plan: plan, model_id: 'music_v2_5' }),
      });
      if (!r.ok) {
        const txt = await r.text();
        return json({ error: 'ElevenLabs no respondió bien', detail: txt.slice(0, 500) }, 502);
      }
      // Cobra solo si salió bien
      if (!parentOk) await bump(env, devKey, 1, 60 * 60 * 48);
      await bump(env, monthKey, cost, 60 * 60 * 24 * 40);
      const coins = Math.max(0, DAILY - (parentOk ? usedToday : usedToday + 1));
      return new Response(r.body, { headers: { 'Content-Type': 'audio/mpeg', ...CORS, 'X-Coins': String(coins), 'X-Month-Left': String(MONTH_CREDITS - usedMonth - cost) } });
    }
    return json({ ok: true, app: 'Mila Music Dance' });
  },
};
