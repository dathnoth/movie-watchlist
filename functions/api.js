const JSON_HEADERS = { 'Content-Type': 'application/json' };

const STATUSES = ['get', 'got', 'archive'];

const FIELDS = [
  'imdb_id', 'title', 'poster', 'status', 'year', 'runtime', 'rating',
  'genre', 'plot', 'director', 'actors', 'trailer', 'votes', 'my_stars',
  'is_tv_show', 'watched_at',
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Fresh finds: recent, well-rated films that have left their theatrical window.
const FRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FRESH_WINDOW_DAYS = 90;
const FRESH_REGION = 'GB';
const FRESH_LIMIT = 20;

function daysAgoISO(days) {
  return new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
}

// Tolerate the usual paste damage: surrounding whitespace or a trailing
// newline, and a "Bearer " prefix copied along with the token.
function normaliseKey(raw) {
  return String(raw).trim().replace(/^Bearer\s+/i, '').trim();
}

// TMDB issues two credential types: a v3 API key (query param) and a v4 read
// access token (bearer, a JWT). Accept either so it works with whichever the
// dashboard hands out.
function tmdbFetch(path, params, key) {
  const url = new URL(`https://api.themoviedb.org/3/${path}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const headers = { Accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  return fetch(url, { headers });
}

async function fetchFreshFromTmdb(key) {
  // release_type 4|5|6 = digital | physical | TV, i.e. past the theatrical
  // window. Paired with region so the dates are that region's releases.
  const res = await tmdbFetch('discover/movie', {
    region: FRESH_REGION,
    language: 'en-GB',
    sort_by: 'vote_average.desc',
    with_release_type: '4|5|6',
    'release_date.gte': daysAgoISO(FRESH_WINDOW_DAYS),
    'release_date.lte': daysAgoISO(0),
    'vote_count.gte': '50',
    'vote_average.gte': '6',
    include_adult: 'false',
  }, key);
  if (!res.ok) {
    // Logged (never the key itself) so `wrangler pages deployment tail` can
    // tell a rejected credential from a malformed query.
    const body = await res.text().catch(() => '');
    console.log(`TMDB discover failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    throw new Error(`TMDB discover failed: ${res.status}`);
  }
  const { results = [] } = await res.json();

  // discover returns TMDB ids; this library is keyed on imdb_id, so resolve
  // each one. Films without an IMDb id are dropped rather than guessed at.
  const detailed = await Promise.all(
    results.slice(0, FRESH_LIMIT).map(async (m) => {
      try {
        const r = await tmdbFetch(`movie/${m.id}/external_ids`, {}, key);
        if (!r.ok) return null;
        const { imdb_id } = await r.json();
        if (!imdb_id) return null;
        return {
          imdb_id,
          title: m.title,
          year: (m.release_date || '').slice(0, 4),
          rating: m.vote_average ? m.vote_average.toFixed(1) : null,
          poster: m.poster_path
            ? `https://image.tmdb.org/t/p/w342${m.poster_path}`
            : null,
        };
      } catch {
        return null;
      }
    })
  );

  return detailed.filter(Boolean);
}

async function getFresh(env) {
  const key = env.TMDB_API_KEY ? normaliseKey(env.TMDB_API_KEY) : '';
  if (!key) {
    console.log('TMDB_API_KEY is missing or empty on this deployment');
    return { error: 'TMDB_API_KEY is not configured' };
  }
  // Shape only, never the value: 32 hex chars = v3 key, eyJ… = v4 token.
  console.log(`TMDB key present: length=${key.length} looksLikeV4=${key.startsWith('eyJ')}`);

  const cached = await env.DB.prepare(
    'SELECT payload, fetched_at FROM fresh_cache WHERE id = ?'
  ).bind('discover').first();

  const isStale = !cached || Date.now() - Date.parse(cached.fetched_at) > FRESH_TTL_MS;

  let films;
  if (isStale) {
    try {
      films = await fetchFreshFromTmdb(key);
      await env.DB.prepare(
        `INSERT INTO fresh_cache (id, payload, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
      ).bind('discover', JSON.stringify(films), new Date().toISOString()).run();
    } catch (err) {
      // Serve a stale cache rather than an empty page if TMDB is unreachable.
      if (!cached) return { error: String(err.message || err) };
      films = JSON.parse(cached.payload);
    }
  } else {
    films = JSON.parse(cached.payload);
  }

  // Filtered per request, not at cache time, so it stays correct as the
  // library grows between refreshes.
  const { results: owned } = await env.DB.prepare('SELECT imdb_id FROM movies').all();
  const have = new Set(owned.map((r) => r.imdb_id));
  return { films: films.filter((f) => !have.has(f.imdb_id)) };
}

export async function onRequest(context) {
  const { request, env } = context;
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');

  // Fail closed: an unset VAULT_PIN must never authenticate anyone.
  const expectedPin = typeof env.VAULT_PIN === 'string' && env.VAULT_PIN.length > 0
    ? env.VAULT_PIN
    : null;

  if (type === 'auth') {
    if (!expectedPin) return json({ error: 'VAULT_PIN is not configured' }, 500);
    const { pin } = await request.json().catch(() => ({}));
    return typeof pin === 'string' && pin === expectedPin
      ? json({ ok: true })
      : json({ ok: false }, 401);
  }

  if (type === 'search' || type === 'detail') {
    const key = env.OMDB_API_KEY;
    const url = type === 'search'
      ? `https://www.omdbapi.com/?s=${encodeURIComponent(searchParams.get('q'))}&apikey=${key}`
      : `https://www.omdbapi.com/?i=${encodeURIComponent(searchParams.get('id'))}&apikey=${key}&plot=short`;
    const res = await fetch(url);
    return json(await res.json());
  }

  if (!expectedPin || request.headers.get('x-vault-pin') !== expectedPin) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (type === 'list') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM movies ORDER BY title COLLATE NOCASE'
    ).all();
    return json(results.map((m) => ({ ...m, is_tv_show: !!m.is_tv_show })));
  }

  if (type === 'fresh') {
    const result = await getFresh(env);
    return result.error ? json(result, 503) : json(result.films);
  }

  if (type === 'upsert' && request.method === 'POST') {
    const body = await request.json();
    if (!body.imdb_id || !body.title) return json({ error: 'imdb_id and title required' }, 400);

    const row = FIELDS.map((f) => {
      const v = body[f];
      if (f === 'is_tv_show') return v ? 1 : 0;
      if (f === 'status') return STATUSES.includes(v) ? v : 'get';
      return v ?? null;
    });

    await env.DB.prepare(
      `INSERT INTO movies (${FIELDS.join(', ')})
       VALUES (${FIELDS.map(() => '?').join(', ')})
       ON CONFLICT(imdb_id) DO UPDATE SET
         title = excluded.title,
         poster = excluded.poster,
         year = excluded.year,
         runtime = excluded.runtime,
         rating = excluded.rating,
         genre = excluded.genre,
         is_tv_show = excluded.is_tv_show`
    ).bind(...row).run();

    return json({ ok: true });
  }

  if (type === 'status' && request.method === 'POST') {
    const { imdb_id, status } = await request.json();
    if (!STATUSES.includes(status)) return json({ error: 'invalid status' }, 400);

    const watchedAt = status === 'archive' ? new Date().toISOString().split('T')[0] : null;
    await env.DB.prepare('UPDATE movies SET status = ?, watched_at = ? WHERE imdb_id = ?')
      .bind(status, watchedAt, imdb_id)
      .run();

    return json({ ok: true });
  }

  if (type === 'delete' && request.method === 'POST') {
    const { imdb_id } = await request.json();
    await env.DB.prepare('DELETE FROM movies WHERE imdb_id = ?').bind(imdb_id).run();
    return json({ ok: true });
  }

  return json({ error: 'unknown request' }, 400);
}
