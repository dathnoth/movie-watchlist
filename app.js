// URLs are fine to stay public, but sensitive keys are now handled via Proxy or RLS
const SUPABASE_URL = 'https://xsranuxnftbpuzciyiia.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcmFudXhuZnRicHV6Y2l5aWlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2ODg2MzEsImV4cCI6MjA4NzI2NDYzMX0.aFrjE_wenjQ0cGE0wXDZEdqb4tptfOJ70AFZRDu0yfc';
const { createClient } = supabase;

let debounceTimer;
let currentSort = 'title';
let cachedMovies = [];
const VAULT_PIN = '0234';

// YTS state
let ytsPage = 1;
let ytsQuality = '';
let ytsTotalCount = 0;
const YTS_LIMIT = 20;
const YTS_BASE = 'https://yts.lt/api/v2/list_movies.json';
const ytsCache = {};
const MAGNET_TRACKERS = [
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:80',
    'udp://tracker.coppersurfer.tk:6969',
    'udp://glotorrents.pw:6969/announce',
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://torrent.gresille.org:80/announce',
    'udp://p4p.arenabg.com:1337',
    'udp://tracker.leechers-paradise.org:6969'
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

// Initialize Supabase with the x-vault-pin header for RLS Security
const _supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: {
        headers: { 'x-vault-pin': VAULT_PIN }
    }
});

window.onload = () => {
    const lastAuth = localStorage.getItem('vault_auth');
    if (lastAuth && (Date.now() - lastAuth < 86400000)) {
        document.getElementById('authOverlay').style.display = 'none';
        document.getElementById('mainApp').style.display = 'block';
        fetchMovies();
    }
};

window.addEventListener('scroll', () => {
    const roulette = document.getElementById('rouletteWrapper');
    if (window.scrollY > 100) {
        roulette.classList.remove('roulette-hidden');
    } else {
        roulette.classList.add('roulette-hidden');
    }
});

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

// Proxy Call: Search movies via Cloudflare Function
async function liveSearch(query) {
    const res = await fetch(`/api?type=search&q=${encodeURIComponent(query)}`);
    const data = await res.json();
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '';
    if (data.Search) {
        data.Search.slice(0, 10).forEach(m => {
            const div = document.createElement('div');
            div.className = 'movie-card';
            div.id = `search-${m.imdbID}`;
            div.style.minWidth = '140px';
            div.innerHTML = `<img src="${m.Poster}" style="width:100%; height:200px; object-fit:cover;"><div style="padding:10px; font-size:0.75rem; font-weight:bold;">${m.Title}</div>`;
            div.onclick = () => { addToVault(m.imdbID); };
            resultsDiv.appendChild(div);
        });
    }
}

async function fetchMovies() {
    let { data } = await _supabase.from('movies').select('*');
    if (!data) return;
    cachedMovies = data;
    data.sort((a, b) => {
        if (currentSort === 'title') return a.title.localeCompare(b.title);
        if (currentSort === 'year') {
            const dateA = new Date(a.year).getTime() || 0;
            const dateB = new Date(b.year).getTime() || 0;
            return dateB - dateA;
        }
        if (currentSort === 'rating') return parseFloat(b.rating) - parseFloat(a.rating);
        if (currentSort === 'runtime') return (parseInt(b.runtime) || 0) - (parseInt(a.runtime) || 0);
    });
    render(data);
}

function setSort(type) {
    currentSort = type;
    document.querySelectorAll('.sort-btn').forEach(btn => btn.classList.remove('active'));
    const btnId = type === 'title' ? 'sortAlpha' : 'sort' + type.charAt(0).toUpperCase() + type.slice(1);
    document.getElementById(btnId)?.classList.add('active');
    fetchMovies();
}

function render(movies) {
    const want = document.getElementById('wantList'); 
    const watched = document.getElementById('watchedList');
    want.innerHTML = ''; 
    watched.innerHTML = '';
    
    movies.forEach(m => {
        const html = `
            <div class="movie-card">
                <button class="remove-btn" onclick="deleteMovie('${m.imdb_id}')">✕</button>
                ${m.is_tv_show ? '<span class="tv-badge">TV</span>' : ''}
                <div class="poster-wrapper skeleton-shimmer" onclick="showDetails('${m.imdb_id}')">
                    <img class="card-poster" src="${m.poster}" onload="this.classList.add('loaded')">
                </div>
                <div class="card-content" onclick="showDetails('${m.imdb_id}')">
                    <div class="movie-title">${m.title}</div>
                    <span class="genre-tag">${m.genre}</span>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span class="runtime-text">${m.runtime}</span>
                        <span style="color:#fbbf24; font-size:0.75rem; font-weight:bold;">⭐ ${m.rating}</span>
                    </div>
                </div>
            </div>`;
        m.status === 'watched' ? watched.innerHTML += html : want.innerHTML += html;
    });
}

