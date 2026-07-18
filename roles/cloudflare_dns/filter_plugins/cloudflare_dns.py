"""Filters for the cloudflare_dns role.

The role's whole job is a three-way comparison:

    desired  - derived from cloudflared ingress rules in the inventory
    live     - what Cloudflare actually serves right now
    managed  - the subset of live we are allowed to touch

Doing that in Jinja is possible and unreadable. It lives here instead.
"""

from __future__ import annotations

TUNNEL_SUFFIX = ".cfargotunnel.com"

# Only these decide where traffic goes. A name commonly also carries TXT
# (domain verification, SPF, Traefik's _acme-challenge); those are never ours.
ADDRESS_TYPES = ("A", "AAAA", "CNAME")


def cf_desired_records(hostvars, hosts, extra=None):
    """Derive one CNAME per cloudflared ingress hostname.

    The hostname is already declared in host_vars as an ingress rule, and the
    target is a pure function of the host's tunnel. So DNS needs no second
    declaration: adding an ingress rule IS adding the record.
    """
    out = []
    for host in hosts:
        hv = hostvars.get(host) or {}
        tunnel = str(hv.get("cloudflared_tunnel") or "")
        for rule in hv.get("cloudflared_ingress") or []:
            name = rule.get("hostname")
            if not name:
                continue  # catch-all rule, no hostname
            out.append(
                {
                    "name": name,
                    "type": "CNAME",
                    "content": tunnel + TUNNEL_SUFFIX,
                    "proxied": True,
                    "origin": host,
                }
            )
    for rec in extra or []:
        out.append(
            {
                "name": rec["name"],
                "type": rec.get("type", "CNAME"),
                "content": rec["content"],
                "proxied": rec.get("proxied", True),
                "origin": rec.get("origin", "declared"),
            }
        )
    return out


def cf_zone_for(name, zones):
    """Longest-suffix match of a hostname against the account's zones.

    Longest wins so houseofza.design never gets mistaken for houseofza.dev,
    and a future co.uk zone does not need special-casing.
    """
    best = ""
    for zone in zones:
        if name == zone or name.endswith("." + zone):
            if len(zone) > len(best):
                best = zone
    return best


def cf_relative(name, zone):
    """Record name relative to its zone; '@' at the apex."""
    if name == zone:
        return "@"
    return name[: -(len(zone) + 1)]


def cf_diff(desired, live, zones):
    """Compare desired against live. Returns the four buckets the role acts on.

    'live' is a flat list of Cloudflare API record dicts across every zone the
    token can see - deliberately every zone, not just the ones we have ingress
    for, because a record aimed at a dead tunnel in an otherwise-unused zone is
    exactly the drift we are hunting.
    """
    live_addr = {}
    for rec in live:
        if rec["type"] in ADDRESS_TYPES:
            live_addr[rec["name"]] = rec

    # NB: never name a bucket "update"/"items"/"keys" - in Jinja, plan.update
    # silently resolves to the dict's bound method instead of the key.
    create, drifted, insync, unroutable = [], [], [], []
    desired_names = set()

    for want in desired:
        name = want["name"]
        desired_names.add(name)
        zone = cf_zone_for(name, zones)
        if not zone:
            unroutable.append(want)  # hostname in no zone this token can see
            continue
        want = dict(want, zone=zone, record=cf_relative(name, zone))

        got = live_addr.get(name)
        if got is None:
            create.append(want)
        elif (
            got["type"] != want["type"]
            or got["content"] != want["content"]
            or bool(got.get("proxied")) != bool(want["proxied"])
        ):
            drifted.append(
                dict(want, was=f"{got['type']} {got['content']} proxied={got.get('proxied')}")
            )
        else:
            insync.append(want)

    # Orphans: a record pointing into a tunnel that nothing is serving.
    # Anything not aimed at a tunnel (MX, SPF, Tailscale A records, the gitea
    # CNAME) is out of scope by design and never appears here.
    orphans = []
    for name, rec in sorted(live_addr.items()):
        if not rec["content"].endswith(TUNNEL_SUFFIX):
            continue
        if name in desired_names:
            continue
        orphans.append(
            {
                "name": name,
                "zone": cf_zone_for(name, zones),
                "record": cf_relative(name, cf_zone_for(name, zones)),
                "type": rec["type"],
                "content": rec["content"],
                "tunnel": rec["content"][: -len(TUNNEL_SUFFIX)],
                "id": rec["id"],
            }
        )

    return {
        "create": create,
        "drifted": drifted,
        "insync": insync,
        "orphans": orphans,
        "unroutable": unroutable,
    }


def cf_shadowed(desired, live, zones):
    """Desired names that resolve ONLY via a wildcard, with no record of their own.

    These work today, which is what makes them dangerous: nothing in DNS records
    that the hostname is real, so it survives no audit and no one can see it.
    """
    have = {r["name"] for r in live if r["type"] in ADDRESS_TYPES}
    out = []
    for want in desired:
        name = want["name"]
        if name in have or name.startswith("*."):
            continue
        parent = name.split(".", 1)[1] if "." in name else ""
        if "*." + parent in have:
            out.append(dict(want, wildcard="*." + parent))
    return out


class FilterModule:
    def filters(self):
        return {
            "cf_desired_records": cf_desired_records,
            "cf_zone_for": cf_zone_for,
            "cf_relative": cf_relative,
            "cf_diff": cf_diff,
            "cf_shadowed": cf_shadowed,
        }
