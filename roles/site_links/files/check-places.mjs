#!/usr/bin/env node
/**
 * Is every business a site lists still open?
 *   node check-places.mjs --source=<url> --near="Bellingham, WA"
 *   node check-places.mjs --source=... --name=bhreco --notify --out=/var/lib/site-links/bhreco
 *
 * WHY. A guide that sends a reader to a brewery that closed last spring costs
 * more trust than a dead link, and nothing on the page shows it. Google knows
 * which places closed; this asks it about every place the site lists.
 *
 * WHAT IT READS. --source is a JSON list of places, either an array or
 * Directus's {data: [...]}, each with a name and, ideally, a Google Place ID
 * (--name-field, default name; --id-field, default google_place_id). For
 * bhreco it is the CMS's public places collection, published only.
 *
 * FOUR ANSWERS.
 *   closed     Google says CLOSED_PERMANENTLY, or no longer knows the ID.
 *              Fails the run.
 *   check      Closed temporarily, or Google's name for the place differs
 *              from ours (a rename, or the wrong ID). A person looks.
 *   no id      No Google ID and no confident match by name. Events and
 *              regions land here; counted, named in the report, never alerted.
 *   open       Counted.
 * A place without an ID is searched by name near --near; only a result whose
 * name matches ours counts, so an event never borrows a stranger's status.
 *
 * Reports every run with --notify, like check-links.mjs. Needs Node 20+ and
 * GOOGLE_PLACES_KEY (a Places API (New) key). Exit 0 nothing closed, 1 closed
 * places found, 2 could not run or report.
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
const SOURCE = arg("source", "");
const NEAR = arg("near", "");
const NAME = arg("name", "places");
const NAME_FIELD = arg("name-field", "name");
const ID_FIELD = arg("id-field", "google_place_id");
const OUT = arg("out", "");
const KEEP = Number(arg("keep", "12"));
const NOTIFY = process.argv.includes("--notify");
const KEY = process.env.GOOGLE_PLACES_KEY;
const { NTFY_URL, NTFY_TOKEN } = process.env;

const die = (msg) => {
  console.error(`check-places: ${msg}`);
  process.exit(2);
};
if (!/^https?:\/\//.test(SOURCE)) die("--source=https://… is required");
if (!KEY) die("GOOGLE_PLACES_KEY unset.");
if (NOTIFY && (!NTFY_URL || !NTFY_TOKEN)) die("NTFY_URL and NTFY_TOKEN are needed with --notify. The ntfy server is deny-all, so this would 403 and vanish.");

const API = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 20_000;

/** Words that differ between how we and Google name the same business. */
const NOISE = new Set(["the", "and", "of", "co", "company", "inc", "llc", "brewing", "brewery", "brewhouse", "taproom", "restaurant", "cafe", "bar", "bellingham", "wa"]);
const tokens = (s) =>
  new Set(
    (s ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t && !NOISE.has(t)),
  );
/**
 * Same place by name. Loose (every word of the shorter name is in the longer)
 * when the ID already ties the two together and only a rename is in question.
 * Exact (the same words, filler aside) when searching by name, so "Coffee"
 * never takes a stranger's status: on 2026-10-06 it matched the first coffee
 * shop Google returned.
 */
function sameName(a, b, { exact = false } = {}) {
  const [x, y] = [tokens(a), tokens(b)];
  if (!x.size || !y.size) return false;
  if (exact) return x.size === y.size && [...x].every((t) => y.has(t));
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every((t) => big.has(t));
}

