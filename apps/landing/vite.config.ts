import { defineConfig } from "vite";

const normalizeSiteUrl = (value: string): string => value.replace(/\/+$/, "");

const siteUrl = normalizeSiteUrl(process.env.PASTE_SITE_URL || "https://paste.misonote.com");
const ogImageUrl = process.env.PASTE_OG_IMAGE_URL || `${siteUrl}/icon-512.svg`;
const githubUrl = process.env.PASTE_GITHUB_URL || "https://github.com/leeguooooo/paste";

const makeSitemapXml = (baseUrl: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;

export default defineConfig({
  plugins: [
    {
      name: "paste-seo",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return html
            .replaceAll("__SITE_URL__", siteUrl)
            .replaceAll("__OG_IMAGE_URL__", ogImageUrl)
            .replaceAll("__GITHUB_URL__", githubUrl);
        },
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "robots.txt",
          source: `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`,
        });
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source: makeSitemapXml(siteUrl),
        });
      },
    },
    {
      name: "fix-css-link-href-quote",
      // Work around a malformed stylesheet link tag in the generated HTML:
      //   href="/assets/index-XXXX.css">
      // Missing the closing quote can cause the browser to ignore the stylesheet.
      transformIndexHtml: {
        order: "post",
        handler(html) {
          return html.replace(/(href="[^">]+\\.css)>/g, '$1">');
        },
      },
    },
  ],
});
