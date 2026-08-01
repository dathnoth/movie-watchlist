let debounceTimer;
let currentSort = 'title';
let currentView = 'got';
let cachedMovies = [];

const STATUS_LABELS = { get: 'Get', got: 'Got', archive: 'Archive' };

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

function updateRouletteVisibility() {
    const roulette = document.getElementById('rouletteWrapper');
    roulette.classList.toggle('roulette-hidden', currentView !== 'got' || window.scrollY <= 100);
}

window.addEventListener('scroll', updateRouletteVisibility);

document.getElementById('movieInput').addEventListener('input', (e) => {
    const clearBtn = document.getElementById('clearSearch');
    const resultsDiv = document.getElementById('searchResults');
    clearBtn.style.display = e.target.value.length > 0 ? 'block' : 'none';
    clearTimeout(debounceTimer);
    const q = e.target.value;
    if (q.length < 3) { resultsDiv.classList.remove('active'); resultsDiv.innerHTML = ''; return; }
    resultsDiv.classList.add('active');
    resultsDiv.innerHTML = Array(6).fill('<div class="movie-card skeleton-shimmer" style="min-width:160px; height:240px;"></div>').join('');
    debounceTimer = setTimeout(() => liveSearch(q), 300);
});

async function liveSearch(query) {
    const res = await fetch(`/api?type=search&q=${encodeURIComponent(query)}`);
    const data = await res.json();
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '';
    if (!data.Search) return;
    data.Search.slice(0, 10).forEach(m => {
        const div = document.createElement('div');
        div.className = 'movie-card';
        div.id = `search-${m.imdbID}`;
        div.style.minWidth = '140px';
        div.innerHTML = `<img src="${escapeHtml(m.Poster)}" style="width:100%; height:200px; object-fit:cover;"><div style="padding:10px; font-size:0.75rem; font-weight:bold;">${escapeHtml(m.Title)}</div>`;
        div.onclick = () => addToVault(m.imdbID);
        resultsDiv.appendChild(div);
    });
}

async function fetchMovies() {
    const data = await api('list');
    if (!Array.isArray(data)) return;
    cachedMovies = data;
    render(sortMovies(data));
}

function sortMovies(movies) {
    return [...movies].sort((a, b) => {
        if (currentSort === 'title') return a.title.localeCompare(b.title);
        if (currentSort === 'year') return (new Date(b.year).getTime() || 0) - (new Date(a.year).getTime() || 0);
        if (currentSort === 'rating') return (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0);
        if (currentSort === 'runtime') return (parseInt(b.runtime) || 0) - (parseInt(a.runtime) || 0);
        return 0;
    });
}

