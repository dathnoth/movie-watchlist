const API_KEY = '443ae32b';
const SUPABASE_URL = 'https://xsranuxnftbpuzciyiia.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcmFudXhuZnRicHV6Y2l5aWlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2ODg2MzEsImV4cCI6MjA4NzI2NDYzMX0.aFrjE_wenjQ0cGE0wXDZEdqb4tptfOJ70AFZRDu0yfc';
const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let debounceTimer;
let currentSort = 'title';

// --- AUTH LOGIC ---
const VAULT_PIN = '1234'; 

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

window.onload = () => {
    const lastAuth = localStorage.getItem('vault_auth');
    if (lastAuth && (Date.now() - lastAuth < 86400000)) {
        document.getElementById('authOverlay').style.display = 'none';
        document.getElementById('mainApp').style.display = 'block';
        fetchMovies();
    }
};

// --- SEARCH LOGIC ---
document.getElementById('movieInput').addEventListener('input', (e) => {
    const clearBtn = document.getElementById('clearSearch');
    const resultsDiv = document.getElementById('searchResults');
    clearBtn.style.display = e.target.value.length > 0 ? 'block' : 'none';

    clearTimeout(debounceTimer);
    const q = e.target.value;
    if (q.length < 3) { resultsDiv.classList.remove('active'); resultsDiv.innerHTML = ''; return; }
    
    resultsDiv.classList.add('active');
    resultsDiv.innerHTML = Array(6).fill('<div class="search-result-item skeleton"></div>').join('');
    debounceTimer = setTimeout(() => liveSearch(q), 300);
});

document.getElementById('clearSearch').addEventListener('click', () => {
    const input = document.getElementById('movieInput');
    input.value = '';
    document.getElementById('clearSearch').style.display = 'none';
    document.getElementById('searchResults').classList.remove('active');
    input.focus();
});

