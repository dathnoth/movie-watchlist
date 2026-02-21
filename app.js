const API_KEY = '443ae32b';
const SUPABASE_URL = 'https://xsranuxnftbpuzciyiia.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcmFudXhuZnRicHV6Y2l5aWlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2ODg2MzEsImV4cCI6MjA4NzI2NDYzMX0.aFrjE_wenjQ0cGE0wXDZEdqb4tptfOJ70AFZRDu0yfc';
const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let debounceTimer;

function notify(text, color) {
    const m = document.getElementById('msg');
    m.innerText = text; m.style.backgroundColor = color;
    m.style.display = 'block'; setTimeout(() => m.style.display = 'none', 2500);
}

function scrollToSection(id, btnId) {
    document.getElementById(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('.nav-toggle button').forEach(b => b.classList.remove('active'));
    document.getElementById(btnId).classList.add('active');
}

document.getElementById('movieInput').addEventListener('input', (e) => {
    const resultsDiv = document.getElementById('searchResults');
    clearTimeout(debounceTimer);
    const q = e.target.value;
    if (q.length < 3) { resultsDiv.classList.remove('active'); resultsDiv.innerHTML = ''; return; }
    resultsDiv.classList.add('active');
    resultsDiv.innerHTML = Array(6).fill('<div class="search-result-item skeleton"></div>').join('');
    debounceTimer = setTimeout(() => liveSearch(q), 300);
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
                    <button class="overlay-btn btn-add" onclick="event.stopPropagation(); addToVault('${m.imdbID}')">+ Watchlist</button>
                    <a href="${ytUrl}" target="_blank" class="overlay-btn btn-trailer" onclick="event.stopPropagation()">▶ Trailer</a>
                </div>`;
            div.onclick = () => showDetails(m.imdbID);
            resultsDiv.appendChild(div);
        });
    }
}

async function addToVault(id) {
    const res = await fetch(`https://www.omdbapi.com/?i=${id}&apikey=${API_KEY}`);
    const d = await res.json();
    const movie = { imdb_id: d.imdbID, title: d.Title, poster: d.Poster, year: d.Year, runtime: d.Runtime, rating: d.imdbRating, director: d.Director, genre: d.Genre, status: 'want', my_stars: 0 };
    const { error } = await _supabase.from('movies').upsert([movie], { onConflict: 'imdb_id' });
    if (!error) { notify(`Added!`, '#22c55e'); fetchMovies(); }
}

async function showDetails(id) {
    const modal = document.getElementById('detailsModal');
    const content = document.getElementById('modalData');
    modal.style.display = 'flex';
    content.innerHTML = '<div style="text-align:center; width:100%; padding:40px;"><div class="skeleton" style="height:300px; width:180px;"></div></div>';
    const { data: local } = await _supabase.from('movies').select('*').eq('imdb_id', id).single();
    const res = await fetch(`https://www.omdbapi.com/?i=${id}&apikey=${API_KEY}&plot=short`);
    const d = await res.json();
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(d.Title + ' ' + d.Year + ' trailer')}`;
    const isWatched = local?.status === 'watched';

    content.innerHTML = `
        <div class="modal-body">
            <img src="${d.Poster}" class="modal-poster">
            <div style="flex:1;">
                <h2 style="border:none; padding:0; font-size:1.6rem; color:white; margin:0 0 10px 0;">${d.Title}</h2>
                <div style="color:var(--accent); font-weight:bold; margin-bottom:15px;">${d.Year} • ${d.Runtime} • ⭐ ${d.imdbRating}</div>
                <div class="genre-tag" style="background:rgba(255,255,255,0.05); color:white; margin-bottom:15px;">${d.Genre}</div>
                <p style="color:#cbd5e1; font-size:0.95rem; line-height:1.6;">${d.Plot}</p>
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
    closeModal(); fetchMovies(); notify(`Archived!`, '#22c55e');
}

function closeModal() { document.getElementById('detailsModal').style.display = 'none'; }
async function fetchMovies() { const { data } = await _supabase.from('movies').select('*'); if (data) render(data); }
async function deleteMovie(id) { if(confirm("Remove?")) { await _supabase.from('movies').delete().eq('imdb_id', id); fetchMovies(); } }

function render(movies) {
    const want = document.getElementById('wantList'); const watched = document.getElementById('watchedList');
    want.innerHTML = ''; watched.innerHTML = '';
    movies.forEach(m => {
        const isW = m.status === 'watched';
        const html = `<div class="movie-card">
            <button class="remove-btn" onclick="deleteMovie('${m.imdb_id}')">✕</button>
            <div class="poster-wrapper" onclick="showDetails('${m.imdb_id}')"><img class="card-poster" src="${m.poster}"></div>
            <div class="card-content">
                <div class="movie-title" onclick="showDetails('${m.imdb_id}')">${m.title}</div>
                <div class="genre-tag">${m.genre || 'Film'}</div>
                <div class="runtime-text">${m.runtime || ''}</div>
                <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#94a3b8;">
                    <span>${m.year}</span><span style="color:#fbbf24;">⭐ ${m.rating}</span>
                </div>
                ${isW ? renderStars(m) : ''}
            </div>
        </div>`;
        isW ? watched.innerHTML += html : want.innerHTML += html;
    });
}

function renderStars(m) {
    let h = '<div class="stars">';
    for (let i = 1; i <= 5; i++) h += `<span onclick="updateMovieStar('${m.imdb_id}', ${i})" style="cursor:pointer">${i <= m.my_stars ? '★' : '☆'}</span>`;
    return h + '</div>';
}

async function updateMovieStar(id, stars) {
    await _supabase.from('movies').update({my_stars: stars}).eq('imdb_id', id);
    fetchMovies();
}

fetchMovies();