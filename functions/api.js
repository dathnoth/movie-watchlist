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

async function searchTitles(q, env) {
  const tmdbKey = env.TMDB_API_KEY ? normaliseKey(env.TMDB_API_KEY) : '';
  if (tmdbKey) {
    try {
      return { Search: await searchTmdb(q, tmdbKey) };
    } catch (err) {
      console.log(`TMDB search failed, falling back to OMDB: ${err.message}`);
    }
  }
  const res = await fetch(
    `https://www.omdbapi.com/?s=${encodeURIComponent(q)}&apikey=${env.OMDB_API_KEY}`
  );
  return res.json();
}

async function fetchDetail(id, env) {
  const res = await fetch(
    `https://www.omdbapi.com/?i=${encodeURIComponent(id)}&apikey=${env.OMDB_API_KEY}&plot=short`
  );
  return res.json();
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// ── Bot API ─────────────────────────────────────────────────────────────────
// For Dodo (or any chat bot): read the library and add, move or remove films
// by title. Authenticated with a long `DODO_API_KEY` bearer token rather than
// the 4-digit PIN. Speaks "watched" rather than the stored 'archive'.

const BOT_STATUS_IN = { get: 'get', got: 'got', watched: 'archive', archive: 'archive' };
const BOT_STATUS_OUT = { get: 'get', got: 'got', archive: 'watched' };

function botMovie(m) {
  return {
    imdb_id: m.imdb_id,
    title: m.title,
    year: (String(m.year || '').match(/\d{4}/) || [null])[0],
    status: BOT_STATUS_OUT[m.status],
    rating: m.rating && m.rating !== 'N/A' ? m.rating : null,
    runtime: m.runtime && m.runtime !== 'N/A' ? m.runtime : null,
    genre: m.genre && m.genre !== 'N/A' ? m.genre : null,
    is_tv_show: !!m.is_tv_show,
    watched_at: m.watched_at || null,
    quality: m.quality_score ?? null,
    file: parseFileInfo(m.file_info)?.summary || null,
  };
}

function parseFileInfo(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Adds the file details columns (migration 0004) if the database doesn't have
// them yet, and records the migration so `wrangler d1 migrations apply` skips
// it. This lets the drive scan start without a manual migration. Checked once
// per isolate.
let fileColumnsReady = false;
async function ensureFileColumns(env) {
  if (fileColumnsReady) return;
  const { results } = await env.DB.prepare('PRAGMA table_info(movies)').all();
  if (!results.some((c) => c.name === 'file_info')) {
    await env.DB.batch([
      env.DB.prepare('ALTER TABLE movies ADD COLUMN file_info TEXT'),
      env.DB.prepare('ALTER TABLE movies ADD COLUMN quality_score INTEGER'),
    ]);
    const tracked = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").first();
    if (tracked) await env.DB.prepare('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)').bind('0004_file_details.sql').run();
  }
  fileColumnsReady = true;
}

// File details from Dodo's scan of the drive: one entry per film file, keyed
// by imdb_id. With `replace`, films missing from the list lose their details
// (the file has left the drive). One batch, so it applies all or nothing.
async function saveFileDetails(env, files, replace) {
  if (!Array.isArray(files) || files.length > 2000) return json({ error: 'files must be an array' }, 400);
  const valid = files.filter((f) => /^tt\d+$/.test(f?.imdb_id || '')
    && Number.isInteger(f.score) && f.score >= 0 && f.score <= 100
    && f.info && typeof f.info === 'object');
  if (valid.length !== files.length) return json({ error: 'each file needs imdb_id, score (0–100) and info' }, 400);
  await ensureFileColumns(env);

  const update = env.DB.prepare('UPDATE movies SET file_info = ?, quality_score = ? WHERE imdb_id = ?');
  const statements = valid.map((f) => update.bind(JSON.stringify(f.info).slice(0, 20000), f.score, f.imdb_id));
  if (replace) statements.unshift(env.DB.prepare('UPDATE movies SET file_info = NULL, quality_score = NULL WHERE file_info IS NOT NULL'));
  const results = statements.length ? await env.DB.batch(statements) : [];
  const updates = replace ? results.slice(1) : results;
  const unknown = valid.filter((_, i) => !updates[i]?.meta?.changes).map((f) => f.imdb_id);
  return json({ ok: true, updated: valid.length - unknown.length, unknown });
}

// Finds a film already in the library: by imdb_id, else an exact title
// (optionally narrowed by year), else a partial title. More than one hit is
// returned as-is so the caller can ask which was meant.
async function findInLibrary(env, { imdb_id, title, year }) {
  if (imdb_id) {
    const row = await env.DB.prepare('SELECT * FROM movies WHERE imdb_id = ?').bind(imdb_id).first();
    return row ? [row] : [];
  }
  const needle = String(title || '').trim();
  if (!needle) return [];
  const byYear = (rows) => (year ? rows.filter((m) => String(m.year || '').includes(String(year))) : rows);

  const { results: exact } = await env.DB.prepare(
    'SELECT * FROM movies WHERE title = ? COLLATE NOCASE ORDER BY title COLLATE NOCASE'
  ).bind(needle).all();
  if (byYear(exact).length) return byYear(exact);

  const { results: partial } = await env.DB.prepare(
    "SELECT * FROM movies WHERE title LIKE ? ESCAPE '\\' ORDER BY title COLLATE NOCASE"
  ).bind(`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`).all();
  return byYear(partial);
}

// Picks the best search hit for a title: an exact title match (and year, when
// given) wins, otherwise the top result.
function pickResult(results, title, year) {
  const t = String(title).trim().toLowerCase();
  const y = year ? String(year) : null;
  return results.find((r) => r.Title.toLowerCase() === t && (!y || r.Year.startsWith(y)))
    || (y && results.find((r) => r.Year.startsWith(y)))
    || results.find((r) => r.Title.toLowerCase() === t)
    || results[0];
}

async function handleBot(request, env, searchParams) {
  const botKey = typeof env.DODO_API_KEY === 'string' ? env.DODO_API_KEY.trim() : '';
  const given = normaliseKey(request.headers.get('authorization') || '');
  if (!botKey) return json({ error: 'DODO_API_KEY is not configured' }, 500);
  if (given !== botKey) return json({ error: 'unauthorized' }, 401);

  if (request.method === 'GET') {
    const filter = searchParams.get('status');
    const status = filter ? BOT_STATUS_IN[filter.toLowerCase()] : null;
    if (filter && !status) return json({ error: 'status must be get, got or watched' }, 400);

    const { results } = status
      ? await env.DB.prepare('SELECT * FROM movies WHERE status = ? ORDER BY title COLLATE NOCASE').bind(status).all()
      : await env.DB.prepare('SELECT * FROM movies ORDER BY title COLLATE NOCASE').all();
    const movies = results.map(botMovie);
    const counts = { get: 0, got: 0, watched: 0 };
    for (const m of movies) counts[m.status]++;
    return json({ count: movies.length, counts: status ? undefined : counts, movies });
  }

  if (request.method !== 'POST') return json({ error: 'use GET or POST' }, 405);

  const body = await request.json().catch(() => ({}));
  const { action, imdb_id, title, year } = body;
  if (action === 'files') return saveFileDetails(env, body.files, !!body.replace);
  const status = body.status ? BOT_STATUS_IN[String(body.status).toLowerCase()] : null;
  if (body.status && !status) return json({ error: 'status must be get, got or watched' }, 400);
  if (!imdb_id && !title) return json({ error: 'title or imdb_id required' }, 400);

  if (action === 'add') {
    const target = status || 'get';
    let id = imdb_id;
    let alternatives = [];
    if (!id) {
      const { Search: results = [] } = await searchTitles(String(title), env);
      if (!results.length) return json({ error: `no film found for "${title}"` }, 404);
      const pick = pickResult(results, title, year);
      id = pick.imdbID;
      alternatives = results
        .filter((r) => r.imdbID !== id)
        .slice(0, 4)
        .map((r) => ({ imdb_id: r.imdbID, title: r.Title, year: r.Year || null }));
    }

    const existing = await env.DB.prepare('SELECT * FROM movies WHERE imdb_id = ?').bind(id).first();
    if (existing) {
      if (existing.status !== target) {
        await env.DB.prepare('UPDATE movies SET status = ?, watched_at = ? WHERE imdb_id = ?')
          .bind(target, target === 'archive' ? todayISO() : null, id).run();
      }
      const row = await env.DB.prepare('SELECT * FROM movies WHERE imdb_id = ?').bind(id).first();
      return json({
        ok: true,
        result: existing.status === target ? 'already_there' : 'moved',
        from: BOT_STATUS_OUT[existing.status],
        movie: botMovie(row),
        alternatives,
      });
    }

    const d = await fetchDetail(id, env);
    if (d.Response === 'False' || !d.Title) return json({ error: `no details found for ${id}` }, 404);
    const movie = {
      imdb_id: d.imdbID,
      title: d.Title,
      poster: d.Poster,
      status: target,
      year: d.Released && d.Released !== 'N/A' ? d.Released : d.Year,
      runtime: d.Runtime,
      rating: d.imdbRating,
      genre: d.Genre,
      is_tv_show: d.Type === 'series' ? 1 : 0,
      watched_at: target === 'archive' ? todayISO() : null,
    };
    const cols = Object.keys(movie);
    await env.DB.prepare(
      `INSERT INTO movies (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).bind(...Object.values(movie)).run();

    return json({ ok: true, result: 'added', movie: botMovie(movie), alternatives });
  }

  if (action === 'move' || action === 'remove') {
    if (action === 'move' && !status) return json({ error: 'status required: get, got or watched' }, 400);
    const matches = await findInLibrary(env, { imdb_id, title, year });
    if (!matches.length) return json({ error: `"${title || imdb_id}" is not in the library` }, 404);
    if (matches.length > 1) {
      return json({ error: 'more than one film matches; retry with imdb_id', matches: matches.map(botMovie) }, 409);
    }
    const [m] = matches;

    if (action === 'remove') {
      await env.DB.prepare('DELETE FROM movies WHERE imdb_id = ?').bind(m.imdb_id).run();
      return json({ ok: true, result: 'removed', movie: botMovie(m) });
    }

    if (m.status !== status) {
      await env.DB.prepare('UPDATE movies SET status = ?, watched_at = ? WHERE imdb_id = ?')
        .bind(status, status === 'archive' ? todayISO() : null, m.imdb_id).run();
    }
    return json({
      ok: true,
      result: m.status === status ? 'already_there' : 'moved',
      from: BOT_STATUS_OUT[m.status],
      movie: m.status === status
        ? botMovie(m)
        : botMovie({ ...m, status, watched_at: status === 'archive' ? todayISO() : null }),
    });
  }

  return json({ error: 'action must be add, move, remove or files' }, 400);
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
    return json(await searchTitles(searchParams.get('q') || '', env));
  }

  if (type === 'detail') {
    return json(await fetchDetail(searchParams.get('id'), env));
  }

  // The bot API carries its own credential, so it is handled before the PIN
  // gate below.
  if (type === 'bot') return handleBot(request, env, searchParams);

  if (!expectedPin || request.headers.get('x-vault-pin') !== expectedPin) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (type === 'list') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM movies ORDER BY title COLLATE NOCASE'
    ).all();
    return json(results.map((m) => ({ ...m, is_tv_show: !!m.is_tv_show, file_info: parseFileInfo(m.file_info) })));
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
