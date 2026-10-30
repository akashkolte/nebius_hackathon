# Dispatch on Nebius

**A remote control for AI coding agents.** Send coding tasks from your phone, and Dispatch runs them on your computer with whichever agent fits best. A router on **Nebius Token Factory** makes that choice, and **NVIDIA Nemotron** does the harder work.

Built for the Nebius × NVIDIA hackathon.

## What it does

1. **You send a task** from your phone or browser, e.g. _"Fix the failing test"_.
2. **A router on Nebius decides where it goes:**
   - whether the task continues an existing conversation or starts a new one;
   - which agent and model should do it: a fast model for small edits, a stronger one like **NVIDIA Nemotron** for harder work.
3. **An agent does the work**, reading and editing files and running tests in your project. It is either:
   - the built-in **Nebius coding agent**, or
   - **Claude Code, Codex or Gemini**, if they're installed on your computer.
4. **You stay in control:** you watch each step live, approve commands from your phone, send follow-ups, or stop it.
5. **Handoff:** you can move a conversation from one agent to another with its context, for example from Claude to the Nebius agent when you hit Claude's usage limit.

**How it's different from a single agent's phone app:** those drive one agent. Dispatch is one inbox for several agents, it works with the sessions and projects already on your computer, and a Nebius model picks the right agent and model for each task.

**Built with:** TypeScript on Node.js. Both the router and the coding agent run on open models served by Nebius Token Factory.

## Try it yourself (judges, about 5 minutes)

You need your own **Nebius Token Factory API key**; create one in the Nebius Token Factory console. One task typically uses a few thousand tokens. Pick one way to run Dispatch.

### Fastest: GitHub Codespaces (nothing to install)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/akashkolte/nebius_hackathon?quickstart=1)

1. Click the button. Sign in to GitHub if asked. It runs on your account's free monthly Codespaces hours.
2. GitHub asks for two values before creating the codespace:
   - `NEBIUS_API_KEY`: your key;
   - `DISPATCH_PASSWORD`: a password you choose. If you leave it empty, one is generated and printed in the terminal.
3. Wait a minute or two for setup. Dispatch starts by itself in demo mode, and the **Ports** tab shows port **4378 (Dispatch)**. Open its address (the globe icon), sign in with your password, and go to [What to try](#what-to-try).

If the terminal says no API key was found, run this in the codespace terminal:

```bash
export NEBIUS_API_KEY=your-key && bash .devcontainer/start.sh
```

**From your phone:** in the Ports tab, right-click port 4378, choose **Port Visibility → Public**, and open the same address on your phone. Dispatch's password still protects it.

When you're done, delete the codespace from [github.com/codespaces](https://github.com/codespaces) so it stops using your hours.

### Or run it on your own computer: one-time setup

You need **git**.

```bash
git clone https://github.com/akashkolte/nebius_hackathon.git && cd nebius_hackathon
```

```bash
cp .env.example .env
```

Open `.env` in any editor and fill in two lines. The password must be at least 8 characters; you'll sign in with it.

```
NEBIUS_API_KEY=your-nebius-api-key
DISPATCH_PASSWORD=a-password-you-choose
```

`.env` stays on your computer and is never committed. It also turns on **demo mode**, which:

- adds a small `sample-app` project with one failing test;
- shows example tasks on the home screen;
- makes every shell command wait for your approval.

### Option A: Docker (2 commands)

Needs [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS, Windows or Linux), and nothing else.

```bash
docker build -t dispatch .
```

```bash
docker run --rm -p 4378:4378 --env-file .env dispatch
```

When the startup log lists `nebius` as `ready`, open **http://localhost:4378**, sign in with the password from `.env`, and go to [What to try](#what-to-try). Everything the agent does stays inside the container, and is deleted when you stop it with Ctrl+C.

### Use it from your phone (optional, works with either option)

While Dispatch is running, open a second terminal and put an HTTPS tunnel in front of it. This needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/); on macOS, `brew install cloudflared`.

```bash
cloudflared tunnel --url http://localhost:4378
```

Open the `https://….trycloudflare.com` address it prints on your phone, and sign in with the same password.

### Option B: Node.js (without Docker)

