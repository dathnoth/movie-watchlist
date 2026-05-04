// URLs are fine to stay public, but sensitive keys are now handled via Proxy or RLS
const SUPABASE_URL = 'https://xsranuxnftbpuzciyiia.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcmFudXhuZnRicHV6Y2l5aWlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2ODg2MzEsImV4cCI6MjA4NzI2NDYzMX0.aFrjE_wenjQ0cGE0wXDZEdqb4tptfOJ70AFZRDu0yfc';
const { createClient } = supabase;

let debounceTimer;
let currentSort = 'title';
let cachedMovies = [];
const VAULT_PIN = '0234';


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
        const watchedLine = m.status === 'watched' && m.watched_at
            ? `<div style="font-size:0.65rem; color:#64748b; margin-top:4px;">Watched ${new Date(m.watched_at + 'T00:00:00').toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'})}</div>`
            : '';
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
                    ${watchedLine}
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
    
    let local = null, d = null;
    try {
        const [supaRes, apiRes] = await Promise.all([
            _supabase.from('movies').select('*').eq('imdb_id', id).single(),
            fetch(`/api?type=detail&id=${id}`)
        ]);
        local = supaRes.data;
        d = await apiRes.json();
    } catch (err) {
        content.innerHTML = '<p style="color:#f87171; padding:20px;">Failed to load movie details. Please try again.</p>';
        return;
    }
    if (!d || !d.Title) {
        content.innerHTML = '<p style="color:#f87171; padding:20px;">Movie details not available.</p>';
        return;
    }
    
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
    const watchedAt = s === 'watched' ? new Date().toISOString().split('T')[0] : null;
    await _supabase.from('movies').update({status: s, watched_at: watchedAt}).eq('imdb_id', id);
    setTimeout(() => { closeModal(); fetchMovies(); }, 600);
}

async function deleteMovie(id) { if(confirm("Remove?")) { await _supabase.from('movies').delete().eq('imdb_id', id); fetchMovies(); } }

function checkPin() {
    const boxes = document.querySelectorAll('.pin-box');
    const pin = Array.from(boxes).map(b => b.value).join('');
    const errorEl = document.getElementById('pinError');

    if (pin === VAULT_PIN) {
        boxes.forEach(b => b.classList.add('loading'));
        setTimeout(() => {
            document.getElementById('authOverlay').style.display = 'none';
            document.getElementById('mainApp').style.display = 'block';
            localStorage.setItem('vault_auth', Date.now());
            boxes.forEach(b => { b.value = ''; b.classList.remove('loading'); });
            fetchMovies();
        }, 400);
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
                if (i < boxes.length - 1) {
                    boxes[i + 1].focus();
                } else {
                    checkPin();
                }
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
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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