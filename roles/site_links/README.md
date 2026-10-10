# site_links

Crawl the sites we run once a week and report every link that no longer goes
anywhere, from a host that is not the web server.

Built 2026-10-06 for bhreco (za's design list, item 9). Every other gate there
compares the site with itself, fixtures with the CMS and one render with
another, so none had ever asked whether a link a visitor clicks goes anywhere.
The first full run found 93 dead links across 45 articles that nobody knew
about. A link to a business that closed is invisible from inside the repo.

## What it does

- Reads the site's sitemap, fetches every page in it, and checks every link
  on those pages: the site's own and everyone else's, wherever the link came
  from (code, CMS content, an article body).
- Gives each link one of four answers. `dead` (the domain does not exist, the
  page answers 404 or 410, the certificate expired, or one of our own pages
  answers 4xx or 5xx) fails the run. `moved` (lands on a different site) and
  `unchecked` (the site refuses scripts, which says nothing about the link)
  are listed for a person. `fine` is counted.
- Reports **every run** to the site's own ntfy topic: high priority with the
  dead links when there are any, a quiet "nothing dead" when there are not. A
  weekly check that is silent when all is well cannot be told apart from one
  that stopped running.
- Keeps each run's full report as JSON in the state directory, the last twelve
  per site, with `latest.json` beside them.
- The job fails only when a site could not be checked or its report could
  not be sent. Dead links are what the report is for, so a run that found
  some and reported them succeeds; the first run on gmktron (2026-10-06)
  showed a working check as a failed unit until this was changed.

It changes nothing. Fixing a link is an editor's job, in the CMS or the code.

Sitemaps written for a future domain are handled: bhreco's lists `bhamre.co`
while that domain still points at the old site, so `canonical: [bhamre.co]`
maps those addresses onto `base_url` and counts links to it as the site's own.
Cloudflare's email-obfuscation addresses (`/cdn-cgi/...`) are skipped, since a
browser decodes them and a script only ever sees a 404.

## Is every listed business still open? (optional, per site)

A site that lists businesses (bhreco's Live Bellingham Now guides) can also
ask Google, each week after the link check, whether each one is still open:
`files/check-places.mjs`, reporting to the same topic every run.

- `closed` fails the run's report: Google says closed for good, or no longer
  knows the Place ID.
- `check` is for a person: closed for now, or Google's name differs from ours
  (a rename, or the wrong ID).
- `no id`: no Place ID and no place of exactly that name. Events and regions
  land here; they are counted and named, never alerted.

A place without an ID is searched by name near `places.near`, and only a
result with the same words (filler like "Brewing" or "Company" aside) counts,
so "Coffee" never takes a stranger's status. Built 2026-10-06 (za's list,
item 9, second half); its first run found Twin Sisters and Artivem Mead closed
for good and Boundary Bay renamed "Boundary on State".

## Email (optional, per site)

`email` sends the people who fix the content a readable report when a run
finds dead links: each broken link listed under the page it sits on, with the
page's title, a link to it and, given `edit_url` and `edit_lookup`, a link to
edit it in the CMS. Added 2026-10-10 because the report's "full list" was a
file on the checking host that a content owner cannot open. Sent through
Resend; the sender must be on a domain the key may send from (for bhreco,
bhreco.app; bhamre.co is refused). A refused send exits 2.

## Slack (optional, per site)

`slack_webhook` sends the team a message only when a run finds dead links or
closed places: the first fifteen dead links with the page each sits on, or
every closed place plus the ones worth a look. The weekly all-clear stays on
ntfy, so the team's channel hears from this only when an editor has work. A
refused Slack post fails the run's report (exit 2), like a refused ntfy alert.
Added 2026-10-06; bhreco posts to its digest channel.

## Variables

| Variable | Default | Meaning |
|---|---|---|
| `site_links_sites` | `[]` | The sites. Empty fails the play: a timer that checks nothing reports success forever. |
| `site_links_on_calendar` | `Mon *-*-* 14:30:00` | Timer schedule (systemd `OnCalendar`), UTC. |
| `site_links_keep` | `12` | Reports kept per site. |
| `site_links_state_dir` | `/var/lib/site-links` | Reports, one directory per site. |
| `site_links_script_dir` | `/usr/local/lib/site-links` | Where the checker is installed. |

Each site takes `name`, `base_url`, optional `canonical` (list of hosts),
`sitemap` (default `/sitemap.xml`), `places` (`source`, `near`,
`google_key`) and `slack_webhook`, and **required** `ntfy_url` and
`ntfy_token`. The play fails without a topic and token: ntfy runs `deny-all`,
so a site without a token would be checked every week and never heard from.

## Running it by hand

```sh
sudo systemctl start site-links.service     # a full run now
journalctl -u site-links.service -n 80      # what it found
sudo cat /var/lib/site-links/<name>/latest.json
```

The checker runs anywhere with Node 20+, no install:

```sh
node roles/site_links/files/check-links.mjs --base=https://site.bhreco.app --canonical=bhamre.co --max-pages=10
```

## Verified, 2026-10-06

- Against production bhreco: 255 pages, about 1,185 links, 93 dead (all in
  article bodies), 33 moved, 267 unchecked, in about two minutes.
- Against a local test site: a missing page on the canonical host, a page that
  answers 500 and a sitemap page that is gone were all reported dead; the
  Cloudflare address, a mailto and an in-page anchor were skipped.
- A labelled test alert reached `bhreco-ops`; with no token the checker
  refuses with exit 2 instead of sending into a 403.
