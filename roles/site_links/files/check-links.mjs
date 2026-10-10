#!/usr/bin/env node
/**
 * Does every link on the site still go somewhere?
 *
 *   node check-links.mjs --base=https://site.bhreco.app
 *   node check-links.mjs --base=... --canonical=bhamre.co --name=bhreco --notify --out=/var/lib/site-links
 *   node check-links.mjs --base=... --max-pages=10        a quick look, for trying it out
 *
 * WHY. Every other gate compares a site with itself: fixtures with the CMS,
 * one render with another. None asks whether a link a visitor can click goes
 * anywhere. The bhreco utilities list sat with two links to domains that did
 * not exist for seven months, and the first content check found ten more.
 * This crawls the site as a visitor gets it, so a broken link is found wherever
 * it lives: in the code, in the CMS, in an article body.
 *
 * WHAT IT READS. The site's sitemap, then every page in it, then every link
 * (<a href>) on those pages. A sitemap written for the site's future address
 * (bhreco's lists bhamre.co while that still points at the old site) is mapped
 * onto --base, and links to any --canonical host count as the site's own.
 *
 * FOUR ANSWERS, NOT TWO. Some sites refuse scripts, so "it did not answer" is
 * not "it is broken":
 *
 *   dead        the domain does not exist, the page answers 404 or 410, or the
 *               certificate has expired. Certain. One of these fails the run.
 *               A page of our own that answers 4xx or 5xx is dead too.
 *   moved       an outside link lands on a different site. Usually a rebrand.
 *   unchecked   the site would not answer a script (403, 429, a timeout).
 *               Says nothing about the link. A person clicks it.
 *   fine
 *
 * IT CHANGES NOTHING, and it always reports when --notify is given: it runs
 * weekly, and a weekly check that is silent when nothing is wrong is
 * indistinguishable from one that stopped running.
 *
 * No dependencies: Node 20 or newer, nothing else. It lives in the ansible role
 * site_links and nowhere else, so there is one copy to keep right.
 *
 * Exit: 0 nothing dead, 1 something dead, 2 could not run or could not report.
 */
