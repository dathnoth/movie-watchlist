export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const type = searchParams.get('type');

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // YTS proxy
  if (type === 'yts_list') {
    const params = new URLSearchParams();
    for (const [k, v] of searchParams) {
      if (k !== 'type') params.set(k, v);
    }
    const response = await fetch(`https://yts.lt/api/v2/list_movies.json?${params}`);
    const data = await response.json();
    return new Response(JSON.stringify(data), { headers: corsHeaders });
  }

  if (type === 'yts_detail') {
    const id = searchParams.get('movie_id');
    const response = await fetch(`https://yts.lt/api/v2/movie_details.json?movie_id=${id}&with_images=true`);
    const data = await response.json();
    return new Response(JSON.stringify(data), { headers: corsHeaders });
  }

  // OMDB proxy
  const query = searchParams.get('q');
  const id = searchParams.get('id');
  const API_KEY = context.env.OMDB_API_KEY;

  let url = '';
  if (type === 'search') {
    url = `https://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${API_KEY}`;
  } else if (type === 'detail') {
    url = `https://www.omdbapi.com/?i=${id}&apikey=${API_KEY}&plot=short`;
  }

  const response = await fetch(url);
  const data = await response.json();

  return new Response(JSON.stringify(data), { headers: corsHeaders });
}