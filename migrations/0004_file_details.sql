-- What's in the film file on the drive, sent by Dodo's file scan on the host
-- Mac: resolution, HDR, sound tracks, subtitles and a score breakdown (JSON),
-- plus the score out of 100 on its own so it can be sorted on.
ALTER TABLE movies ADD COLUMN file_info TEXT;
ALTER TABLE movies ADD COLUMN quality_score INTEGER;