function pickRandomMovie() {
    const wantList = cachedMovies.filter(m => m.status === 'want');
    if (wantList.length === 0) { alert("Add some movies to your watchlist first!"); return; }
    const btn = document.getElementById('rouletteBtn');
    btn.classList.add('shuffling');
    setTimeout(() => {
        btn.classList.remove('shuffling');
        const random = wantList[Math.floor(Math.random() * wantList.length)];
        showDetails(random.imdb_id);
    }, 600);
}

// Proxy Call: Get movie details via Cloudflare Function to add to DB
async function addToVault(id) {
    const card = document.getElementById(`search-${id}`);
    if (card) card.classList.add('added-state');
    
    const res = await fetch(`/api?type=detail&id=${id}`);
    const d = await res.json();
    
    await _supabase.from('movies').upsert([{
        imdb_id: d.imdbID,
        title: d.Title,
        poster: d.Poster,
        year: d.Released,
        runtime: d.Runtime,
        rating: d.imdbRating,
        genre: d.Genre,
        status: 'want',
        is_tv_show: d.Type === 'series'
    }]);
    
    setTimeout(() => {
        document.getElementById('searchResults').classList.remove('active');
        fetchMovies();
    }, 600);
}

// Proxy Call: Get movie details via Cloudflare Function for Modal
async function showDetails(id) {
    const modal = document.getElementById('detailsModal');
    const content = document.getElementById('modalData');
    modal.style.display = 'flex';
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
    
    const { data: local } = await _supabase.from('movies').select('*').eq('imdb_id', id).single();
    
    const res = await fetch(`/api?type=detail&id=${id}`);
    const d = await res.json();
    
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(d.Title + ' trailer')}`;
    const isWatched = local?.status === 'watched';

    content.innerHTML = `
        <div class="modal-body">
            <img src="${d.Poster}" class="modal-poster">
            <div style="flex:1; width: 100%;">
                <h2 style="font-size:1.7rem; color:white; margin:0 0 5px 0;">${d.Title}</h2>
                <div style="color:var(--accent); font-weight:bold; margin-bottom:15px; font-size:0.85rem;">
                    ${d.Released} • ${d.Runtime} • ⭐ ${d.imdbRating}
                </div>
                <div class="modal-info-label">Plot Summary</div>
                <div class="modal-info-value">${d.Plot}</div>
                <div class="info-row">
                    <div>
                        <div class="modal-info-label">Director</div>
                        <div class="modal-info-value">${d.Director}</div>
                    </div>
                    <div>
                        <div class="modal-info-label">Genre</div>
                        <div class="genre-tag">${d.Genre}</div>
                    </div>
                </div>
                <div class="modal-info-label">Cast</div>
                <div class="modal-info-value">${d.Actors}</div>
                <div class="btn-group">
                    ${!isWatched ? 
                        `<button id="action-btn-${id}" onclick="updateStatus('${id}', 'watched')" class="modal-btn btn-watched">Watched</button>` : 
                        `<button id="action-btn-${id}" onclick="updateStatus('${id}', 'want')" class="modal-btn btn-restore">Restore</button>`
                    }
                    <a href="https://www.imdb.com/title/${id}/" target="_blank" class="modal-btn btn-imdb">IMDb</a>
                    <a href="${ytUrl}" target="_blank" class="modal-btn btn-yt">Trailer</a>
                </div>
            </div>
        </div>`;
}

async function updateStatus(id, s) { 
    const btn = document.getElementById(`action-btn-${id}`);
    if (btn) {
        btn.innerText = s === 'watched' ? "Archived" : "Restored";
        btn.style.backgroundColor = s === 'watched' ? "#22c55e" : "var(--accent)";
        btn.style.color = "#000";
    }
    await _supabase.from('movies').update({status: s}).eq('imdb_id', id);
    setTimeout(() => { closeModal(); fetchMovies(); }, 600);
}

async function deleteMovie(id) { if(confirm("Remove?")) { await _supabase.from('movies').delete().eq('imdb_id', id); fetchMovies(); } }

function checkPin() {
    const input = document.getElementById('pinInput').value;
    if (input === VAULT_PIN) {
        document.getElementById('authOverlay').style.display = 'none';
        document.getElementById('mainApp').style.display = 'block';
        localStorage.setItem('vault_auth', Date.now());
        fetchMovies();
    } else { 
        alert("Incorrect PIN"); 
        document.getElementById('pinInput').value = '';
    }
}

function closeModal() { 
    document.getElementById('detailsModal').style.display = 'none'; 
    document.body.classList.remove('modal-open');
}

function escapeHtml(str) {
    if (typeof str !== 'string') return str ?? '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toggleYTS() {
    const drawer = document.getElementById('ytsDrawer');
    const btn = document.getElementById('ytsToggleBtn');
    const isOpen = drawer.classList.toggle('open');
    btn.classList.toggle('open', isOpen);
    btn.textContent = isOpen ? 'Close ▴' : 'Browse ▾';
    if (isOpen && document.getElementById('ytsList').children.length === 0) {
        fetchYTS(1);
    }
}

function setYTSQuality(el, quality) {
    ytsQuality = quality;
    document.querySelectorAll('.yts-filter-btn').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    fetchYTS(1);
}

async function fetchYTS(page) {
    ytsPage = page;
    const genre  = document.getElementById('ytsGenre').value;
    const sortBy = document.getElementById('ytsSort').value;
    const list   = document.getElementById('ytsList');
    const loadMoreBtn = document.getElementById('ytsLoadMore');

    if (page === 1) {
        list.innerHTML = Array(YTS_LIMIT)
            .fill('<div class="movie-card skeleton-shimmer" style="aspect-ratio:2/3;"></div>')
            .join('');
        loadMoreBtn.style.display = 'none';
    }

    const params = new URLSearchParams({ limit: YTS_LIMIT, page, sort_by: sortBy, order_by: 'desc' });
    if (genre) params.set('genre', genre);
    if (ytsQuality) params.set('quality', ytsQuality);

    try {
        const res  = await fetch(`${YTS_BASE}?${params}`);
        const json = await res.json();

        if (json.status !== 'ok' || !json.data?.movies?.length) {
            if (page === 1) list.innerHTML = '<p style="color:#64748b; padding:20px 0;">No movies found for these filters.</p>';
            loadMoreBtn.style.display = 'none';
            return;
        }

        ytsTotalCount = json.data.movie_count;
        if (page === 1) list.innerHTML = '';
        json.data.movies.forEach(m => list.appendChild(buildYTSCard(m)));

        const loaded = page * YTS_LIMIT;
        loadMoreBtn.style.display = loaded < ytsTotalCount ? 'block' : 'none';
        loadMoreBtn.classList.remove('loading');
    } catch (err) {
        if (page === 1) list.innerHTML = '<p style="color:#ef4444; padding:20px 0;">Failed to load YTS movies. Please try again.</p>';
        loadMoreBtn.style.display = 'none';
    }
}

function loadMoreYTS() {
    document.getElementById('ytsLoadMore').classList.add('loading');
    fetchYTS(ytsPage + 1);
}

function buildYTSCard(m) {
    ytsCache[m.id] = m;
    const qualities = (m.torrents || []).map(t => t.quality);
    const bestQuality = ['2160p','1080p','720p','3D'].find(q => qualities.includes(q)) || qualities[0] || '?';
    const maxSeeds = Math.max(...(m.torrents || []).map(t => t.seeds || 0), 0);

    const card = document.createElement('div');
    card.className = 'movie-card';
    card.innerHTML = `
        <div class="poster-wrapper skeleton-shimmer" onclick="showTorrentModal(${m.id})">
            <img class="card-poster"
                 src="${escapeHtml(m.medium_cover_image)}"
                 alt="${escapeHtml(m.title)}"
                 onload="this.classList.add('loaded')"
                 onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22180%22 height=%22270%22%3E%3Crect fill=%22%231e293b%22 width=%22180%22 height=%22270%22/%3E%3C/svg%3E'">
            <span class="yts-quality-badge">${escapeHtml(bestQuality)}</span>
        </div>
        <div class="card-content" onclick="showTorrentModal(${m.id})">
            <div class="movie-title">${escapeHtml(m.title)}</div>
            <span class="genre-tag">${escapeHtml((m.genres || ['Unknown'])[0])}</span>
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="runtime-text">${m.year}</span>
                <span style="color:#fbbf24; font-size:0.75rem; font-weight:bold;">⭐ ${m.rating}</span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                <span class="yts-seeds">▲ ${maxSeeds.toLocaleString()}</span>
                <span style="font-size:0.65rem; color:#64748b;">${m.runtime ? m.runtime + ' min' : ''}</span>
            </div>
        </div>`;
    return card;
}

function showTorrentModal(ytsId) {
    const modal = document.getElementById('torrentModal');
    const data  = document.getElementById('torrentModalData');
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');

    const movie = ytsCache[ytsId];
    if (!movie) {
        data.innerHTML = '<p style="padding:20px; color:#64748b;">Loading...</p>';
        fetch(`https://yts.lt/api/v2/movie_details.json?movie_id=${ytsId}&with_images=true`)
            .then(r => r.json())
            .then(json => {
                if (json.data?.movie) { ytsCache[ytsId] = json.data.movie; renderTorrentModal(json.data.movie); }
                else data.innerHTML = '<p style="color:#ef4444;">Could not load details.</p>';
            })
            .catch(() => { data.innerHTML = '<p style="color:#ef4444;">Network error.</p>'; });
        return;
    }
    renderTorrentModal(movie);
}

