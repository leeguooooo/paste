// Markdown for Agents — when an AI agent requests the homepage with
// `Accept: text/markdown`, return a markdown description of paste instead of
// the SPA HTML. Everything else (assets, SPA routes) falls through to the
// static site via next(), so _headers/_redirects keep working.
const HOMEPAGE_MARKDOWN = `# paste — 在线剪贴板 / open-source clipboard

paste (Pastyx) is an open-source, local-first clipboard manager for macOS and
Web. Copy on one device, access it everywhere — search, favorite, tag, and
optionally sync via Cloudflare Workers + D1.

## Links
- Web app: https://paste.leeguoo.com/
- API (OpenAPI): https://pasteapi.leeguoo.com/openapi.json
- API catalog: https://paste.leeguoo.com/.well-known/api-catalog
- Author: 郭立 (Guo Li / Leo / leeguoo) — https://leeguoo.com/about
- GitHub: https://github.com/leeguooooo

## Features
- Cross-device clipboard history with instant search
- Favorites, tags, and quick filters
- Local-first; optional end-to-end sync (Cloudflare Workers + D1)
- macOS native app + web client
`

export async function onRequest(context) {
  const { request, next } = context
  try {
    const url = new URL(request.url)
    const accept = (request.headers.get('accept') || '').toLowerCase()
    if (url.pathname === '/' && (accept.includes('text/markdown') || accept.includes('text/x-markdown'))) {
      return new Response(HOMEPAGE_MARKDOWN, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          vary: 'Accept',
          'cache-control': 'public, max-age=300',
        },
      })
    }
  } catch {
    // fall through to the static site on any error
  }
  return next()
}
