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

export async function onRequest(context) {
  const { request, env } = context;
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');

  if (type === 'auth') {
    const { pin } = await request.json();
    return pin === env.VAULT_PIN ? json({ ok: true }) : json({ ok: false }, 401);
  }

  if (type === 'search' || type === 'detail') {
    const key = env.OMDB_API_KEY;
    const url = type === 'search'
      ? `https://www.omdbapi.com/?s=${encodeURIComponent(searchParams.get('q'))}&apikey=${key}`
      : `https://www.omdbapi.com/?i=${encodeURIComponent(searchParams.get('id'))}&apikey=${key}&plot=short`;
    const res = await fetch(url);
    return json(await res.json());
  }

  if (request.headers.get('x-vault-pin') !== env.VAULT_PIN) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (type === 'list') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM movies ORDER BY title COLLATE NOCASE'
    ).all();
    return json(results.map((m) => ({ ...m, is_tv_show: !!m.is_tv_show })));
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
