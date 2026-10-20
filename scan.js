// Desktop folder check. Folders follow "Movie Name (Year)"; tags after the
// year are ignored. A bare year token counts too ("Title 1999 1080p").
// The year decides between films that share a name. A leading The/A/An
// is optional, so "Matrix (1999)" matches "The Matrix".

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|mpg|mpeg|webm)$/i;
const SKIP_NAME = /^(extras?|featurettes?|behind the scenes|subtitles?|subs|samples?|proof|trailers?)$/i;
const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9' };
const NUMBER_WORDS = {
    two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

function releaseYear(value) {
    const match = String(value || '').match(/\d{4}/);
    return match ? match[0] : '';
}

function skipEntry(name) {
    if (!name || /^[.@#]/.test(name)) return true;
    return SKIP_NAME.test(String(name).replace(VIDEO_EXT, ''));
}

function parseMovieName(raw) {
    let name = String(raw || '').replace(VIDEO_EXT, '');
    name = name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
    const paren = name.match(/^(.*?)\s*[(\[{]\s*((?:19|20)\d{2})\s*[)\]}](?:\s.*)?$/);
    if (paren && paren[1].trim()) return { title: paren[1].trim(), year: paren[2], named: true };

    const tokens = name.split(' ');
    for (let i = tokens.length - 1; i > 0; i--) {
        if (/^(?:19|20)\d{2}$/.test(tokens[i])) {
            const title = tokens.slice(0, i).join(' ');
            if (title) return { title, year: tokens[i], named: true };
        }
    }
    return { title: name, year: '', named: false };
}

function normalizeTitle(raw) {
    let text = String(raw || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    text = text.toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
    text = text.trim().replace(/\s+/g, ' ');
    if (!text) return '';
    return text.split(' ').map((word) => ROMAN[word] || NUMBER_WORDS[word] || word).join(' ');
}

function titleKeys(title) {
    const norm = normalizeTitle(title);
    if (!norm) return [];
    const stripped = norm.replace(/^(the|a|an) /, '');
    return stripped && stripped !== norm ? [norm, stripped] : [norm];
}

function candidatesFor(folder, movies, articles) {
    const wanted = new Set(articles ? titleKeys(folder.title) : [normalizeTitle(folder.title)].filter(Boolean));
    const seen = new Set();
    const found = [];
    for (const movie of movies) {
        const keys = articles ? titleKeys(movie.title) : [normalizeTitle(movie.title)].filter(Boolean);
        if (!keys.some((key) => wanted.has(key)) || seen.has(movie.imdb_id)) continue;
        seen.add(movie.imdb_id);
        found.push(movie);
    }
    return found;
}

function decideMatch(folder, pool) {
    if (!pool.length) return {};
    if (folder.year) {
        const sameYear = pool.filter((movie) => releaseYear(movie.year) === folder.year);
        if (sameYear.length === 1) return { movie: sameYear[0] };
        if (sameYear.length > 1) return { ambiguous: true };
        const undated = pool.filter((movie) => !releaseYear(movie.year));
        if (undated.length === 1) return { movie: undated[0] };
        return {};
    }
    if (pool.length === 1) return { movie: pool[0] };
    return { ambiguous: true };
}

function pickMovie(folder, movies) {
    const strict = decideMatch(folder, candidatesFor(folder, movies, false));
    if (strict.movie || strict.ambiguous) return strict;
    return decideMatch(folder, candidatesFor(folder, movies, true));
}

function compareLibrary(movies, entries) {
    const library = Array.isArray(movies) ? movies : [];
    const folders = Array.isArray(entries) ? entries : [];
    const matched = new Map();
    const unknown = [];

    for (const folder of folders) {
        const pick = pickMovie(folder, library);
        if (pick.movie) {
            const row = matched.get(pick.movie.imdb_id) || { movie: pick.movie, folders: [] };
            row.folders.push(folder.name);
            matched.set(pick.movie.imdb_id, row);
        } else {
            unknown.push({
                name: folder.name,
                title: folder.title || folder.name,
                year: folder.year || '',
                note: pick.ambiguous ? 'Matches more than one film' : '',
            });
        }
    }

    const moves = [];
    let already = 0;
    let watched = 0;
    for (const { movie, folders: names } of matched.values()) {
        if (movie.status === 'get') {
            moves.push({
                imdb_id: movie.imdb_id,
                title: movie.title,
                year: releaseYear(movie.year),
                folder: names.join(', '),
            });
        } else if (movie.status === 'got') already += 1;
        else if (movie.status === 'archive') watched += 1;
    }

    const missing = library
        .filter((movie) => movie.status === 'got' && !movie.is_tv_show && !matched.has(movie.imdb_id))
        .map((movie) => ({ imdb_id: movie.imdb_id, title: movie.title, year: releaseYear(movie.year) }));

    const byTitle = (a, b) => a.title.localeCompare(b.title);
    moves.sort(byTitle);
    missing.sort(byTitle);
    unknown.sort((a, b) => a.name.localeCompare(b.name));

    return {
        moves,
        missing,
        unknown,
        already,
        watched,
        tvSkipped: library.filter((movie) => movie.status === 'got' && movie.is_tv_show).length,
    };
}

// One level of plain folders (a genre or a "4K" bucket) is opened.
// A folder that already looks like a film is not opened.
async function collectMovieEntries(dirHandle) {
    const found = [];
    for await (const [name, handle] of dirHandle.entries()) {
        if (skipEntry(name)) continue;
        if (handle.kind === 'file') {
            if (VIDEO_EXT.test(name)) found.push({ name, ...parseMovieName(name) });
            continue;
        }

        const parsed = parseMovieName(name);
        if (parsed.named) {
            found.push({ name, ...parsed });
            continue;
        }

        const nested = [];
        for await (const [childName, child] of handle.entries()) {
            if (skipEntry(childName)) continue;
            const childParsed = parseMovieName(childName);
            const video = child.kind === 'file' && VIDEO_EXT.test(childName);
            if (childParsed.named && (child.kind === 'directory' || video)) {
                nested.push({ name: `${name}/${childName}`, ...childParsed });
            }
        }
        if (nested.length) found.push(...nested);
        else found.push({ name, ...parsed });
    }
    return found;
}

function directoryHandleFromPaths(paths) {
    const root = new Map();
    let folderName = '';
    for (const raw of paths) {
        const parts = String(raw).split('/').filter(Boolean);
        if (!parts.length) continue;
        if (!folderName) folderName = parts[0];
        let level = root;
        const inner = parts.slice(1);
        inner.forEach((part, index) => {
            const last = index === inner.length - 1;
            let node = level.get(part);
            if (!node) {
                node = { kind: last ? 'file' : 'directory', kids: new Map() };
                level.set(part, node);
            }
            if (!last) {
                node.kind = 'directory';
                if (!node.kids) node.kids = new Map();
                level = node.kids;
            }
        });
    }
    return { folderName, handle: mapToHandle(root) };
}

function mapToHandle(map) {
    return {
        kind: 'directory',
        entries() {
            const pairs = [...map.entries()].map(([name, node]) => [
                name,
                node.kind === 'directory' ? mapToHandle(node.kids || new Map()) : { kind: 'file' },
            ]);
            return (async function* () {
                for (const pair of pairs) yield pair;
            })();
        },
    };
}

Object.assign(globalThis, {
    releaseYear,
    skipEntry,
    parseMovieName,
    normalizeTitle,
    titleKeys,
    compareLibrary,
    collectMovieEntries,
    directoryHandleFromPaths,
});