async function google(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "X-Goog-Api-Key": KEY, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function byId(id) {
  const { status, body } = await google(`/places/${encodeURIComponent(id)}`, {
    headers: { "X-Goog-FieldMask": "id,displayName,businessStatus" },
  });
  if (status === 404 || (status === 400 && /not valid|not found/i.test(body?.error?.message ?? ""))) return { gone: true };
  if (status !== 200) throw new Error(`Google answered ${status}: ${body?.error?.message ?? "no message"}`);
  return { name: body.displayName?.text, businessStatus: body.businessStatus };
}

async function byName(name) {
  const { status, body } = await google("/places:searchText", {
    method: "POST",
    headers: { "X-Goog-FieldMask": "places.id,places.displayName,places.businessStatus" },
    body: JSON.stringify({ textQuery: NEAR ? `${name}, ${NEAR}` : name, pageSize: 5 }),
  });
  if (status !== 200) throw new Error(`Google answered ${status}: ${body?.error?.message ?? "no message"}`);
  const hit = (body.places ?? []).find((p) => sameName(p.displayName?.text, name, { exact: true }));
  return hit ? { name: hit.displayName.text, businessStatus: hit.businessStatus, id: hit.id } : null;
}

async function verdict(place) {
  const name = place[NAME_FIELD];
  const id = place[ID_FIELD];
  if (id) {
    const g = await byId(id);
    if (g.gone) return { name, verdict: "closed", detail: "Google no longer knows its Place ID" };
    if (g.businessStatus === "CLOSED_PERMANENTLY") return { name, verdict: "closed", detail: `closed for good, per Google ("${g.name}")` };
    if (g.businessStatus === "CLOSED_TEMPORARILY") return { name, verdict: "check", detail: `closed for now, per Google ("${g.name}")` };
    if (!sameName(g.name, name)) return { name, verdict: "check", detail: `Google calls it "${g.name}": renamed, or the wrong ID` };
    return { name, verdict: "open" };
  }
  const g = await byName(name);
  if (!g) return { name, verdict: "no id", detail: "no Google ID, and no place of that name found" };
  if (g.businessStatus === "CLOSED_PERMANENTLY") return { name, verdict: "closed", detail: `closed for good, per Google ("${g.name}", found by name; it has no Place ID here)` };
  if (g.businessStatus === "CLOSED_TEMPORARILY") return { name, verdict: "check", detail: `closed for now, per Google ("${g.name}", found by name)` };
  return { name, verdict: "open", detail: "found by name; give it its Place ID", id: g.id };
}

function save(report) {
  if (!OUT) return null;
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `places-${report.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, "places-latest.json"), JSON.stringify(report, null, 2));
  const old = readdirSync(OUT).filter((f) => /^places-\d/.test(f)).sort().slice(0, -KEEP);
  for (const f of old) rmSync(join(OUT, f));
  return file;
}

async function notify(title, body, priority, tags) {
  const res = await fetch(NTFY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${NTFY_TOKEN}`, Title: title, Priority: priority, Tags: tags },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => ({ ok: false, status: e.message }));
  if (!res.ok) die(`ntfy refused the report (${res.status}).`);
  console.log(`sent: ${title}`);
}

/**
 * Slack, for the team: only when there is something to fix. The weekly "all
 * clear" stays on ntfy, the ops channel, so the team's channel hears from
 * this only when an editor has work. Optional: SLACK_WEBHOOK_URL unset skips
 * it. A refused post fails like a refused ntfy alert, because a lost message
 * would read as "nothing wrong".
 */
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

const startedAt = new Date().toISOString();
let places;
try {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the source answered ${res.status}`);
  const json = await res.json();
  places = Array.isArray(json) ? json : json.data;
  if (!Array.isArray(places) || places.length === 0) throw new Error("the source listed no places");
} catch (e) {
  if (NOTIFY && NTFY_URL && NTFY_TOKEN) await notify(`${NAME}: place check could not run`, `Could not read the places: ${e.message}`, "high", "warning");
  die(`could not read the places: ${e.message}`);
}

const results = [];
try {
  for (const p of places) results.push(await verdict(p));
} catch (e) {
  if (NOTIFY) await notify(`${NAME}: place check could not run`, `Google Places failed part way: ${e.message}`, "high", "warning");
  die(e.message);
}

const of = (v) => results.filter((r) => r.verdict === v);
const [closed, check, noId, open] = ["closed", "check", "no id", "open"].map(of);
const summary = `${NAME}: ${results.length} places. ${closed.length} closed, ${check.length} to check, ${open.length} open, ${noId.length} with no Google ID.`;
const lines = (rs) => rs.map((r) => `${r.name}: ${r.detail}`).join("\n");
let text = summary;
if (closed.length) text += `\n\nClosed:\n${lines(closed)}`;
if (check.length) text += `\n\nCheck (a person looks):\n${lines(check)}`;
if (noId.length) text += `\n\nNo Google ID: ${noId.map((r) => r.name).join(", ")}`;
console.log(`${text}\n`);

const savedTo = save({ name: NAME, source: SOURCE, startedAt, summary, results });
if (savedTo) console.log(`report: ${savedTo}`);

if (NOTIFY) {
  const title = closed.length ? `${NAME}: ${closed.length} listed place${closed.length === 1 ? "" : "s"} closed` : `${NAME}: weekly place check, nothing closed`;
  await notify(title, text, closed.length ? "high" : "default", closed.length ? "warning" : "white_check_mark");
  if (closed.length) {
    const bullets = (rs) => rs.map((r) => `• ${r.name}: ${r.detail}`);
    await slack(
      [
        `*${NAME}: ${closed.length} listed place${closed.length === 1 ? "" : "s"} closed*, per Google, from the weekly place check.`,
        ...bullets(closed),
        check.length ? "\nAlso worth a look:" : "",
        ...bullets(check),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}
process.exit(closed.length ? 1 : 0);