import { setDefaultResultOrder } from "node:dns";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// IPv4 first. gmktron's DNS answers with IPv6 addresses it cannot route, and
// when Node's fallback to IPv4 was slow the connection timed out: the run of
// 2026-10-06 19:14 UTC failed to read the sitemap (ETIMEDOUT) while curl over
// IPv4 answered in 0.15 s. A host with working IPv6 loses nothing by this.
setDefaultResultOrder("ipv4first");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = (arg("base", process.env.SITE_LINKS_BASE) ?? "").replace(/\/+$/, "");
const SITEMAP = arg("sitemap", "/sitemap.xml");
const CANONICAL = (arg("canonical", "") || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const NAME = arg("name", BASE.replace(/^https?:\/\//, ""));
const OUT = arg("out", "");
const KEEP = Number(arg("keep", "12"));
const MAX_PAGES = Number(arg("max-pages", "0"));
const NOTIFY = process.argv.includes("--notify");
const NTFY_URL = process.env.NTFY_URL;
const NTFY_TOKEN = process.env.NTFY_TOKEN;

if (!/^https?:\/\//.test(BASE)) {
  console.error("check-links: --base=https://… is required");
  process.exit(2);
}

/** A browser's, because a good half of outside sites answer 403 to anything else. */
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en" };
const TIMEOUT_MS = 25_000;
/** Eight at a time overall, never more than two at one outside host. */
const CONCURRENCY = 8;
const PER_HOST = 2;

const baseHost = new URL(BASE).host.toLowerCase();
const host = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};
const isOwn = (url) => {
  const h = host(url);
  return h === baseHost || CANONICAL.includes(h);
};
/** One of ours, at the address this run checks. */
const onBase = (url) => {
  const u = new URL(url);
  return `${BASE}${u.pathname}${u.search}`;
};

/* ─────────────────────────── fetching ─────────────────────────── */

function reasonOf(error) {
  const code = error?.cause?.code ?? error?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { verdict: "dead", detail: "the domain does not exist" };
  if (error?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return { verdict: "unchecked", detail: "no answer within 25 seconds" };
  }
  // A browser stops a visitor at an expired certificate. Other certificate
  // errors are not certain: a server missing its intermediate fails here and
  // works in a browser, which fetches it.
  if (code === "CERT_HAS_EXPIRED") return { verdict: "dead", detail: "its certificate has expired" };
  if (/CERT|SSL|TLS|VERIFY/i.test(code)) return { verdict: "unchecked", detail: `certificate not verifiable by a script (${code})` };
  return { verdict: "unchecked", detail: `could not connect (${code || error?.message || "unknown"})` };
}

async function get(url, { body = false } = {}) {
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const html = body && /html|xml/.test(res.headers.get("content-type") ?? "") ? await res.text() : "";
    if (!body) await res.body?.cancel().catch(() => {});
    return { status: res.status, finalUrl: res.url, html };
  } catch (error) {
    return { error: reasonOf(error) };
  }
}

/** A link's verdict. Twice before believing a failure: one bad afternoon is not a dead link. */
async function check(url) {
  let got = await get(url);
  if (got.error || got.status >= 500) got = await get(url);
  if (isOwn(url)) {
    if (got.error) return { verdict: "dead", detail: got.error.detail };
    if (got.status >= 400) return { verdict: "dead", detail: `our page answers ${got.status}` };
    return { verdict: "fine", detail: "" };
  }
  if (got.error) return got.error;
  if (got.status === 404 || got.status === 410) return { verdict: "dead", detail: `the page answers ${got.status}` };
  // 400 is what Facebook answers anything that is not a browser. A refusal.
  if ([400, 401, 403, 405, 406, 429, 999].includes(got.status)) return { verdict: "unchecked", detail: `the site refuses scripts (${got.status})` };
  if (got.status >= 500) return { verdict: "unchecked", detail: `the site answers ${got.status}` };
  if (got.status >= 400) return { verdict: "dead", detail: `the page answers ${got.status}` };
  const from = host(url).replace(/^www\./, "");
  const to = host(got.finalUrl).replace(/^www\./, "");
  if (to && to !== from) return { verdict: "moved", detail: `lands on ${to}` };
  return { verdict: "fine", detail: "" };
}

/** Run `work` over `items`, CONCURRENCY at a time, PER_HOST at one host. */
async function pool(items, keyOf, work) {
  const results = new Array(items.length);
  const busy = new Map();
  const waiting = items.map((_, i) => i);
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const at = waiting.findIndex((i) => (busy.get(keyOf(items[i])) ?? 0) < PER_HOST);
        if (at === -1) {
          if (waiting.length === 0) return;
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        const [i] = waiting.splice(at, 1);
        const key = keyOf(items[i]);
        busy.set(key, (busy.get(key) ?? 0) + 1);
        try {
          results[i] = await work(items[i]);
        } finally {
          busy.set(key, busy.get(key) - 1);
        }
      }
    }),
  );
  return results;
}

/* ─────────────────────────── crawling ─────────────────────────── */

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');

async function pagesFromSitemap(url, seen = new Set()) {
  if (seen.has(url)) return [];
  seen.add(url);
  let got = await get(url, { body: true });
  // One retry after a pause: a single slow connection should not cost the
  // whole week's check, which is all-or-nothing on this one request.
  if (got.error || got.status >= 500) {
    await new Promise((r) => setTimeout(r, 15_000));
    got = await get(url, { body: true });
  }
  if (got.error || got.status !== 200 || !got.html) {
    throw new Error(`${url}: ${got.error?.detail ?? `answered ${got.status}`}`);
  }
  const locs = [...got.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decode(m[1]));
  if (/<sitemapindex/i.test(got.html)) {
    const nested = [];
    for (const loc of locs) nested.push(...(await pagesFromSitemap(isOwn(loc) ? onBase(loc) : loc, seen)));
    return nested;
  }
  return locs.filter(isOwn).map(onBase);
}

