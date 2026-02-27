export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const type = searchParams.get('type'); // 'search' or 'detail'
  const query = searchParams.get('q');
  const id = searchParams.get('id');

  // Grab the secret key you added to the Cloudflare Dashboard
  const API_KEY = context.env.OMDB_API_KEY;

  let url = '';
  if (type === 'search') {
    url = `https://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${API_KEY}`;
  } else if (type === 'detail') {
    url = `https://www.omdbapi.com/?i=${id}&apikey=${API_KEY}&plot=short`;
  }

  const response = await fetch(url);
  const data = await response.json();

  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}