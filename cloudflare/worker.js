import { onRequest } from '../functions/api/visits.js';

/** Cloudflare Pages advanced mode; document conversion stays in the browser. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/visits') return onRequest({ request, env });
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Static resources accept GET and HEAD only.', {
        status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
