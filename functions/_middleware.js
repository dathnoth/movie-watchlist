// The app moved to its own domain. The old address forwards people there, but
// /api stays put so Dodo keeps working wherever it's pointed. Matching the exact
// host leaves preview deployments (<hash>.movie-watchlist-140.pages.dev) alone.
const OLD_HOST = 'movie-watchlist-140.pages.dev';
const NEW_ORIGIN = 'https://movies.danielthompson.digital';

export function onRequest({ request, next }) {
  const url = new URL(request.url);
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  const isRead = request.method === 'GET' || request.method === 'HEAD';

  if (url.hostname === OLD_HOST && !isApi && isRead) {
    // 302 rather than 301, so browsers don't remember it forever.
    return Response.redirect(`${NEW_ORIGIN}${url.pathname}${url.search}`, 302);
  }
  return next();
}