/** Every link a visitor can follow from a page, resolved, without fragments. */
function linksOn(html, pageUrl) {
  const out = new Set();
  for (const [, raw] of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = decode(raw.trim());
    if (!href || href.startsWith("#") || /^(mailto|tel|sms|javascript|data):/i.test(href)) continue;
    try {
      const u = new URL(href, pageUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      // Cloudflare's email obfuscation rewrites every mailto into
      // /cdn-cgi/l/email-protection and decodes it in the browser; that
      // address answers 404 to a script and is not a link a visitor follows.
      if (isOwn(u.href) && u.pathname.startsWith("/cdn-cgi/")) continue;
      out.add(isOwn(u.href) ? onBase(u.href) : u.href);
    } catch {
      /* not a URL a browser would follow either */
    }
  }
  return [...out];
}

/* ─────────────────────────── reporting ─────────────────────────── */

function summarise(results, pages, startedAt) {
  const by = (v) => results.filter((r) => r.verdict === v);
  const dead = by("dead");
  const moved = by("moved");
  const unchecked = by("unchecked");
  const where = (r) => {
    const on = r.pages.slice(0, 2).map((p) => new URL(p).pathname).join(", ");
    return `${r.url}\n    ${r.detail}; on ${on}${r.pages.length > 2 ? ` and ${r.pages.length - 2} more` : ""}`;
  };
  const summary = `${NAME}: ${pages} pages, ${results.length} links. ${dead.length} dead, ${moved.length} moved, ${unchecked.length} unchecked.`;
  const lines = [summary];
  if (dead.length) lines.push("", "Dead:", ...dead.map(where));
  if (moved.length) lines.push("", "Moved (a person looks):", ...moved.map(where));
  if (unchecked.length) lines.push("", `Unchecked (refused a script; ${unchecked.length}, listed in the report)`);
  return { summary, text: lines.join("\n"), dead, moved, unchecked, startedAt };
}

function save(report) {
  if (!OUT) return "";
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `links-${report.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(OUT, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Keep the last KEEP runs: a quarter of weekly reports, enough to see a trend.
  const old = readdirSync(OUT).filter((f) => /^links-.*\.json$/.test(f)).sort().slice(0, -KEEP);
  for (const f of old) rmSync(join(OUT, f));
  return file;
}

async function notify({ dead, moved, summary }, deadLines, savedTo) {
  if (!NTFY_URL) {
    console.error("check-links: --notify given and NTFY_URL unset, so nothing can be sent.");
    process.exit(2);
  }
  // The fleet ntfy is deny-all: without a token this is a 403 that vanishes,
  // and a lost alert reads as "nothing dead".
  if (!NTFY_TOKEN) {
    console.error("check-links: NTFY_TOKEN unset. The ntfy server is deny-all, so this would 403 and vanish.");
    process.exit(2);
  }
  const bad = dead.length > 0;
  const title = bad ? `${NAME}: ${dead.length} dead link${dead.length === 1 ? "" : "s"}` : `${NAME}: weekly link check, nothing dead`;
  const body = [summary, ...deadLines.slice(0, 12), moved.length ? `${moved.length} moved to another site; see the report.` : "", savedTo ? `Report: ${savedTo}` : ""]
    .filter(Boolean)
    .join("\n");
  const res = await fetch(NTFY_URL, {
    method: "POST",
    headers: { Title: title, Priority: bad ? "high" : "default", Tags: bad ? "warning" : "white_check_mark", Authorization: `Bearer ${NTFY_TOKEN}` },
    body,
  });
  if (!res.ok) {
    console.error(`check-links: the notification was refused (${res.status}). The report is the only copy.`);
    process.exit(2);
  }
  console.log(`\nsent: ${title}`);
}

/**
 * Slack, for the team: only when there is something to fix. The weekly "all
 * clear" stays on ntfy, the ops channel, so the team's channel hears from
 * this only when an editor has work. Optional: SLACK_WEBHOOK_URL unset skips
 * it. A refused post fails like a refused ntfy alert, because a lost message
 * would read as "nothing wrong".
 */
/**
 * Email, for the people who fix the content (za, 2026-10-10: the report's
 * "full list" was a file on the checking host that the content owner cannot
 * open). Sent only when there is something to fix, through Resend, to
 * EMAIL_TO (comma-separated) from EMAIL_FROM. Optional: RESEND_API_KEY unset
 * skips it. Each broken link is listed under the page it sits on, with that
 * page's title, its address and a link to edit it: EDIT_URL with {id}, the
 * id found by fetching EDIT_LOOKUP with {slug} (the page address's last
 * part), which answers Directus-style {data: [{id}]}. A refused send exits 2.
 */
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function plainReason(detail) {
  if (/does not exist/.test(detail)) return "the website no longer exists";
  if (/answers 40[4]|answers 410/.test(detail) && /our page/.test(detail)) return "our own page is missing";
  if (/answers 40[4]|answers 410/.test(detail)) return "the page no longer exists";
  if (/certificate/.test(detail)) return "the website's security certificate has expired";
  if (/our page/.test(detail)) return "our own page is not working";
  return detail;
}
async function email(dead) {
  const key = process.env.RESEND_API_KEY;
  const to = (process.env.EMAIL_TO ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const from = process.env.EMAIL_FROM;
  if (!key) return;
  if (!to.length || !from) {
    console.error("check-links: RESEND_API_KEY is set but EMAIL_TO or EMAIL_FROM is not, so the email cannot go.");
    process.exit(2);
  }
  const editUrl = process.env.EDIT_URL;
  const lookup = process.env.EDIT_LOOKUP;
  const idFor = async (slug) => {
    if (!editUrl || !lookup || !slug) return null;
    try {
      const r = await fetch(lookup.replace("{slug}", encodeURIComponent(slug)), { signal: AbortSignal.timeout(10_000) });
      return r.ok ? ((await r.json()).data?.[0]?.id ?? null) : null;
    } catch {
      return null;
    }
  };
  // Each broken link under every page it sits on, pages in order of how many.
  const byPage = new Map();
  for (const d of dead) for (const page of d.pages) {
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(d);
  }
  const groups = [...byPage.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const count = `${dead.length} broken link${dead.length === 1 ? "" : "s"}`;
  const intro = `The weekly link check found ${count} on the website. Most are in older articles, linking to businesses that have closed or pages that were taken down.`;
  const howTo = "For each one, open the page in the CMS and do one of three things: remove the link, point it to a current page, or keep the words without a link.";
  const pageBlock = async (page, items) => {
    const path = new URL(page).pathname;
    const title = pageTitles.get(page) ?? path;
    const id = await idFor(path.split("/").filter(Boolean).pop() ?? "");
    const edit = id !== null ? editUrl.replace("{id}", encodeURIComponent(id)) : null;
    const live = `${BASE}${path}`;
    return {
      html: `<h3 style="margin:24px 0 4px;font-size:16px">${esc(title)}</h3>
<p style="margin:0 0 8px;font-size:13px"><a href="${esc(live)}">View the page</a>${edit ? ` &middot; <a href="${esc(edit)}">Edit in the CMS</a>` : ""}</p>
<ul style="margin:0;padding-left:20px;font-size:14px">${items.map((d) => `<li style="margin:0 0 6px"><span style="word-break:break-all">${esc(d.url)}</span><br><span style="color:#555">${esc(plainReason(d.detail))}</span></li>`).join("")}</ul>`,
      text: `${title}\nView: ${live}${edit ? `\nEdit: ${edit}` : ""}\n${items.map((d) => `  - ${d.url}\n    ${plainReason(d.detail)}`).join("\n")}`,
    };
  };
  const blocks = [];
  for (const [page, items] of groups) blocks.push(await pageBlock(page, items));
  const footer = `This email comes from the weekly link check of ${BASE.replace(/^https?:\/\//, "")}. It arrives each Monday while broken links remain.`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:640px">
<p style="font-size:15px">${esc(intro)}</p><p style="font-size:15px">${esc(howTo)}</p>
${blocks.map((b) => b.html).join("\n")}
<p style="margin-top:32px;font-size:12px;color:#666">${esc(footer)}</p></div>`;
  const text = [intro, howTo, ...blocks.map((b) => b.text), footer].join("\n\n");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: `${NAME}: ${count} to fix on the website`, html, text }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => ({ ok: false, status: e.message, text: async () => "" }));
  if (!res.ok) {
    console.error(`check-links: the email was refused (${res.status}): ${(await res.text()).slice(0, 200)}`);
    process.exit(2);
  }
  console.log(`sent email to ${to.join(", ")}`);
}

async function slack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => ({ ok: false, status: e.message }));
  if (!res.ok) {
    console.error(`slack refused the report (${res.status}).`);
    process.exit(2);
  }
  console.log("sent to slack");
}

/* ─────────────────────────── main ─────────────────────────── */

const startedAt = new Date().toISOString();
let pages;
try {
  pages = [...new Set(await pagesFromSitemap(`${BASE}${SITEMAP}`))];
} catch (error) {
  console.error(`check-links: the sitemap could not be read: ${error.message}`);
  if (NOTIFY && NTFY_URL && NTFY_TOKEN) {
    await fetch(NTFY_URL, {
      method: "POST",
      headers: { Title: `${NAME}: link check could not run`, Priority: "high", Tags: "warning", Authorization: `Bearer ${NTFY_TOKEN}` },
      body: `The sitemap could not be read, so no link was checked.\n${error.message}`,
    }).catch(() => {});
  }
  process.exit(2);
}
if (MAX_PAGES > 0) pages = pages.slice(0, MAX_PAGES);
console.log(`check-links: ${pages.length} pages from ${BASE}${SITEMAP}`);

// Every page is fetched, and a page that will not load is itself a dead link.
const linkPages = new Map();
/** Each page's own title, for the email, without the site name after it. */
const pageTitles = new Map();
const pageResults = await pool(pages, () => baseHost, async (page) => ({ page, got: await get(page, { body: true }) }));
for (const { page, got } of pageResults) {
  const title = got.html?.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  if (title) pageTitles.set(page, decode(title).split(/\s+[|\u2013\u2014-]\s+/)[0].trim()); // content-style-ignore: matching title separators, not prose
  for (const link of got.html ? linksOn(got.html, got.finalUrl || page) : []) {
    if (!linkPages.has(link)) linkPages.set(link, []);
    linkPages.get(link).push(page);
  }
}
const links = [...linkPages.keys()];
console.log(`check-links: ${links.length} distinct links on those pages`);

const verdicts = await pool(links, (l) => host(l), check);
const results = links.map((url, i) => ({ url, ...verdicts[i], pages: linkPages.get(url) }));
// A sitemap page that does not load is reported against the sitemap.
for (const { page, got } of pageResults) {
  if (got.error || got.status >= 400) {
    results.push({ url: page, verdict: "dead", detail: got.error?.detail ?? `our page answers ${got.status}`, pages: [`${BASE}${SITEMAP}`] });
  }
}

const report = summarise(results, pages.length, startedAt);
console.log(`\n${report.text}`);
const savedTo = save({ name: NAME, base: BASE, startedAt, finishedAt: new Date().toISOString(), pages: pages.length, results });
if (savedTo) console.log(`\nreport: ${savedTo}`);
if (NOTIFY) {
  const deadLines = report.dead.map((r) => `${r.url} (${r.detail}; on ${new URL(r.pages[0]).pathname})`);
  await notify(report, deadLines, savedTo);
  if (report.dead.length) await email(report.dead);
  if (report.dead.length) {
    const shown = report.dead.slice(0, 15).map((r) => `• <${r.url}|${r.url.length > 80 ? `${r.url.slice(0, 77)}…` : r.url}> on ${new URL(r.pages[0]).pathname} (${r.detail})`);
    const more = report.dead.length - shown.length;
    await slack(
      [
        `*${NAME}: ${report.dead.length} dead link${report.dead.length === 1 ? "" : "s"}* from the weekly link check.`,
        ...shown,
        more > 0 ? `…and ${more} more.` : "",
        savedTo ? `Full list: \`${savedTo}\` on the checking host.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}
process.exit(report.dead.length ? 1 : 0);