Needs macOS or Linux (on Windows, use WSL), **Node.js 22.18 or later** (`node --version`) and **Python 3**, which the sample project's tests use. Run these in the repo folder:

```bash
npm install
```

```bash
npm start
```

When the startup log lists `nebius` as `ready`, open **http://localhost:4378** and sign in with the password from `.env`. The sample project is created in `~/Dispatch Workspaces/`. `DISPATCH_CLI=0` in `.env` keeps any Claude Code or Codex sessions on your computer out of the demo.

Optional: check the key and models end to end, in about a minute. This lists the models your key can use, asks the router a question, and has the agent write and run a small script in a temporary folder. It ends with `✓ Smoke test passed`.

```bash
npm run smoke
```

### What to try

1. Tap the example task **Fix the failing test**, then **Start**.
2. Watch the steps:
   - The Nebius router picks a model.
   - The NVIDIA Nemotron agent reads the code and edits the bug.
   - The agent asks to run the tests; tap **Approve**.
3. When it's done, check the **Activity** tab (route, model, token use) and the **Changes** tab.
4. Send a follow-up in the same session, such as _"Now add a test for complete()"_.
5. Settings → **Test connection** shows the Nebius endpoint and the router model.

If Dispatch says the Nebius key is missing or invalid, check `NEBIUS_API_KEY` in `.env` and start it again.

## How it works

1. **You send a task** from a browser or phone: _"Add a /health endpoint and a test for it."_
2. **The router agent** (a fast model on Nebius, e.g. Qwen3 30B) decides:
   - whether the request continues an existing conversation or starts a new one, and in which harness;
   - which model fits the task, from an editable roster (NVIDIA Nemotron 3 Ultra by default, Nemotron 3 Super for multi-step agentic tasks, Kimi K2.7 Code as a coding alternative, Qwen3 30B for small edits).
3. **The Nebius coding agent** runs a tool-calling loop in the project folder: lists, reads, searches and edits files, and runs tests. **Shell commands wait for your OK** (Approve or Decline from your phone) unless you tick _Skip permissions_.
4. **You watch it live** (server-sent events), send follow-ups with the full context kept, stop it, or **hand off** any session to another harness with its recent transcript and uncommitted git changes.

It also finds your existing **Claude Code, Codex and Gemini CLI** sessions on the machine, so you can read them, continue them headlessly, or hand them off to the Nebius agent.

```
 phone / browser ──HTTPS──▶ Dispatch server (Node 22, TypeScript)
                              │
                              ├─ Router agent ──▶ Nebius Token Factory  (route + model choice, JSON)
                              │     └─ falls back to local word matching if Nebius is slow, unsure or down
                              │
                              ├─ Nebius coding agent ──▶ Nebius Token Factory (tool calls)
                              │     └─ tools: list_files · read_file · write_file · edit_file · search · run_command*
                              │                                                     * needs your approval
                              └─ Desktop CLIs (optional): claude · codex · gemini · opencode
```

## Run it

Requires **Node.js 22.18 or later** (runs TypeScript directly, no build step).

```bash
npm install
```

```bash
cp .env.example .env   # then set NEBIUS_API_KEY (and optionally DISPATCH_PASSWORD) in .env
```

```bash
npm start
```

Open http://localhost:4378 and sign in with `DISPATCH_PASSWORD` (or set a password there if you left it empty). New tasks get their own folder under `~/Dispatch Workspaces` unless you pick a project. The example file turns on demo mode; delete the `DISPATCH_DEMO` and `DISPATCH_CLI` lines from `.env` for everyday use.

Check your key and the models end to end (lists models, asks the router, has the agent write and run a script in a temp folder):

```bash
npm run smoke
```

### Use it from your phone

Dispatch listens on localhost only. To reach it from a phone, put any HTTPS tunnel in front of it, for example:

```bash
cloudflared tunnel --url http://localhost:4378
```

Then open the tunnel's address on your phone and sign in. The first password can only be set from the machine itself.

## Configuration