function renderTorrentModal(m) {
    const data = document.getElementById('torrentModalData');
    const alreadyInVault = cachedMovies.some(
        cm => cm.title.toLowerCase() === m.title.toLowerCase() && String(cm.year) === String(m.year)
    );

    const qualityOrder = ['2160p','1080p','720p','3D'];
    const torrentRows = (m.torrents || [])
        .slice()
        .sort((a, b) => {
            const ai = qualityOrder.indexOf(a.quality);
            const bi = qualityOrder.indexOf(b.quality);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        })
        .map(t => {
            const magnet = buildMagnet(t.hash, m.title);
            return `
            <div class="torrent-row">
                <span class="torrent-quality-label">${escapeHtml(t.quality)}</span>
                <div class="torrent-meta">
                    <span>${escapeHtml(t.type || '')} • ${escapeHtml(t.size || '')}</span>
                    <span class="seeds-text">▲ ${(t.seeds||0).toLocaleString()} seeds</span>
                    <span class="peers-text">● ${(t.peers||0).toLocaleString()} peers</span>
                </div>
                <div class="torrent-actions">
                    <a href="${escapeHtml(t.url)}" class="torrent-dl-btn btn-torrent">↓ .torrent</a>
                    <a href="${escapeHtml(magnet)}" class="torrent-dl-btn btn-magnet">⚡ Magnet</a>
                </div>
            </div>`;
        }).join('');

    data.innerHTML = `
        <div class="torrent-movie-header">
            <img class="torrent-poster" src="${escapeHtml(m.medium_cover_image)}" alt="${escapeHtml(m.title)}">
            <div>
                <h2 style="font-size:1.3rem; margin:0 0 6px 0; color:white;">${escapeHtml(m.title)}</h2>
                <div style="color:var(--accent); font-size:0.8rem; font-weight:700; margin-bottom:10px;">
                    ${m.year} • ⭐ ${m.rating} • ${m.runtime ? m.runtime + ' min' : 'N/A'}
                </div>
                <span class="genre-tag">${escapeHtml((m.genres||['Unknown'])[0])}</span>
            </div>
        </div>
        <div class="modal-info-label">Available Torrents</div>
        <div class="torrent-list">${torrentRows || '<p style="color:#64748b;">No torrents available.</p>'}</div>
        <button
            id="yts-add-btn-${m.id}"
            class="torrent-add-watchlist-btn"
            onclick="addYTSToVault(${m.id})"
            ${alreadyInVault ? 'disabled' : ''}>
            ${alreadyInVault ? '✓ Already in Watchlist' : '＋ Add to Watchlist'}
        </button>`;
}

function buildMagnet(hash, title) {
    return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${MAGNET_TRACKERS}`;
}

function closeTorrentModal() {
    document.getElementById('torrentModal').style.display = 'none';
    document.body.classList.remove('modal-open');
}

async function addYTSToVault(ytsId) {
    const btn = document.getElementById(`yts-add-btn-${ytsId}`);
    const m   = ytsCache[ytsId];
    if (!m || !btn) return;

    btn.textContent = 'Adding...';
    btn.disabled = true;

    await _supabase.from('movies').upsert([{
        imdb_id:    m.imdb_code || `yts-${ytsId}`,
        title:      m.title,
        poster:     m.large_cover_image || m.medium_cover_image,
        year:       String(m.year),
        runtime:    m.runtime ? `${m.runtime} min` : 'N/A',
        rating:     String(m.rating),
        genre:      (m.genres || ['Unknown'])[0],
        status:     'want',
        is_tv_show: false
    }]);

    btn.textContent = '✓ Added to Watchlist';
    btn.style.backgroundColor = '#22c55e';
    fetchMovies();
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