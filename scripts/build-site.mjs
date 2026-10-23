// Builds the GitHub Pages site into _site/: the landing page from site/, and docs.html from the
// README (everything from "## How it works" on), so the docs never drift from it.
//   node scripts/build-site.mjs && npx serve _site
import { Marked } from "marked";
import { gfmHeadingId, getHeadingList } from "marked-gfm-heading-id";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "_site");
const REPO = "https://github.com/vitafortis/debrief";

const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
const start = readme.indexOf("\n## How it works");
if (start < 0) throw new Error('README has no "## How it works" heading to start the docs from');

const marked = new Marked(gfmHeadingId());
let html = marked.parse(readme.slice(start));

html = html
  // Images live next to the page on the site.
  .replace(/(src=")docs\/(screenshots\/|logo\.svg)/g, "$1$2")
  // Other relative links (.env.example, LICENSE) point into the repo.
  .replace(/href="(?!https?:|#|mailto:)([^"]+)"/g, `href="${REPO}/blob/main/$1"`)
  .replace(/<table>/g, '<div class="table"><table>')
  .replace(/<\/table>/g, "</table></div>")
  .replace(/<(h[23]) id="([^"]+)">(.*?)<\/\1>/g, '<$1 id="$2">$3<a class="anchor" href="#$2" aria-hidden="true">#</a></$1>');

// Table of contents: every h2, with its h3s nested under it.
const toc = [];
for (const h of getHeadingList()) {
  if (h.level === 2) toc.push({ ...h, children: [] });
  else if (h.level === 3 && toc.length) toc.at(-1).children.push(h);
}
const item = (h) => `<li><a href="#${h.id}">${h.text}</a>`;
const tocHtml = `<ul>${toc
  .map((h) => item(h) + (h.children.length ? `<ul>${h.children.map((c) => item(c) + "</li>").join("")}</ul>` : "") + "</li>")
  .join("")}</ul>`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp(path.join(ROOT, "site"), OUT, { recursive: true });
await cp(path.join(ROOT, "docs/screenshots"), path.join(OUT, "screenshots"), { recursive: true });
await cp(path.join(ROOT, "docs/logo.svg"), path.join(OUT, "logo.svg"));

const template = await readFile(path.join(ROOT, "site/docs.html"), "utf8");
await writeFile(
  path.join(OUT, "docs.html"),
  template.replace("<!-- toc -->", tocHtml).replace("<!-- content -->", html),
);
await writeFile(path.join(OUT, ".nojekyll"), "");
console.log(`Built ${path.relative(ROOT, OUT)}/`);
