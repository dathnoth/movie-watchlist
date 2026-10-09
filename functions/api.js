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

// Returns OMDB-shaped results so the client renderer is unchanged.
async function searchTmdb(query, key) {
  const res = await tmdbFetch('search/multi', {
    query,
    include_adult: 'false',
    language: 'en-GB',
  }, key);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { results = [] } = await res.json();

  const items = results
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .slice(0, 12);

  const mapped = await Promise.all(items.map(async (r) => {
    try {
      const ext = await tmdbFetch(`${r.media_type}/${r.id}/external_ids`, {}, key);
      if (!ext.ok) return null;
      const { imdb_id } = await ext.json();
      if (!imdb_id) return null;
      const date = r.release_date || r.first_air_date || '';
      return {
        imdbID: imdb_id,
        Title: r.title || r.name,
        Year: date.slice(0, 4),
        Poster: r.poster_path
          ? `https://image.tmdb.org/t/p/w342${r.poster_path}`
          : 'N/A',
        Type: r.media_type === 'tv' ? 'series' : 'movie',
      };
    } catch {
      return null;
    }
  }));

  return mapped.filter(Boolean);
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
  // The full movie record (rather than just external_ids) is one request
  // either way and also carries runtime and genres, which the filters need.
  const detailed = await Promise.all(
    results.slice(0, FRESH_LIMIT).map(async (m) => {
      try {
        const r = await tmdbFetch(`movie/${m.id}`, {
          append_to_response: 'external_ids',
          language: 'en-GB',
        }, key);
        if (!r.ok) return null;
        const full = await r.json();
        const imdb_id = full.imdb_id || full.external_ids?.imdb_id;
        if (!imdb_id) return null;
        return {
          imdb_id,
          title: m.title,
          year: (m.release_date || '').slice(0, 4),
          rating: m.vote_average ? m.vote_average.toFixed(1) : null,
          runtime: full.runtime || null,
          genres: (full.genres || []).map((g) => g.name),
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

  // Search runs through TMDB: OMDB only matches from the start of a word, so
  // "matr" or "unner" return nothing. Falls back to OMDB if TMDB is
  // unavailable. The response keeps OMDB's shape either way.
  if (type === 'search') {
    const q = searchParams.get('q') || '';
    const tmdbKey = env.TMDB_API_KEY ? normaliseKey(env.TMDB_API_KEY) : '';
    if (tmdbKey) {
      try {
        return json({ Search: await searchTmdb(q, tmdbKey) });
      } catch (err) {
        console.log(`TMDB search failed, falling back to OMDB: ${err.message}`);
      }
    }
    const res = await fetch(
      `https://www.omdbapi.com/?s=${encodeURIComponent(q)}&apikey=${env.OMDB_API_KEY}`
    );
    return json(await res.json());
  }

  if (type === 'detail') {
    const res = await fetch(
      `https://www.omdbapi.com/?i=${encodeURIComponent(searchParams.get('id'))}&apikey=${env.OMDB_API_KEY}&plot=short`
    );
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
      // Adding straight to Watched (seen it at the cinema) dates it today.
      // Existing rows keep theirs: the conflict branch never touches it.
      if (f === 'watched_at') return body.status === 'archive' ? new Date().toISOString().split('T')[0] : null;
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