| Variable                                 | Default                                   | Purpose                                                        |
| ---------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `NEBIUS_API_KEY` / `NEBIUS_TEMP_API_KEY` | –                                         | Nebius Token Factory API key                                   |
| `NEBIUS_BASE_URL`                        | `https://api.tokenfactory.nebius.com/v1`  | OpenAI-compatible endpoint                                     |
| `NEBIUS_ROUTER_MODEL`                    | first served model from a preference list | Model for routing decisions                                    |
| `NEBIUS_AGENT_MODEL`                     | –                                         | Extra model added to the top of the agent roster               |
| `PORT` / `HOST`                          | `4378` / `127.0.0.1`                      | Listen address (`DISPATCH_LAN=1` listens on all interfaces)    |
| `DISPATCH_PASSWORD`                      | –                                         | Set the password at startup (headless servers)                 |
| `DISPATCH_PROJECTS`                      | –                                         | Colon-separated extra project folders to offer in the composer |
| `DISPATCH_WORKSPACES`                    | `~/Dispatch Workspaces`                   | Where new task folders are created                             |
| `DISPATCH_CLI`                           | `1`                                       | `0` = Nebius only: do not probe or offer desktop CLIs          |
| `DISPATCH_DATA_DIR`                      | `.dispatch-data/`                         | Settings, tasks and agent sessions (JSON)                      |
| `DISPATCH_DEMO`                          | `0`                                       | `1` = shared demo: commands always need approval, usage capped |
| `DISPATCH_MAX_TASKS_PER_HOUR`            | `30`                                      | Demo mode: tasks allowed per hour across all visitors          |
| `DISPATCH_MAX_CONCURRENT`                | `3`                                       | Demo mode: tasks allowed to run at the same time               |

At startup and every minute Dispatch calls `GET /v1/models`. Roster models Nebius does not serve are switched off automatically, and the router model is picked from what is actually served. Both are editable in **Settings**, which also has a **Test connection** button.

## Host a public demo (optional)

[docs/DEPLOY.md](docs/DEPLOY.md) puts Dispatch on a server, for example a Nebius VM, with HTTPS using Docker Compose. Visitors only reach a container on that server.

## Security

Anyone who can sign in can make an agent run code on this machine, so:

- The first password can only be set from the machine itself (loopback, no proxy headers). Passwords are stored as scrypt hashes and each browser gets its own random session key, stored only as a hash.
- Sign-in attempts are rate-limited, cookies are `HttpOnly; SameSite=Strict`, cross-origin POSTs are refused, and a strict Content-Security-Policy blocks framing and third-party scripts.
- Agent file tools cannot leave the project folder, symlinks included. Shell commands need approval unless you choose _Skip permissions_.

## Develop

```bash
npm test
```

```bash
npm run typecheck
```

The tests use a mock Nebius server: unit tests cover the client (retries, errors, JSON and text tool calls), the router (Nebius decisions and every fallback), tools (sandboxing, edits, approvals, timeouts) and model rosters. An end-to-end test drives the real HTTP server through sign-in, routing, the agent loop, approvals, follow-ups, cancellation and a Claude Code → Nebius handoff.

| Path                                      | What it is                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `src/brain.ts`                            | Router agent: session/harness and model decisions on Nebius, with local fallback |
| `src/agent/loop.ts`, `src/agent/tools.ts` | Nebius coding agent and its sandboxed tools                                      |
| `src/tasks.ts`                            | Task lifecycle, approvals, CLI harnesses, handoff                                |
| `src/nebius.ts`                           | Dependency-free Token Factory client                                             |
| `src/sessions.ts`, `src/router.ts`        | Desktop session discovery and local ranking                                      |
| `src/server.ts`, `src/auth.ts`            | HTTP API, SSE, sign-in                                                           |
| `public/`                                 | Web app (vanilla JS, mobile-first)                                               |

## License

This project is licensed under the Apache License 2.0 License. See [LICENSE](LICENSE) for details.

## Clean up

Stop Dispatch with Ctrl+C. Then:

- **Codespaces:** delete the codespace at [github.com/codespaces](https://github.com/codespaces). Nothing was installed on your computer.
- **Docker:** remove the image with `docker rmi dispatch`. The container's files were already deleted when it stopped.
- **Node.js:** delete the `~/Dispatch Workspaces` folder.

Finally, delete the repo folder.
