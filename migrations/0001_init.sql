CREATE TABLE movies (
  imdb_id      TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  poster       TEXT,
  status       TEXT NOT NULL DEFAULT 'get' CHECK (status IN ('get', 'got', 'archive')),
  year         TEXT,
  runtime      TEXT,
  rating       TEXT,
  genre        TEXT,
  plot         TEXT,
  director     TEXT,
  actors       TEXT,
  trailer      TEXT,
  votes        INTEGER,
  my_stars     INTEGER,
  is_tv_show   INTEGER NOT NULL DEFAULT 0,
  watched_at   TEXT
);