async function liveSearch(query) {
    const res = await fetch(`https://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${API_KEY}`);
    const data = await res.json();
    const resultsDiv = document.getElementById('searchResults');
    resultsDiv.innerHTML = '';
    
    if (data.Search) {
        data.Search.slice(0, 10).forEach(m => {
            const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(m.Title + ' ' + m.Year + ' trailer')}`;
            const div = document.createElement('div');
            div.className = 'search-result-item';
            div.innerHTML = `
                <img src="${m.Poster !== 'N/A' ? m.Poster : 'https://via.placeholder.com/160x240'}" alt="p">
                <div class="search-overlay">
                    <div class="search-title">${m.Title}</div>
                    <div class="search-year">${m.Year}</div>
                    <div class="search-btn-group">
                        <button class="overlay-btn btn-add" onclick="event.stopPropagation(); addToVault('${m.imdbID}')">+ List</button>
                        <a href="${ytUrl}" target="_blank" class="overlay-btn btn-trailer" onclick="event.stopPropagation()">▶ Trailer</a>
                    </div>
                </div>`;
            div.onclick = () => showDetails(m.imdbID);
            resultsDiv.appendChild(div);
        });
    }
}

// --- DATABASE & RENDER ---
async function fetchMovies() {
    let { data, error } = await _supabase.from('movies').select('*');
    if (error) return;

    data.sort((a, b) => {
        if (currentSort === 'title') return a.title.localeCompare(b.title);
        if (currentSort === 'year') return parseInt(b.year) - parseInt(a.year);
        if (currentSort === 'rating') return parseFloat(b.rating) - parseFloat(a.rating);
        if (currentSort === 'runtime') {
            const timeA = parseInt(a.runtime) || 0;
            const timeB = parseInt(b.runtime) || 0;
            return timeB - timeA; // Longest first
        }
    });
    render(data);
}

function setSort(type) {
    currentSort = type;
    document.querySelectorAll('.sort-btn').forEach(btn => btn.classList.remove('active'));
    if(type === 'title') document.getElementById('sortAlpha').classList.add('active');
    if(type === 'year') document.getElementById('sortYear').classList.add('active');
    if(type === 'rating') document.getElementById('sortRating').classList.add('active');
    if(type === 'runtime') document.getElementById('sortRuntime').classList.add('active');
    fetchMovies();
}

function render(movies) {
    const want = document.getElementById('wantList'); 
    const watched = document.getElementById('watchedList');
    want.innerHTML = ''; 
    watched.innerHTML = '';
    
    movies.forEach(m => {
        const isW = m.status === 'watched';
        const html = `
            <div class="movie-card">
                <button class="remove-btn" onclick="deleteMovie('${m.imdb_id}')">✕</button>
                <div class="poster-wrapper" onclick="showDetails('${m.imdb_id}')">
                    <img class="card-poster" src="${m.poster}" alt="${m.title}">
                </div>
                <div class="card-content">
                    <div class="movie-title" onclick="showDetails('${m.imdb_id}')">${m.title}</div>
                    <div class="genre-tag">${m.genre || 'Film'}</div>
                    <div class="runtime-text">${m.runtime || ''}</div>
                    <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#94a3b8;">
                        <span>${m.year}</span><span style="color:#fbbf24;">⭐ ${m.rating}</span>
                    </div>
                </div>
            </div>`;
        isW ? watched.innerHTML += html : want.innerHTML += html;
    });
}

// --- HELPERS ---
async function addToVault(id) {
    const res = await fetch(`https://www.omdbapi.com/?i=${id}&apikey=${API_KEY}`);
    const d = await res.json();
    const movie = { imdb_id: d.imdbID, title: d.Title, poster: d.Poster, year: d.Year, runtime: d.Runtime, rating: d.imdbRating, genre: d.Genre, status: 'want' };
    await _supabase.from('movies').upsert([movie]);
    fetchMovies(); notify("Added!", "#22c55e");
}

async function showDetails(id) {
    const modal = document.getElementById('detailsModal');
    const content = document.getElementById('modalData');
    modal.style.display = 'flex';

    content.innerHTML = `
        <div class="modal-body">
            <div class="skeleton" style="width:220px; height:330px; border-radius:16px; flex-shrink:0;"></div>
            <div style="flex:1; width:100%;">
                <div class="skeleton" style="width:70%; height:30px; margin-bottom:15px;"></div>
                <div class="skeleton" style="width:40%; height:20px; margin-bottom:25px;"></div>
                <div class="skeleton" style="width:100%; height:15px; margin-bottom:8px;"></div>
                <div class="skeleton" style="width:100%; height:15px; margin-bottom:8px;"></div>
                <div class="skeleton" style="width:60%; height:15px; margin-bottom:25px;"></div>
                <div style="display:flex; gap:10px;">
                    <div class="skeleton" style="flex:1; height:45px; border-radius:12px;"></div>
                    <div class="skeleton" style="flex:1; height:45px; border-radius:12px;"></div>
                    <div class="skeleton" style="flex:1; height:45px; border-radius:12px;"></div>
                </div>
            </div>
        </div>`;
    
    const { data: local } = await _supabase.from('movies').select('*').eq('imdb_id', id).single();
    const res = await fetch(`https://www.omdbapi.com/?i=${id}&apikey=${API_KEY}&plot=short`);
    const d = await res.json();
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(d.Title + ' ' + d.Year + ' trailer')}`;
    const isWatched = local?.status === 'watched';

    content.innerHTML = `
        <div class="modal-body">
            <img src="${d.Poster}" class="modal-poster">
            <div style="flex:1; width: 100%;">
                <h2 style="border:none; padding:0; font-size:1.5rem; color:white; margin:0 0 5px 0; padding-right: 30px;">${d.Title}</h2>
                <div style="color:var(--accent); font-weight:bold; margin-bottom:12px; font-size:0.8rem;">${d.Year} • ${d.Runtime} • ⭐ ${d.imdbRating}</div>
                
                <div class="modal-info-label">Plot Summary</div>
                <div class="modal-info-value">${d.Plot}</div>
                
                <div class="info-row">
                    <div>
                        <div class="modal-info-label">Director</div>
                        <div class="modal-info-value">${d.Director}</div>
                    </div>
                </div>

                <div class="modal-info-label">Cast</div>
                <div class="modal-info-value">${d.Actors}</div>

                <div class="btn-group">
                    ${!isWatched ? `<button onclick="updateStatus('${id}', 'watched')" class="modal-btn btn-watched">✅ Watched</button>` : ''}
                    <a href="https://www.imdb.com/title/${id}/" target="_blank" class="modal-btn btn-imdb">IMDb</a>
                    <a href="${ytUrl}" target="_blank" class="modal-btn btn-yt">Trailer</a>
                </div>
            </div>
        </div>`;
}

async function updateStatus(id, newStatus) {
    await _supabase.from('movies').update({status: newStatus}).eq('imdb_id', id);
    closeModal(); fetchMovies(); notify("Archived!", "#22c55e");
}

function notify(text, color) {
    const m = document.getElementById('msg');
    m.innerText = text; m.style.backgroundColor = color;
    m.style.display = 'block'; setTimeout(() => m.style.display = 'none', 2500);
}

function closeModal() { document.getElementById('detailsModal').style.display = 'none'; }
async function deleteMovie(id) { if(confirm("Remove?")) { await _supabase.from('movies').delete().eq('imdb_id', id); fetchMovies(); } }