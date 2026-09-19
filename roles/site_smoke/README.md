# site_smoke

Check the public sites on a timer from a host that is not the web server, and
announce a failure once rather than every run.

Built 2026-09-19 after `/ask` failed in production while every test in the repo
passed. Unit tests cannot see the three things that actually break a shipped
feature: an environment variable set locally and absent from the container, a
route that was never registered, and an upstream that is down. All three are
only visible from outside.

## What it does

- Runs `curl` against each configured check, asserting the status and, when
  given, that the body does or does not contain a marker. Every request is
  cache-busted, because an edge cache will happily serve a check the previous
  deploy and pass.
- Writes a one-word state file, and notifies **on the transition**: once when
  checks start failing, once when they recover. A site down for an hour is
  announced once, not four times an hour.
- Exits non-zero on failure, so `systemctl status site-smoke` and the timer's
  last result carry it even with notifications off.

It deliberately runs somewhere other than the web host, so it exercises the
same path a visitor takes: DNS, the edge, the origin, the app, and whatever the
app calls.

## Variables

| Variable | Default | Meaning |
|---|---|---|
| `site_smoke_sites` | `[]` | The sites and checks. Empty fails the play: a timer that checks nothing reports success forever. |
| `site_smoke_on_calendar` | `*:0/15` | Timer schedule (systemd `OnCalendar`). |
| `site_smoke_timeout` | `60` | Per-request ceiling, in seconds. Generous on purpose: this catches dead, not slow. |
| `site_smoke_ntfy_url` | `""` | Topic URL for alerts. Empty means log only, which is the right setting while a new check settles. |
| `site_smoke_ntfy_priority` | `high` | ntfy priority header. |
| `site_smoke_state_dir` | `/var/lib/site-smoke` | Where the last result is remembered. |

Each entry in `site_smoke_sites` is `{name, base_url, checks}`, and each check is:

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | What it proves, in words. This is what the alert says, so write it for someone reading it on a phone. |
| `path` | yes | Appended to `base_url`. |
| `expect` | no (200) | Expected HTTP status. |
| `contains` | no | Substring the body must contain. |
| `absent` | no | Substring the body must not contain. |
| `post` | no | JSON body. Its presence makes the request a POST. |

## Example

```yaml
site_smoke_ntfy_url: https://ntfy.example.com/fleet
site_smoke_sites:
  - name: example.com
    base_url: https://example.com
    checks:
      - name: home renders
        path: /
        contains: "<title>"
      - name: the assistant answers
        path: /ask.data
        post: '{"messages":[{"role":"user","content":"hello"}]}'
        absent: '"ok",false'
```

## Relationship to the repo's own smoke test

An application repo may carry a fuller check it runs by hand after a deploy
(mono-bluemonkeymakes.com has `task smoke`). This role is the unattended
subset: fewer assertions, no dependencies beyond `curl`, and it keeps running
when nobody is watching. Do not try to keep the two identical. Keep this one
focused on "is the feature alive at all", which is what wakes someone up.