function setView(view) {
    currentView = view;
    document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    document.querySelectorAll('.view-panel').forEach(p => p.classList.toggle('active', p.id === `view-${view}`));
    updateRouletteVisibility();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setSort(type) {
    currentSort = type;
    document.querySelectorAll('.sort-btn').forEach(btn => btn.classList.remove('active'));
    const btnId = type === 'title' ? 'sortAlpha' : 'sort' + type.charAt(0).toUpperCase() + type.slice(1);
    document.getElementById(btnId)?.classList.add('active');
    render(sortMovies(cachedMovies));
}

function formatWatchedDate(value) {
    return new Date(value + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function cardHtml(m) {
    return `
        <div class="movie-card">
            <button class="remove-btn" onclick="deleteMovie('${m.imdb_id}')">✕</button>
            ${m.is_tv_show ? '<span class="tv-badge">TV</span>' : ''}
            <div class="poster-wrapper skeleton-shimmer" onclick="showDetails('${m.imdb_id}')">
                <img class="card-poster" src="${escapeHtml(m.poster)}" onload="this.classList.add('loaded')">
            </div>
            <div class="card-content" onclick="showDetails('${m.imdb_id}')">
                <div class="movie-title">${escapeHtml(m.title)}</div>
                <span class="genre-tag">${escapeHtml(m.genre)}</span>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span class="runtime-text">${escapeHtml(m.runtime)}</span>
                    <span style="color:#fbbf24; font-size:0.75rem; font-weight:bold;">⭐ ${escapeHtml(m.rating)}</span>
                </div>
            </div>
        </div>`;
}

function archiveRowHtml(m) {
    const year = (m.year || '').match(/\d{4}/)?.[0] || '';
    const meta = [year, m.runtime && m.runtime !== 'N/A' ? m.runtime : null].filter(Boolean).join(' • ');
    return `
        <div class="archive-row" onclick="showDetails('${m.imdb_id}')">
            <img class="archive-thumb" src="${escapeHtml(m.poster)}" loading="lazy">
            <div class="archive-main">
                <div class="archive-title">${escapeHtml(m.title)}${m.is_tv_show ? ' <span class="tv-badge-inline">TV</span>' : ''}</div>
                <div class="archive-meta">
                    <span>${escapeHtml(meta)}</span>
                    ${m.watched_at ? `<span class="archive-date">Watched ${formatWatchedDate(m.watched_at)}</span>` : ''}
                </div>
            </div>
            <span class="archive-rating">⭐ ${escapeHtml(m.rating)}</span>
            <button class="archive-remove" onclick="event.stopPropagation(); deleteMovie('${m.imdb_id}')">✕</button>
        </div>`;
}

function render(movies) {
    const buckets = { get: [], got: [], archive: [] };
    movies.forEach(m => (buckets[m.status] || buckets.get).push(m));

    document.getElementById('getList').innerHTML = buckets.get.map(cardHtml).join('')
        || '<p class="empty-state">Nothing to track down yet.</p>';
    document.getElementById('gotList').innerHTML = buckets.got.map(cardHtml).join('')
        || '<p class="empty-state">No movies on the drive yet.</p>';
    document.getElementById('archiveList').innerHTML = buckets.archive.map(archiveRowHtml).join('')
        || '<p class="empty-state">Nothing watched yet.</p>';

    document.getElementById('getCount').textContent = buckets.get.length;
    document.getElementById('gotCount').textContent = buckets.got.length;
    document.getElementById('archiveCount').textContent = buckets.archive.length;
}

function pickRandomMovie() {
    const pool = cachedMovies.filter(m => m.status === 'got');
    if (pool.length === 0) { alert('Nothing in GOT yet — add movies you actually have on the drive.'); return; }
    const btn = document.getElementById('rouletteBtn');
    btn.classList.add('shuffling');
    setTimeout(() => {
        btn.classList.remove('shuffling');
        showDetails(pool[Math.floor(Math.random() * pool.length)].imdb_id);
    }, 600);
}

async function addToVault(id) {
    const card = document.getElementById(`search-${id}`);
    if (card) card.classList.add('added-state');

    const res = await fetch(`/api?type=detail&id=${id}`);
    const d = await res.json();

    await api('upsert', {
        body: {
            imdb_id: d.imdbID,
            title: d.Title,
            poster: d.Poster,
            year: d.Released,
            runtime: d.Runtime,
            rating: d.imdbRating,
            genre: d.Genre,
            status: currentView === 'get' ? 'get' : 'got',
            is_tv_show: d.Type === 'series',
        },
    });

    setTimeout(() => {
        document.getElementById('searchResults').classList.remove('active');
        fetchMovies();
    }, 600);
}

function statusActions(id, status) {
    const btn = (target, label, cls) =>
        `<button onclick="updateStatus('${id}', '${target}')" class="modal-btn ${cls}">${label}</button>`;

    if (status === 'get') return btn('got', 'Got It', 'btn-got');
    if (status === 'got') return btn('archive', 'Watched', 'btn-watched') + btn('get', 'Not On Drive', 'btn-restore');
    if (status === 'archive') return btn('got', 'Restore', 'btn-restore');
    return btn('get', 'Add to Get', 'btn-got');
}

async function showDetails(id) {
    const modal = document.getElementById('detailsModal');
    const content = document.getElementById('modalData');
    modal.classList.add('open');
    document.body.classList.add('modal-open');

    content.innerHTML = `
        <div class="modal-body">
            <div class="skeleton-shimmer" style="width:200px; height:300px; border-radius:16px; flex-shrink:0;"></div>
            <div style="flex:1; width:100%;">
                <div class="skeleton-shimmer" style="width:80%; height:32px; margin-bottom:12px; border-radius:4px;"></div>
                <div class="skeleton-shimmer" style="width:50%; height:18px; margin-bottom:25px; border-radius:4px;"></div>
                <div class="skeleton-shimmer" style="width:100%; height:14px; margin-bottom:8px;"></div>
                <div class="skeleton-shimmer" style="width:100%; height:14px; margin-bottom:25px;"></div>
                <div style="display:flex; gap:10px;">
                    <div class="skeleton-shimmer" style="flex:1; height:45px; border-radius:12px;"></div>
                    <div class="skeleton-shimmer" style="flex:1; height:45px; border-radius:12px;"></div>
                </div>
            </div>
        </div>`;

    const local = cachedMovies.find(m => m.imdb_id === id);
    let d;
    try {
        d = await (await fetch(`/api?type=detail&id=${id}`)).json();
    } catch {
        content.innerHTML = '<p style="color:#f87171; padding:20px;">Failed to load movie details. Please try again.</p>';
        return;
    }
    if (!d || !d.Title) {
        content.innerHTML = '<p style="color:#f87171; padding:20px;">Movie details not available.</p>';
        return;
    }

    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(d.Title + ' trailer')}`;

    content.innerHTML = `
        <div class="modal-body">
            <img src="${escapeHtml(d.Poster)}" class="modal-poster">
            <div style="flex:1; width: 100%;">
                <h2 style="font-size:1.7rem; color:white; margin:0 0 5px 0;">${escapeHtml(d.Title)}</h2>
                <div style="color:var(--accent); font-weight:bold; margin-bottom:15px; font-size:0.85rem;">
                    ${escapeHtml(d.Released)} • ${escapeHtml(d.Runtime)} • ⭐ ${escapeHtml(d.imdbRating)}
                </div>
                ${local ? `<span class="status-pill status-${local.status}">${STATUS_LABELS[local.status]}</span>` : ''}
                <div class="modal-info-label">Plot Summary</div>
                <div class="modal-info-value">${escapeHtml(d.Plot)}</div>
                <div class="info-row">
                    <div>
                        <div class="modal-info-label">Director</div>
                        <div class="modal-info-value">${escapeHtml(d.Director)}</div>
                    </div>
                    <div>
                        <div class="modal-info-label">Genre</div>
                        <div class="genre-tag">${escapeHtml(d.Genre)}</div>
                    </div>
                </div>
                <div class="modal-info-label">Cast</div>
                <div class="modal-info-value">${escapeHtml(d.Actors)}</div>
                <div class="btn-group">
                    ${statusActions(id, local?.status)}
                    <a href="https://www.imdb.com/title/${id}/" target="_blank" class="modal-btn btn-imdb">IMDb</a>
                    <a href="${ytUrl}" target="_blank" class="modal-btn btn-yt">Trailer</a>
                </div>
            </div>
        </div>`;
}

async function updateStatus(id, status) {
    await api('status', { body: { imdb_id: id, status } });
    closeModal();
    fetchMovies();
}

async function deleteMovie(id) {
    if (!confirm('Remove?')) return;
    await api('delete', { body: { imdb_id: id } });
    fetchMovies();
}

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

function closeModal() {
    document.getElementById('detailsModal').classList.remove('open');
    document.body.classList.remove('modal-open');
}

function escapeHtml(str) {
    if (typeof str !== 'string') return str ?? '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toggleSearch() {
    const drawer = document.getElementById('searchDrawer');
    const btn = document.getElementById('addBtn');
    const isOpen = drawer.classList.toggle('open');
    btn.classList.toggle('active', isOpen);
    if (isOpen) {
        setTimeout(() => document.getElementById('movieInput').focus(), 300);
    } else {
        document.getElementById('searchResults').classList.remove('active');
        document.getElementById('searchResults').innerHTML = '';
        document.getElementById('movieInput').value = '';
        document.getElementById('clearSearch').style.display = 'none';
    }
}
