# MovieVault — CLAUDE.md

Personal movie library PWA for Daniel. Deployed via Cloudflare Pages.

## Stack

- **Frontend**: Vanilla HTML/CSS/JS — single `index.html`, `style.css`, `app.js`. No build step, no dependencies.
- **Database**: Cloudflare D1 (SQLite), database name `movievault`, bound as `env.DB`
- **API**: Cloudflare Pages Function at `functions/api.js` — owns all DB access, PIN auth, and the OMDB proxy
- **Deployment**: Push to `main` on GitHub (`dathnoth/movie-watchlist`) → auto-deploys via Cloudflare Pages

## Database

Two tables. `movies` is the library — schema in `migrations/0001_init.sql`, with `migrations/0002_seed.sql` the one-time import of the 55 rows migrated off Supabase. `fresh_cache` (`migrations/0003_fresh_cache.sql`) holds the cached TMDB "fresh finds" payload.

| Column | Type | Notes |
|---|---|---|
| `imdb_id` | TEXT (PK) | |
| `title` | TEXT | |
| `poster` | TEXT | |
| `status` | TEXT | `'get'`, `'got'`, or `'archive'` — CHECK constrained |
| `year` | TEXT | OMDB `Released`, format varies ("2025" or "15 Aug 1979") |
| `runtime` | TEXT | e.g. "147 min" |
| `rating` | TEXT | IMDb rating |
| `genre` | TEXT | |
| `plot`, `director`, `actors`, `trailer` | TEXT | mostly unused — modal reads these live from OMDB |
| `votes`, `my_stars` | INTEGER | |
| `is_tv_show` | INTEGER | 0/1, coerced to boolean in the API response |
| `watched_at` | TEXT | `YYYY-MM-DD`, set when status → `'archive'`, cleared otherwise |

Apply migrations with:

```bash
npx wrangler d1 migrations apply movievault --remote
```

Drop `--remote` to target the local dev database.

## Status model

Three states, all driven from the movie detail modal:

- **GET** — want to procure, not on the drive yet
- **GOT** — on the hard drive, browsable, ready to watch (the default view)
- **ARCHIVE** — already watched

Adding a movie from search assigns the status of whichever view is active (GET if on the GET tab, otherwise GOT).

## Auth

PIN-based (4 separate digit inputs). The PIN lives **server-side only**, as the `VAULT_PIN` Pages secret — it is never in the client bundle. Flow:

1. Client POSTs the entered PIN to `/api?type=auth`
2. On success, the PIN is cached in `localStorage` (`vault_pin`) alongside a `vault_auth` timestamp, valid 24 hours
3. Every data request sends it as the `x-vault-pin` header; the Function rejects mismatches with 401
4. A 401 from any data call clears local auth and returns to the PIN screen

## API endpoints

All on `/api?type=...`. `auth`, `search`, and `detail` are unauthenticated; everything else requires the `x-vault-pin` header.

| type | Method | Purpose |
|---|---|---|
| `auth` | POST | Validate PIN |
| `search` | GET | Title search via TMDB (partial/mid-word capable), falling back to OMDB if TMDB is unavailable; returns OMDB-shaped results |
| `detail` | GET | OMDB detail by IMDb id |
| `list` | GET | All movies, sorted by title |
| `upsert` | POST | Insert movie, or refresh metadata if it exists (never overwrites `status`) |
| `status` | POST | Change status; manages `watched_at` |
| `delete` | POST | Remove by `imdb_id` |
| `fresh` | GET | Recent digitally-released films from TMDB, minus anything already in the library |

All SQL uses prepared statements with bound parameters.

## Key Features

- **Tabbed views** — GOT (default) / GET / ARCHIVE, counts in the tab bar
- **Sorting** — title / release date / rating / runtime, applies to the poster grids
- **Archive** — compact list rows: thumbnail, title, year·runtime, watched date, rating
- **Movie roulette** — random pick from GOT only; hidden on other tabs
- **Search** — TMDB via the Function proxy, debounced 300ms; results already in the library are badged with their status

## Local development

`.dev.vars` holds `OMDB_API_KEY`, `VAULT_PIN` and `TMDB_API_KEY` for local runs. It is gitignored — do not commit it.

```bash
npx wrangler pages dev .
```

## Deployment Notes

- Local files and the GitHub remote can drift — always check `git fetch && git diff origin/main HEAD` before making changes
- The app is installed as a PWA on Daniel's phone; cache clears require deleting and re-adding the home screen icon
- Secrets (`OMDB_API_KEY`, `VAULT_PIN`, `TMDB_API_KEY`) are set in the Cloudflare Pages project settings, not in `wrangler.toml`
- Without `TMDB_API_KEY` the `fresh` endpoint returns 503 and the Fresh Finds strip hides itself; the rest of the app is unaffected
- `wrangler.toml` carries the D1 `database_id`; it is a non-secret identifier and is safe to commit
