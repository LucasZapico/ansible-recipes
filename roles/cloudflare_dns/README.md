# cloudflare_dns

Makes Cloudflare DNS a derivative of your tunnel ingress rules instead of a
second, hand-maintained source of truth.

## The idea

If a host's `cloudflared_ingress` already says

```yaml
cloudflared_ingress:
  - hostname: app.example.com
    service: http://localhost:8080
```

then the DNS record is fully determined: `app.example.com` is a proxied CNAME to
`<that host's tunnel UUID>.cfargotunnel.com`. There is nothing left to decide, so
there is nothing left to declare. This role derives the records from the ingress
rules you already wrote and converges them.

Adding a public hostname becomes one edit in one file.

## Scope

Narrow, on purpose. The role only ever touches records whose content ends in
`.cfargotunnel.com`. Your MX, SPF, DKIM, domain-verification TXT, ACME
challenge records and any A record pointing at a real IP are structurally out of
reach: it cannot rewrite them and cannot prune them, even if they look stale.

## What it reports

Every run prints a reconcile report:

| Bucket | Meaning |
| --- | --- |
| `IN SYNC` | ingress rule and its record agree |
| `CREATE` | ingress rule exists, record does not |
| `DRIFTED` | record exists but aims at the wrong tunnel, or is grey-clouded |
| `ORPHAN` | record aims at a tunnel, but no ingress rule claims it |
| `SHADOWED` | hostname resolves only because a wildcard covers it |
| `UNROUTABLE` | hostname belongs to no zone this token can see |

`ORPHAN` is the one that finds real rot: a record still pointing at a tunnel you
deleted months ago serves a 530 to anyone who visits it, and nothing else in the
stack will ever tell you.

`SHADOWED` is the quiet one. The hostname works, so nobody notices that DNS holds
no evidence it exists. Converging gives it a real record.

## Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `cloudflare_dns_api_token` | `""` | **Required.** See below. Vault it in your private inventory; never define it here. |
| `cloudflare_dns_source_group` | `cloudflared` | Inventory group whose ingress rules drive DNS. |
| `cloudflare_dns_extra_records` | `[]` | Tunnel records with no ingress rule of their own (wildcards, mostly). Without these they read as orphans forever. |
| `cloudflare_dns_audit_only` | `false` | Compare and report, write nothing. |
| `cloudflare_dns_fail_on_orphans` | `false` | Make drift fatal. Converge leaves this off; audit turns it on. |
| `cloudflare_dns_fail_on_shadowed` | `false` | Same, for wildcard-only hostnames. |
| `cloudflare_dns_prune` | `false` | Delete orphans. Prompts before it does. The only destructive path. |

Every host in the source group must set `cloudflared_tunnel` to the tunnel
**UUID**, not its name: the CNAME target is built from it, and a name gives us
nothing to point at. The role asserts this up front.

## The token

Two, ideally, and hand the role whichever one matches what the run intends to do:

| | Permissions | Used with |
| --- | --- | --- |
| audit | `Zone:Read` + `DNS:Read` | `cloudflare_dns_audit_only: true` |
| write | `Zone:Read` + `DNS:Edit` | converge, prune |

Scope both to **all zones**, not a hand-picked list. An orphan sitting in a zone
the token cannot see is invisible, and that invisibility is the whole bug this
role exists to catch. The zones with the most rot are usually the ones you
stopped serving, which is exactly what a "zones we serve" list omits.

The reason to bother with two: the audit is the run you will eventually put on a
schedule, unattended, which makes it the one most likely to leak. A read-only
token cannot damage anything even if this role is wrong.

Note that Cloudflare has no per-record-type permission. A `DNS:Edit` token can
rewrite MX, SPF, DKIM and `_acme-challenge` records, and there is no way to mint
one that cannot. The narrow blast radius is enforced by `cf_diff`, which never
puts a non-tunnel record in any bucket, and not by the credential.

## Usage

```yaml
- name: Cloudflare DNS
  hosts: localhost
  connection: local
  gather_facts: false
  roles:
    - cloudflare_dns
```

DNS is account state, not host state, so the play runs once on localhost and
needs no `become`.

## Prune

```yaml
cloudflare_dns_prune: true
```

Lists every record it intends to delete, then pauses for a typed `yes`. Set
`cloudflare_dns_prune_assume_yes: true` to skip the prompt in automation, which
you should think about twice.
