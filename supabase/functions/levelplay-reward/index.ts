// LevelPlay's server-to-server rewarded callback (ads slice 2, DECISIONS 86, docs/ads.md).
//
// LOCAL STAND-IN: the live project allows no new edge functions, so the live
// callback is the website route /api/public/levelplay-reward
// (src/routes/api/public/levelplay-reward.ts in the ZeroChill.com project),
// which Lovable built to the same behaviour. Never deployed; tests/db.mjs uses it.
//
// LevelPlay calls this URL once a rewarded video has been watched, and retries
// until the response contains "<eventId>:OK". The user id it carries is our
// reward ticket (start_avalanche_ad_reward): after a real video it arrives as
// dynamicUserId with userId empty; the dashboard's test puts it in userId. A callback is trusted only if its
// MD5 signature matches AR_LEVELPLAY_PRIVATE_KEY, the private key set in the
// LevelPlay dashboard; without that secret nothing is credited.
//
// Served with JWT verification off (supabase/config.toml): LevelPlay sends no Supabase token.
import { createHash, timingSafeEqual } from 'node:crypto';

const PRIVATE_KEY = Deno.env.get('AR_LEVELPLAY_PRIVATE_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// LevelPlay's docs and samples disagree on some parameter names, so accept each spelling.
const param = (q: URLSearchParams, ...names: string[]) => {
  for (const n of names) {
    const v = q.get(n);
    if (v !== null) return v;
  }
  return '';
};

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  const appUser = param(q, 'userId', 'userid', 'applicationUserId', 'appUserId');
  const ticket = param(q, 'dynamicUserId') || appUser;
  const eventId = param(q, 'eventId', 'eventID', 'eventid');
  const rewards = param(q, 'rewards');
  const timestamp = param(q, 'timestamp');
  const signature = param(q, 'signature').toLowerCase();

  // Not acknowledged, so LevelPlay keeps retrying until the secret is set.
  if (!PRIVATE_KEY) return new Response('not configured', { status: 503 });
  if (!ticket || !eventId || !timestamp || !signature) return new Response('missing parameters', { status: 400 });
  // The user id is hashed URL-decoded, which URLSearchParams already did. Which
  // id LevelPlay signs when the ticket rides in dynamicUserId isn't documented,
  // so either the plain userId (often empty) or the ticket may be the signed one.
  const sign = (u: string) => createHash('md5').update(timestamp + eventId + u + rewards + PRIVATE_KEY).digest('hex');
  if (!same(sign(appUser), signature) && !same(sign(ticket), signature)) return new Response('bad signature', { status: 403 });

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/avalanche_ad_reward_callback', {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_ticket: ticket, p_event_id: eventId, p_ip: ip }),
  });
  // A database error is not acknowledged, so LevelPlay tries again later.
  if (!res.ok) {
    console.error('levelplay-reward', eventId, res.status, await res.text());
    return new Response('error', { status: 500 });
  }
  const out = await res.json();
  console.log('levelplay-reward', eventId, out.status);
  return new Response(eventId + ':OK', { status: 200 });
});
