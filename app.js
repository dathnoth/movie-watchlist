let debounceTimer;
let currentSort = 'title';
let watchedSort = 'watched';
let currentView = 'got';
let cachedMovies = [];
let freshFilms = [];
let searchHits = [];
let scanReport = null;
let scanReady = false;
// OMDB detail fetched for the open modal, reused when adding so it isn't fetched twice.
const detailCache = {};

// 'archive' is the stored status value; the UI calls it Watched.
const STATUS_LABELS = { get: 'Get', got: 'Got', archive: 'Watched' };

// Inline so the star renders identically everywhere, unlike the emoji it replaces.
const STAR_SVG = '<svg class="star-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.44l-5.81 3.06 1.11-6.47-4.7-4.58 6.5-.95z"/></svg>';

const ICONS = {
    got: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 9h18M3 15h18M7.5 5v14M16.5 5v14"/></svg>',
    get: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4z"/></svg>',
    archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
    ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

function getPin() { return localStorage.getItem('vault_pin') || ''; }

async function api(type, options = {}) {
    const res = await fetch(`/api?type=${type}${options.query || ''}`, {
        method: options.body ? 'POST' : 'GET',
        headers: { 'x-vault-pin': getPin(), 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 401) { logout(); throw new Error('unauthorized'); }
    return res.json();
}

function logout() {
    localStorage.removeItem('vault_pin');
    document.getElementById('authOverlay').style.display = 'flex';
    document.getElementById('mainApp').style.display = 'none';
}

// The stored PIN persists until the server rejects it (see logout()), so the
// installed PWA doesn't re-prompt on every launch.
window.onload = () => {
    if (getPin()) {
        document.getElementById('authOverlay').style.display = 'none';
        document.getElementById('mainApp').style.display = 'block';
        fetchMovies();
    }
};

// OMDB reports missing fields as the string "N/A".
const known = (v) => (v && v !== 'N/A' ? v : '');
// OMDB sometimes sends text with HTML entities already in it ("O&apos;Connell").
const omdbText = (v) => known(v).replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const yearOf = (m) => (m.year || '').match(/\d{4}/)?.[0] || '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Poster tile contents. The title sits underneath the image, so a missing or
// dead poster still shows what the film is.
function tileInner({ title, poster, rating, tv, badge }) {
    const img = known(poster)
        ? `<img src="${escapeHtml(poster)}" alt="" loading="lazy" onload="this.classList.add('loaded')" onerror="this.remove()">`
        : '';
    return `<span class="tile-fallback">${escapeHtml(title)}</span>${img}
        ${tv ? '<span class="tile-tv">TV</span>' : ''}
        ${badge || ''}
        ${known(rating) ? `<span class="tile-rating">${STAR_SVG}${escapeHtml(rating)}</span>` : ''}`;
}

function libraryTile(m) {
    const missing = m.status === 'got' && scanMissingIds().has(m.imdb_id);
    return `<button class="tile" onclick="showDetails('${m.imdb_id}')" aria-label="${escapeHtml(m.title)}${missing ? ', missing from the movies folder' : ''}">
        ${tileInner({ title: m.title, poster: m.poster, rating: m.rating, tv: m.is_tv_show })}
        ${missing ? '<span class="tile-missing">Missing</span>' : ''}</button>`;
}

const SKELETON_TILES = Array(9).fill('<span class="tile skeleton-shimmer"></span>').join('');

// ── Search ────────────────────────────────────────────────────────────────

document.getElementById('movieInput').addEventListener('input', (e) => {
    const q = e.target.value;
    document.getElementById('clearSearch').style.display = q ? 'flex' : 'none';
    clearTimeout(debounceTimer);
    const resultsDiv = document.getElementById('searchResults');
    if (q.length < 3) {
        searchHits = [];
        resultsDiv.innerHTML = '';
        setSearchHint('Type at least 3 letters');
        return;
    }
    setSearchHint('');
    resultsDiv.innerHTML = SKELETON_TILES;
    debounceTimer = setTimeout(() => liveSearch(q), 300);
});

document.getElementById('clearSearch').addEventListener('click', () => {
    const input = document.getElementById('movieInput');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.focus();
});

function setSearchHint(text) {
    const hint = document.getElementById('searchHint');
    hint.textContent = text;
    hint.hidden = !text;
}

async function liveSearch(query) {
    const res = await fetch(`/api?type=search&q=${encodeURIComponent(query)}`);
    const data = await res.json();
    // A slower, older query must not overwrite the results of a newer one.
    if (query !== document.getElementById('movieInput').value) return;
    searchHits = (data.Search || []).slice(0, 12);
    renderSearch();
}

function renderSearch() {
    const resultsDiv = document.getElementById('searchResults');
    if (searchHits.length === 0) {
        resultsDiv.innerHTML = '';
        if (document.getElementById('movieInput').value.length >= 3) setSearchHint('No matches');
        return;
    }
    resultsDiv.innerHTML = searchHits.map((m) => {
        // Flag anything already saved, so you can see at a glance that a
        // result is on the drive, wanted, or already watched.
        const existing = cachedMovies.find((x) => x.imdb_id === m.imdbID);
        const badge = existing
            ? `<span class="tile-owned status-${existing.status}">${STATUS_LABELS[existing.status]}</span>`
            : '';
        // Matches how the library flags TV: series only, movies get no marker.
        const tv = m.Type === 'series';
        return `<button class="search-item${existing ? ' is-owned' : ''}" onclick="showDetails('${escapeHtml(m.imdbID)}')">
            <span class="tile">${tileInner({ title: m.Title, poster: m.Poster, tv, badge })}</span>
            <span class="search-title">${escapeHtml(m.Title)}</span>
            <span class="search-year">${escapeHtml(known(m.Year))}</span>
        </button>`;
    }).join('');
}

function toggleSearch() {
    const sheet = document.getElementById('searchSheet');
    if (!sheet.classList.contains('open') && document.body.classList.contains('scan-open')) closeScan();
    const isOpen = sheet.classList.toggle('open');
    sheet.setAttribute('aria-hidden', String(!isOpen));
    document.getElementById('addBtn').classList.toggle('active', isOpen);
    document.body.classList.toggle('search-open', isOpen);
    const input = document.getElementById('movieInput');
    if (isOpen) {
        // Focus inside the tap handler itself, or iOS won't raise the keyboard.
        input.focus();
    } else {
        input.value = '';
        input.blur();
        searchHits = [];
        document.getElementById('searchResults').innerHTML = '';
        document.getElementById('clearSearch').style.display = 'none';
        setSearchHint('Type at least 3 letters');
    }
}

// ── Fresh Finds ───────────────────────────────────────────────────────────

// Fresh finds: recent, digitally-released films not already in the library.
// Failures stay silent — this is a discovery extra, not core to the app.
async function fetchFresh() {
    const block = document.getElementById('freshBlock');
    document.getElementById('freshList').innerHTML = SKELETON_TILES;

    let films;
    try {
        films = await api('fresh');
    } catch {
        block.classList.remove('visible');
        return;
    }
    if (!Array.isArray(films) || films.length === 0) {
        block.classList.remove('visible');
        return;
    }

    freshFilms = films;
    block.classList.add('visible');
    populateFreshFilters(films);
    renderFresh();
}

// Filter options come from the results themselves, so they never offer a
// choice that would return nothing.
function populateFreshFilters(films) {
    const years = [...new Set(films.map((f) => f.year).filter(Boolean))].sort().reverse();
    const genres = [...new Set(films.flatMap((f) => f.genres || []))].sort();

    const fill = (id, blank, values) => {
        const sel = document.getElementById(id);
        const previous = sel.value;
        sel.innerHTML = `<option value="">${blank}</option>`
            + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        if (values.includes(previous)) sel.value = previous;
    };

    fill('freshYear', 'Any year', years);
    fill('freshGenre', 'Any genre', genres);
}

function renderFresh() {
    const grid = document.getElementById('freshList');
    const year = document.getElementById('freshYear').value;
    const genre = document.getElementById('freshGenre').value;
    const runtime = document.getElementById('freshRuntime').value;
    const minRating = parseFloat(document.getElementById('freshRating').value) || 0;

    const [minLen, maxLen] = runtime ? runtime.split('-').map(Number) : [0, Infinity];

    const visible = freshFilms.filter((f) => {
        if (year && f.year !== year) return false;
        if (genre && !(f.genres || []).includes(genre)) return false;
        if (minRating && parseFloat(f.rating || 0) < minRating) return false;
        // Unknown runtime is only excluded once a length filter is chosen.
        if (runtime) {
            if (!f.runtime) return false;
            if (f.runtime < minLen || f.runtime >= maxLen) return false;
        }
        return true;
    });

    document.getElementById('freshCount').textContent = visible.length;
    document.querySelectorAll('.fresh-filters .chip-select').forEach((sel) => sel.classList.toggle('active', Boolean(sel.value)));
    document.getElementById('freshReset').hidden = !(year || genre || runtime || minRating);

    grid.innerHTML = visible.map((f) => `
        <button class="tile" onclick="showDetails('${escapeHtml(f.imdb_id)}')" aria-label="${escapeHtml(f.title)}">
            ${tileInner({ title: f.title, poster: f.poster, rating: f.rating })}</button>`).join('')
        || '<p class="empty-state">Nothing matches those filters.</p>';
}

function resetFreshFilters() {
    ['freshYear', 'freshGenre', 'freshRuntime', 'freshRating']
        .forEach((id) => { document.getElementById(id).value = ''; });
    renderFresh();
}

// ── Library ───────────────────────────────────────────────────────────────

async function fetchMovies() {
    const data = await api('list');
    if (!Array.isArray(data)) return;
    cachedMovies = data;
    scanReady = true;
    const scanBtn = document.getElementById('scanBtn');
    if (scanBtn && !scanBtn.hidden) scanBtn.disabled = false;
    render(data);
    // Owned badges on open search results follow the library.
    if (searchHits.length) renderSearch();
    // Re-run after each library change so anything just added drops out.
    fetchFresh();
}

function sortMovies(movies, sort) {
    return [...movies].sort((a, b) => {
        if (sort === 'title') return a.title.localeCompare(b.title);
        if (sort === 'year') return (new Date(b.year).getTime() || 0) - (new Date(a.year).getTime() || 0);
        if (sort === 'rating') return (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0);
        if (sort === 'runtime') return (parseInt(b.runtime) || 0) - (parseInt(a.runtime) || 0);
        // Most recently watched first; rows with no date sink to the bottom.
        if (sort === 'watched') return (b.watched_at || '').localeCompare(a.watched_at || '') || a.title.localeCompare(b.title);
        return 0;
    });
}

function setView(view) {
    currentView = view;
    document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    document.querySelectorAll('.view-panel').forEach(p => p.classList.toggle('active', p.id === `view-${view}`));
    if (document.body.classList.contains('search-open')) toggleSearch();
    if (document.body.classList.contains('scan-open')) closeScan();
    updateBackdrop();
    window.scrollTo({ top: 0 });
}

// The poster walls share one sort; the Watched list keeps its own so it can
// default to most recently watched.
function setSort(type, list = 'grid') {
    if (list === 'watched') watchedSort = type;
    else currentSort = type;
    document.querySelectorAll(`.sort-container[data-list="${list}"] .sort-btn`)
        .forEach(btn => btn.classList.toggle('active', btn.dataset.sort === type));
    render(cachedMovies);
}

function formatWatchedDate(value, opts) {
    return new Date(value + 'T00:00:00').toLocaleDateString('en-GB', opts);
}

function watchedRowHtml(m) {
    const meta = [
        m.watched_at ? `<em>${formatWatchedDate(m.watched_at, { weekday: 'short', day: 'numeric', month: 'short' })}</em>` : '',
        escapeHtml(yearOf(m)),
        known(m.rating) ? `★ ${escapeHtml(m.rating)}` : '',
    ].filter(Boolean).join(' · ');
    return `
        <button class="watched-row" onclick="showDetails('${m.imdb_id}')">
            <span class="watched-thumb">${known(m.poster) ? `<img src="${escapeHtml(m.poster)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
            <span class="watched-main">
                <span class="watched-title">${escapeHtml(m.title)}${m.is_tv_show ? ' <span class="tv-badge-inline">TV</span>' : ''}</span>
                <span class="watched-meta">${meta}</span>
            </span>
        </button>`;
}

// Sorted by Recent, the list is grouped by the month it was watched in.
function watchedListHtml(list) {
    if (list.length === 0) return '<p class="empty-state">Nothing watched yet.</p>';
    if (watchedSort !== 'watched') return list.map(watchedRowHtml).join('');

    const groups = [];
    list.forEach((m) => {
        const key = m.watched_at ? formatWatchedDate(m.watched_at, { month: 'long', year: 'numeric' }) : 'Earlier';
        let g = groups[groups.length - 1];
        if (!g || g.key !== key) groups.push(g = { key, items: [] });
        g.items.push(m);
    });
    return groups.map((g) => `
        <h3 class="month-head">${escapeHtml(g.key)}<small>${g.items.length}</small></h3>
        ${g.items.map(watchedRowHtml).join('')}`).join('');
}

function render(movies) {
    const buckets = { get: [], got: [], archive: [] };
    movies.forEach(m => (buckets[m.status] || buckets.get).push(m));
    buckets.get = sortMovies(buckets.get, currentSort);
    buckets.got = sortMovies(buckets.got, currentSort);
    buckets.archive = sortMovies(buckets.archive, watchedSort);

    document.getElementById('gotList').innerHTML = buckets.got.map(libraryTile).join('')
        || '<p class="empty-state">No movies on the drive yet.</p>';
    document.getElementById('getList').innerHTML = buckets.get.map(libraryTile).join('')
        || '<p class="empty-state">Nothing to track down yet.</p>';
    document.getElementById('archiveList').innerHTML = watchedListHtml(buckets.archive);
    // Sorting one film (or none) is pointless, so the chips only show for two or more.
    document.querySelector('#view-got .sort-container').hidden = buckets.got.length < 2;
    document.querySelector('#view-get .sort-container').hidden = buckets.get.length < 2;
    document.querySelector('#view-archive .sort-container').hidden = buckets.archive.length < 2;

    // The shelf always shows the latest few, whatever the list below is sorted by.
    const recent = sortMovies(buckets.archive.filter((m) => m.watched_at), 'watched').slice(0, 10);
    document.getElementById('recentBlock').hidden = recent.length === 0;
    document.getElementById('recentShelf').innerHTML = recent.map((m) => `
        <button class="shelf-item" onclick="showDetails('${m.imdb_id}')">
            <span class="shelf-poster">${known(m.poster) ? `<img src="${escapeHtml(m.poster)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
            <span class="shelf-title">${escapeHtml(m.title)}</span>
            <span class="shelf-date">${formatWatchedDate(m.watched_at, { day: 'numeric', month: 'short' })}</span>
        </button>`).join('');

    const missingCount = buckets.got.filter((m) => scanMissingIds().has(m.imdb_id)).length;
    document.getElementById('gotSub').textContent = missingCount
        ? `${plural(buckets.got.length, 'film')} on the drive · ${missingCount} missing from the folder`
        : `${plural(buckets.got.length, 'film')} on the drive`;
    syncScanAlert();
    document.getElementById('getSub').textContent = `${plural(buckets.get.length, 'film')} to track down`;
    document.getElementById('archiveSub').textContent = `${plural(buckets.archive.length, 'film')} seen`;

    updateBackdrop();
}

// Tint the top of the screen with the poster leading the current view.
function updateBackdrop() {
    let lead;
    if (currentView === 'got') lead = sortMovies(cachedMovies.filter((m) => m.status === 'got'), currentSort)[0];
    else if (currentView === 'get') lead = sortMovies(cachedMovies.filter((m) => m.status === 'get'), currentSort)[0] || freshFilms[0];
    else lead = sortMovies(cachedMovies.filter((m) => m.status === 'archive'), 'watched')[0];

    const backdrop = document.getElementById('backdrop');
    const img = document.getElementById('backdropImg');
    const src = known(lead?.poster);
    backdrop.classList.toggle('on', Boolean(src));
    if (src && img.getAttribute('src') !== src) img.src = src;
}

// ── Detail modal ──────────────────────────────────────────────────────────

async function addToVault(id, status) {
    const d = detailCache[id] || await (await fetch(`/api?type=detail&id=${id}`)).json();
    await api('upsert', {
        body: {
            imdb_id: d.imdbID,
            title: d.Title,
            poster: d.Poster,
            year: d.Released,
            runtime: d.Runtime,
            rating: d.imdbRating,
            genre: d.Genre,
            status,
            is_tv_show: d.Type === 'series',
        },
    });
}

// One control for both cases: for a film not yet saved it adds it, for a
// saved one it moves it. The current status is shown selected.
function pickerHtml(id, status) {
    const btn = (target, label) => `
        <button class="seg-btn seg-${target}${target === status ? ' on' : ''}" data-status="${target}"
            onclick="pickStatus('${id}', '${target}')"${target === status ? ' aria-pressed="true"' : ''}>${ICONS[target]}${label}</button>`;
    return `
        <small class="picker-label">${status ? 'In your library' : 'Add to your library'}</small>
        <div class="seg">${btn('got', 'Got')}${btn('get', 'Get')}${btn('archive', 'Watched')}</div>`;
}

async function pickStatus(id, status) {
    const local = cachedMovies.find((m) => m.imdb_id === id);
    if (local?.status === status) return;

    const picker = document.getElementById('picker');
    picker.querySelectorAll('.seg-btn').forEach((b) => {
        b.disabled = true;
        b.classList.toggle('busy', b.dataset.status === status);
    });

    // An existing row only needs its status changed (which also manages
    // watched_at); a new one has to be inserted, as the status UPDATE would
    // match nothing and fail silently.
    if (local) await api('status', { body: { imdb_id: id, status } });
    else await addToVault(id, status);
    await fetchMovies();

    if (status === 'archive') askImdb(id);
    else closeModal();
}

// After marking something watched, offer the IMDb page for trivia and reviews.
// The link is a real tap target, so it opens even in the installed PWA.
function askImdb(id) {
    document.getElementById('picker').innerHTML = `
        <div class="imdb-prompt">
            <div class="imdb-prompt-head">
                <span class="imdb-check">${ICONS.check}</span>
                <span><b>Marked as watched</b><span>Read the trivia and reviews on IMDb?</span></span>
            </div>
            <div class="imdb-prompt-actions">
                <a href="https://www.imdb.com/title/${id}/" target="_blank" rel="noopener" onclick="closeModal()" class="btn-imdb">Open IMDb</a>
                <button onclick="closeModal()" class="btn-quiet">Not now</button>
            </div>
        </div>`;
}

async function removeFromModal(id) {
    if (!confirm('Remove from your library?')) return;
    await api('delete', { body: { imdb_id: id } });
    closeModal();
    fetchMovies();
}

async function showDetails(id) {
    const modal = document.getElementById('detailsModal');
    const content = document.getElementById('modalData');
    modal.classList.add('open');
    document.body.classList.add('modal-open');

    content.innerHTML = `
        <div class="detail">
            <div class="detail-hero skeleton-shimmer"></div>
            <div class="detail-body">
                <div class="skeleton-shimmer" style="width:75%; height:30px; border-radius:6px; margin-bottom:12px;"></div>
                <div class="skeleton-shimmer" style="width:55%; height:16px; border-radius:4px; margin-bottom:18px;"></div>
                <div class="skeleton-shimmer" style="width:100%; height:13px; border-radius:4px; margin-bottom:8px;"></div>
                <div class="skeleton-shimmer" style="width:90%; height:13px; border-radius:4px;"></div>
            </div>
        </div>`;

    let d;
    try {
        d = await (await fetch(`/api?type=detail&id=${id}`)).json();
    } catch {
        content.innerHTML = '<p class="detail-error">Failed to load movie details. Please try again.</p>';
        return;
    }
    if (!d || !d.Title) {
        content.innerHTML = '<p class="detail-error">Movie details not available.</p>';
        return;
    }
    detailCache[id] = d;

    const local = cachedMovies.find(m => m.imdb_id === id);
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(d.Title + ' trailer')}`;
    const meta = [known(d.Released) || known(d.Year), known(d.Runtime), known(d.Genre).split(',')[0]]
        .filter(Boolean).map(escapeHtml).join(' · ');
    const credit = (label, value) => omdbText(value)
        ? `<div><dt>${label}</dt><dd>${escapeHtml(omdbText(value))}</dd></div>` : '';

    content.innerHTML = `
        <div class="detail">
            <div class="detail-hero">${known(d.Poster) ? `<img src="${escapeHtml(d.Poster)}" alt="">` : ''}</div>
            <div class="detail-body">
                <h2 class="detail-title">${escapeHtml(omdbText(d.Title))}${d.Type === 'series' ? ' <span class="tv-badge-inline">TV</span>' : ''}</h2>
                <div class="detail-meta">
                    ${known(d.imdbRating) ? `<span class="imdb-chip">IMDb</span><b>${escapeHtml(d.imdbRating)}</b>` : ''}
                    <span>${meta}</span>
                </div>
                ${omdbText(d.Plot) ? `<p class="detail-plot">${escapeHtml(omdbText(d.Plot))}</p>` : ''}
                <dl class="detail-credits">${credit('Director', d.Director)}${credit('Cast', d.Actors)}</dl>
                <div class="detail-links">
                    <a href="${ytUrl}" target="_blank" rel="noopener" class="pill">${ICONS.play}Trailer</a>
                    <a href="https://www.imdb.com/title/${id}/" target="_blank" rel="noopener" class="pill">${ICONS.ext}IMDb</a>
                    ${local ? `<button class="pill pill-danger" onclick="removeFromModal('${id}')">Remove</button>` : ''}
                </div>
            </div>
            <div class="picker" id="picker">${pickerHtml(id, local?.status)}</div>
        </div>`;
}

function closeModal() {
    document.getElementById('detailsModal').classList.remove('open');
    document.body.classList.remove('modal-open');
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('detailsModal').classList.contains('open')) closeModal();
    else if (document.body.classList.contains('scan-open')) closeScan();
    else if (document.body.classList.contains('search-open')) toggleSearch();
});

// ── PIN ───────────────────────────────────────────────────────────────────

async function checkPin() {
    const boxes = document.querySelectorAll('.pin-box');
    const pin = Array.from(boxes).map(b => b.value).join('');
    const errorEl = document.getElementById('pinError');

    boxes.forEach(b => b.classList.add('loading'));
    const res = await fetch('/api?type=auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
    });
    boxes.forEach(b => b.classList.remove('loading'));

    if (res.ok) {
        localStorage.setItem('vault_pin', pin);
        document.getElementById('authOverlay').style.display = 'none';
        document.getElementById('mainApp').style.display = 'block';
        boxes.forEach(b => { b.value = ''; });
        fetchMovies();
    } else {
        boxes.forEach(b => { b.value = ''; b.classList.add('shake'); });
        errorEl.textContent = 'Incorrect PIN — try again';
        errorEl.style.opacity = '1';
        setTimeout(() => {
            boxes.forEach(b => b.classList.remove('shake'));
            errorEl.style.opacity = '0';
        }, 1500);
        boxes[0].focus();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const boxes = document.querySelectorAll('.pin-box');
    boxes.forEach((box, i) => {
        box.addEventListener('input', () => {
            if (box.value.length === 1) {
                if (i < boxes.length - 1) boxes[i + 1].focus();
                else checkPin();
            }
        });
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && box.value === '' && i > 0) {
                boxes[i - 1].value = '';
                boxes[i - 1].focus();
            }
        });
    });
    if (boxes.length) boxes[0].focus();
});

function escapeHtml(str) {
    if (typeof str !== 'string') return str ?? '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Folder check ──────────────────────────────────────────────────────────
// The movies folder stays on this computer. Chromium can remember a
// read-only directory handle; other desktop browsers re-pick each time.

const SCAN_KEY = 'vault_scan';
const HANDLE_DB = 'movievault-scan';

function readStoredScan() {
    try {
        const data = JSON.parse(localStorage.getItem(SCAN_KEY) || 'null');
        return data && typeof data === 'object' ? data : null;
    } catch {
        return null;
    }
}

function scanMissingIds() {
    return new Set((scanReport?.missing || []).map((movie) => movie.imdb_id));
}

function rememberScan(report) {
    scanReport = {
        folderName: report.folderName || '',
        scannedAt: report.scannedAt || new Date().toISOString(),
        missing: report.missing || [],
        moves: report.moves || [],
        unknown: report.unknown || [],
        already: report.already || 0,
        watched: report.watched || 0,
        tvSkipped: report.tvSkipped || 0,
    };
    localStorage.setItem(SCAN_KEY, JSON.stringify(scanReport));
}

function desktopScanMode() {
    const desktop = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 800px)').matches;
    if (!desktop) return '';
    if (typeof window.showDirectoryPicker === 'function') return 'handle';
    if ('webkitdirectory' in document.createElement('input')) return 'input';
    return '';
}

function syncScanButton() {
    const btn = document.getElementById('scanBtn');
    if (!btn) return;
    const mode = desktopScanMode();
    btn.hidden = !mode;
    btn.disabled = !mode || !scanReady;
    btn.dataset.mode = mode;
    syncScanAlert();
}

function syncScanAlert() {
    const btn = document.getElementById('scanBtn');
    if (!btn) return;
    const missing = scanMissingIds().size;
    btn.classList.toggle('scan-alert', missing > 0);
    const folder = scanReport?.folderName;
    btn.setAttribute('aria-label', missing
        ? `Scan ${folder || 'movies folder'}, ${missing} missing`
        : `Scan ${folder || 'movies folder'}`);
}

function openHandleDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(HANDLE_DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('handles');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function loadMoviesHandle() {
    try {
        const db = await openHandleDb();
        return await new Promise((resolve, reject) => {
            const request = db.transaction('handles').objectStore('handles').get('movies');
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } catch {
        return null;
    }
}

async function saveMoviesHandle(handle) {
    const db = await openHandleDb();
    await new Promise((resolve, reject) => {
        const request = db.transaction('handles', 'readwrite').objectStore('handles').put(handle, 'movies');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function allowHandle(handle) {
    const opts = { mode: 'read' };
    if (await handle.queryPermission(opts) === 'granted') return true;
    return await handle.requestPermission(opts) === 'granted';
}

async function pickMoviesDirectory() {
    const base = { mode: 'read', id: 'movievault-movies' };
    try {
        return await window.showDirectoryPicker({ ...base, startIn: 'videos' });
    } catch (err) {
        if (!err || err.name === 'AbortError' || err.name === 'SecurityError') throw err;
        return window.showDirectoryPicker(base);
    }
}

async function scanFolder(opts = {}) {
    const mode = desktopScanMode();
    if (!mode || !scanReady) return;
    if (mode === 'input') {
        const input = document.getElementById('scanInput');
        input.value = '';
        input.onchange = async () => {
            const paths = [...input.files].map((file) => file.webkitRelativePath || file.name);
            if (!paths.length) return;
            const built = directoryHandleFromPaths(paths);
            const btn = document.getElementById('scanBtn');
            btn.disabled = true;
            try {
                await finishScan(built.handle, built.folderName || 'Movies');
            } finally {
                btn.disabled = false;
            }
        };
        input.click();
        return;
    }

    const btn = document.getElementById('scanBtn');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
        let handle = null;
        if (!opts.repick) handle = await loadMoviesHandle();
        if (handle) {
            try {
                if (!(await allowHandle(handle))) handle = null;
            } catch {
                handle = null;
            }
        }
        if (!handle) handle = await pickMoviesDirectory();
        await saveMoviesHandle(handle);
        await finishScan(handle, handle.name);
    } catch (err) {
        if (err && (err.name === 'AbortError' || err.name === 'SecurityError')) return;
        openScan({ error: 'Could not read that folder. Choose it again and allow access.' });
    } finally {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
    }
}

async function finishScan(handle, folderName) {
    openScan({ pending: true, folderName });
    try {
        const entries = await collectMovieEntries(handle);
        if (!entries.length) {
            openScan({
                error: 'No movie folders in there. Got was left as it is.',
                folderName,
            });
            return;
        }
        const report = compareLibrary(cachedMovies, entries);
        report.folderName = folderName;
        report.scannedAt = new Date().toISOString();
        rememberScan(report);
        render(cachedMovies);
        renderScan(scanReport);
    } catch {
        openScan({ error: 'Could not read that folder. Choose it again and allow access.', folderName });
    }
}

function openScan(report) {
    if (document.body.classList.contains('search-open')) toggleSearch();
    const sheet = document.getElementById('scanSheet');
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('scan-open');
    renderScan(report);
}

function closeScan() {
    const sheet = document.getElementById('scanSheet');
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('scan-open');
}

function scanSummaryText(report) {
    if (report.note) return report.note;
    const parts = [];
    if (report.moves.length) parts.push(`${plural(report.moves.length, 'film')} to move to Got`);
    if (report.missing.length) parts.push(`${plural(report.missing.length, 'film')} missing`);
    if (report.unknown.length) parts.push(`${report.unknown.length} not in your library`);
    if (report.already) parts.push(`${report.already} already in Got`);
    if (report.watched) parts.push(`${report.watched} left on Watched`);
    let text = parts.length ? parts.join(' · ') : 'This folder matched nothing in your library.';
    if (report.tvSkipped) text += `${text.endsWith('.') ? '' : '.'} TV on Got is not part of this check.`;
    return text;
}

function scanMeta(movie) {
    return [movie.year, movie.folder, movie.note].filter(Boolean).join(' · ');
}

function renderScan(report) {
    document.getElementById('scanFolderName').textContent = report.folderName || 'Movies folder';
    const summary = document.getElementById('scanSummary');
    const apply = document.getElementById('scanApply');
    const body = document.getElementById('scanBody');

    if (report.pending) {
        summary.textContent = '';
        apply.hidden = true;
        document.getElementById('scanRepick').disabled = true;
        body.innerHTML = '<p class="scan-status">Reading the folder…</p>';
        return;
    }
    if (report.error) {
        summary.textContent = '';
        apply.hidden = true;
        document.getElementById('scanRepick').disabled = false;
        body.innerHTML = `<p class="scan-status">${escapeHtml(report.error)}</p>`;
        return;
    }

    summary.textContent = scanSummaryText(report);
    document.getElementById('scanRepick').disabled = false;
    const moves = report.moves || [];
    apply.hidden = moves.length === 0;
    apply.disabled = false;
    apply.textContent = `Move ${moves.length} to Got`;

    const allRow = moves.length > 1 ? `
        <label class="scan-row">
            <input id="scanAll" type="checkbox" checked>
            <span><b>All of them</b></span>
        </label>` : '';
    const moveRows = allRow + moves.map((movie) => `
        <label class="scan-row">
            <input class="scan-move" type="checkbox" value="${escapeHtml(movie.imdb_id)}" checked>
            <span><b>${escapeHtml(movie.title)}</b><span class="scan-meta">${escapeHtml(scanMeta(movie))}</span></span>
        </label>`).join('');
    const missingRows = (report.missing || []).map((movie) => `
        <button type="button" class="scan-row" data-open="${escapeHtml(movie.imdb_id)}">
            <span><b>${escapeHtml(movie.title)}</b><span class="scan-meta">${escapeHtml(movie.year || 'No year')}</span></span>
        </button>`).join('');
    const unknownRows = (report.unknown || []).map((folder) => `
        <button type="button" class="scan-row" data-search="${escapeHtml(folder.title || folder.name)}">
            <span><b>${escapeHtml(folder.name)}</b>${folder.note ? `<span class="scan-meta">${escapeHtml(folder.note)}</span>` : ''}</span>
            <span class="scan-go">Search</span>
        </button>`).join('');

    const block = (title, count, note, rows) => rows ? `
        <section class="scan-block">
            <h3>${title} <small>${count}</small></h3>
            <p class="scan-note">${note}</p>
            ${rows}
        </section>` : '';

    body.innerHTML = [
        block('Move to Got', moves.length, 'In the folder, and still on your Get list.', moveRows),
        block('Missing from the folder', (report.missing || []).length, 'Still marked Got. No folder matched.', missingRows),
        block('Not in your library', (report.unknown || []).length, 'No saved film uses this name.', unknownRows),
    ].join('') || '<p class="scan-status">Nothing to change.</p>';
    updateScanApply();
}

function updateScanApply() {
    const apply = document.getElementById('scanApply');
    if (!apply || apply.hidden) return;
    const count = document.querySelectorAll('.scan-move:checked').length;
    apply.disabled = count === 0;
    apply.textContent = count ? `Move ${count} to Got` : 'Move to Got';
}

async function applyScanMoves() {
    const ids = [...document.querySelectorAll('.scan-move:checked')].map((box) => box.value);
    if (!ids.length || !scanReport) return;
    const apply = document.getElementById('scanApply');
    apply.disabled = true;
    apply.textContent = 'Moving…';

    const moved = [];
    try {
        for (const id of ids) {
            await api('status', { body: { imdb_id: id, status: 'got' } });
            moved.push(id);
        }
    } catch {
        // A 401 logs out. Anything else keeps the films that did move.
    }

    if (!moved.length) {
        apply.disabled = false;
        apply.textContent = 'Try again';
        return;
    }

    const done = new Set(moved);
    cachedMovies.forEach((movie) => { if (done.has(movie.imdb_id)) movie.status = 'got'; });
    scanReport.moves = (scanReport.moves || []).filter((movie) => !done.has(movie.imdb_id));
    scanReport.already = (scanReport.already || 0) + moved.length;
    rememberScan(scanReport);
    scanReport.note = `Moved ${plural(moved.length, 'film')} to Got.`;
    if (ids.length !== moved.length) scanReport.note += ' The rest did not save.';
    try { await fetchMovies(); } catch { render(cachedMovies); }
    renderScan(scanReport);
}

document.getElementById('scanBody').addEventListener('click', (event) => {
    const open = event.target.closest('[data-open]');
    if (open) { showDetails(open.dataset.open); return; }
    const search = event.target.closest('[data-search]');
    if (search) searchFromScan(search.dataset.search);
});

document.getElementById('scanBody').addEventListener('change', (event) => {
    if (event.target.id === 'scanAll') {
        document.querySelectorAll('.scan-move').forEach((box) => { box.checked = event.target.checked; });
        updateScanApply();
        return;
    }
    if (event.target.classList.contains('scan-move')) {
        const all = document.getElementById('scanAll');
        if (all) all.checked = [...document.querySelectorAll('.scan-move')].every((box) => box.checked);
        updateScanApply();
    }
});

function searchFromScan(title) {
    closeScan();
    if (!document.body.classList.contains('search-open')) toggleSearch();
    const input = document.getElementById('movieInput');
    input.value = title;
    input.dispatchEvent(new Event('input'));
}

scanReport = readStoredScan();
syncScanButton();
window.addEventListener('resize', syncScanButton);
