# Host a demo on a Nebius VM

This runs Dispatch in **demo mode** on a Nebius VM. Visitors sign in with a password, send tasks from their phone, and approve each shell command. Everything runs inside a container on the VM; it has no access to your own computer or accounts.

You need a Nebius AI Cloud account and a Nebius Token Factory API key. No GPU is needed: the models run on Token Factory.

## 1. Create the VM

In the Nebius AI Cloud console, create a virtual machine:

- **Platform:** a CPU-only preset with 2 vCPUs and 4–8 GB of RAM is enough.
- **Image:** Ubuntu 22.04 or 24.04.
- **Network:** give it a **public IP address**, and allow inbound TCP **22, 80 and 443** if your network has firewall rules.
- **Access:** add your SSH public key.

The console's exact labels may differ from the ones above; any small Ubuntu VM with a public IP works.

## 2. Install Docker and get the code

```bash
ssh ubuntu@YOUR_VM_IP
```

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
git clone https://github.com/akashkolte/nebius_hackathon.git && cd nebius_hackathon
```

If the repository is private, clone it with a GitHub personal access token or a deploy key.

## 3. Configure

```bash
cp .env.example .env && nano .env
```

- `NEBIUS_API_KEY`: use a **separate key** for the demo, so you can revoke it after judging. Every visitor's task spends its credits.
- `DISPATCH_PASSWORD`: the password you give the judges (8+ characters).
- `DISPATCH_DOMAIN`: the public hostname. Without your own domain, use the VM's IP with dashes plus `.sslip.io`. For IP `203.0.113.10`, that is `203-0-113-10.sslip.io`.

## 4. Start it

```bash
sudo docker compose up -d --build
```

Caddy requests an HTTPS certificate for `DISPATCH_DOMAIN` on first start; this takes up to a minute. Then open `https://DISPATCH_DOMAIN` and sign in with your password.

Check the logs if something is off:

```bash
sudo docker compose logs -f
```

If the certificate fails with sslip.io (Let's Encrypt limits how many certificates one shared domain can get per week), point a domain you own at the VM's IP and use that instead.

## Day-to-day

Update to the latest code:

```bash
git pull && sudo docker compose up -d --build
```

Reset the demo: this deletes all tasks, sessions and workspaces, and brings back a fresh `sample-app`.

```bash
sudo docker compose down -v && sudo docker compose up -d
```

When judging is over, stop or delete the VM and revoke the demo API key.

## What demo mode changes

- Every shell command waits for approval; _Skip permissions_ is hidden and ignored.
- At most `DISPATCH_MAX_TASKS_PER_HOUR` tasks per hour (default 30) and `DISPATCH_MAX_CONCURRENT` running at once (default 3).
- Only the built-in Nebius agent is offered; desktop CLIs are off.
- A `sample-app` project with a failing test is created, and the home screen offers example tasks.
- The container runs as an unprivileged user with no Linux capabilities, 2 CPUs, 2 GB of memory and at most 256 processes.
