# MovieVault — CLAUDE.md

Personal movie watchlist PWA for Daniel. Deployed via Cloudflare Pages.

## Stack

- **Frontend**: Vanilla HTML/CSS/JS — single `index.html`, `style.css`, `app.js`
- **Database**: Supabase (project ID: `xsranuxnftbpuzciyiia`, region: eu-west-1)
- **API proxy**: Cloudflare Pages Function at `functions/api.js` — proxies OMDB search/detail calls to keep the API key server-side
- **Deployment**: Push to `main` on GitHub (`dathnoth/movie-watchlist`) → auto-deploys via Cloudflare Pages

## Database

Single table: `public.movies`

| Column | Type | Notes |
|---|---|---|
| `imdb_id` | text (PK) | |
| `title` | text | |
| `poster` | text | |
| `status` | text | `'want'` or `'watched'` |
| `year` | text | |
| `runtime` | text | |
| `rating` | text | IMDb rating |
| `genre` | text | |
| `plot` | text | |
| `director` | text | |
| `actors` | text | |
| `trailer` | text | |
| `votes` | smallint | |
| `my_stars` | integer | |
| `is_tv_show` | boolean | default false |
| `watched_at` | date | set when status → `'watched'`, cleared on restore |

RLS is enabled. The anon key is passed with a custom `x-vault-pin` header for row-level security.

## Auth

PIN-based (4 separate digit inputs). PIN is hardcoded in `app.js` as `VAULT_PIN`. Auth state stored in `localStorage` (`vault_auth` timestamp), valid for 24 hours.

## Key Features

- **Watchlist** — movies to watch, sortable by title / release date / rating / runtime
- **Archive** — watched movies, shows "Watched DD Mon YYYY" date for movies archived after the `watched_at` column was added (existing rows have no date)
- **Movie roulette** — random pick from watchlist
- **Search** — OMDB search via Cloudflare proxy, debounced 300ms

## Deployment Notes

- Local files and the GitHub remote can drift — always check `git fetch && git diff origin/main HEAD` before making changes
- The app is installed as a PWA on Daniel's phone; cache clears require deleting and re-adding the home screen icon
- The Cloudflare function still contains YTS proxy routes (`yts_list`, `yts_detail`) — these are dead but harmless since the UI was removed
