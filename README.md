# Ansible Recipes

Reusable Ansible roles for Ubuntu/Debian servers: a sane baseline for every
machine, plus an opt-in role for hosts that publish services through a
Cloudflare Tunnel.

This repo is intentionally generic. It contains no hostnames, domains,
IPs, or credentials, so it is safe to read and reuse.

## Layout: public recipes, private inventory

Roles live here. Your inventory (hosts, domains, tunnel ingress rules) lives
in a separate private repo that points its `roles_path` at a checkout of this
one:

```
# private-repo/ansible.cfg
[defaults]
inventory = inventory.yml
roles_path = ../ansible-recipes/roles
```

Run everything from the private repo:

```sh
ansible all -m ping
ansible-playbook playbooks/site.yml            # converge everything
ansible-playbook playbooks/site.yml --check --diff   # dry run: show drift
ansible-playbook playbooks/site.yml --limit some-host -K   # sudo password prompt
```

Secrets policy: tunnel credential JSONs, TLS certs, and API tokens never
enter either repo. They are provisioned on the host once. If a variable
must be secret and versioned, encrypt it with ansible-vault in the private
repo.

## Roles

### base

Baseline for every server. Each part can be toggled or tuned through the
variables in `roles/base/defaults/main.yml`.

| What | Default |
| --- | --- |
| Core packages (vim, git, curl, htop, unzip) | on, extend via `base_extra_packages` |
| zsh + oh-my-zsh for `base_shell_user` | on when a user is set |
| Unattended security upgrades, no auto-reboot | on |
| UTC timezone + systemd-timesyncd | on |
| SSH hardening (key-only auth) | off: `base_ssh_hardening: true` per host once key access is confirmed |

### cloudflared

Installs and manages a Cloudflare Tunnel connector the supported way:

- Official Cloudflare apt repository (updates arrive with `apt upgrade`).
- `/etc/cloudflared/config.yml` rendered from `cloudflared_ingress` host vars.
  The template is validated with `cloudflared tunnel ingress validate` before
  it replaces the live config, and the service only restarts on change.
- UDP buffer sysctls (`net.core.rmem_max`/`wmem_max`) sized for QUIC, which
  otherwise drops packets under load with stock kernel limits.
- Systemd unit with restart-on-failure.

See `examples/host_vars/server-one.yml` for the ingress rule shape and
`roles/cloudflared/defaults/main.yml` for all variables.

### docker

Docker engine + compose plugin from Docker's official apt repository.
`docker_users` lists accounts added to the docker group.

### pihole

Pi-hole as a compose stack. Disables the systemd-resolved stub listener
(which otherwise occupies port 53 on Ubuntu) and repoints
`/etc/resolv.conf` before starting the container. Expects the data
volumes (`etc-pihole/`, `etc-dnsmasq.d/`) and a `.env` with
`PIHOLE_PASSWORD` to exist in `pihole_dir`; restore them from a backup or
let a fresh install create them. Set `pihole_dhcp: true` only if Pi-hole
serves DHCP.

### beszel_hub

[beszel](https://beszel.dev) monitoring hub as a compose stack. Hub data
lives in `beszel_hub_dir/beszel_data`.

### beszel_agent

beszel agent as a host-network container with a read-only docker.sock
mount (reports host and container stats). Requires docker to already be
present: pair with the `docker` role on self-owned hosts, or rely on the
platform (e.g. Coolify) elsewhere. Set `beszel_agent_hub_key` to the
hub's public key.

### ntfy

[ntfy](https://ntfy.sh) push notification server as a compose stack, for
hosts and scripts that need to reach a phone. `ntfy_base_url` is required
(ntfy builds subscription links from it, and push does not work without
it), so the role asserts it rather than starting a broken server.

Defaults to `auth-default-access: deny-all`, which means a topic name is
not a password: publishing and subscribing both need an account or token.
Create those once, by hand, after the first converge:

```sh
docker exec -it ntfy ntfy user add --role=admin <name>
docker exec -it ntfy ntfy token add <name>
```

They are deliberately not provisioned from Ansible, since that would put
credentials in the play output and in the repo.

A self-hosted server cannot wake an iOS device on its own, because only
the official app carries Apple's push certificate. Set
`ntfy_upstream_base_url: https://ntfy.sh` to forward a *hash* of the topic
(never message content) so the phone wakes and then fetches the real
message from your server. Android and the web UI need nothing extra.

## Requirements

- Control node: Ansible 2.15+ (the `ansible` package includes the
  `community.general` and `ansible.posix` collections these roles use, or
  install `requirements.yml` with bare ansible-core).
- Targets: Ubuntu/Debian with Python 3.

## Legacy

`legacy/` holds the original flat playbooks this repo started as
(workstation and server one-shots). They are kept for reference and are not
maintained.
