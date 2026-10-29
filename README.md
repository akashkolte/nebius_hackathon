# Dispatch on Nebius

**Message your coding agents from your phone. A Nebius-hosted router agent decides where each request goes, and a built-in Nebius coding agent does the work.**

Built for the Nebius × NVIDIA hackathon. Routing and coding both run on open models served by **Nebius Token Factory**, so it works on any machine with no desktop agent installed.

## Try it yourself (judges, about 5 minutes)

You run Dispatch on your own computer with your own Nebius API key. Then you send it coding tasks from a browser, or from your phone.

### What you need

- **macOS or Linux.** On Windows, use WSL or the Docker option below.
- **Node.js 22.18 or later** (`node --version`), **git** and **Python 3** (the sample project's tests use it).
- **A Nebius Token Factory API key.** Create one in the Nebius Token Factory console. One task typically uses a few thousand tokens.

### 1. Get the code and install

```bash
git clone https://github.com/akashkolte/nebius_hackathon.git
```

```bash
cd nebius_hackathon && npm install
```

### 2. Add your API key

```bash
export NEBIUS_API_KEY=paste-your-key-here
```

Optional: check the key and models end to end, about a minute. It lists the models your key can use, asks the router a question, and has the agent write and run a small script in a temporary folder. It ends with `✓ Smoke test passed`.

```bash
npm run smoke
```

### 3. Start Dispatch in demo mode

```bash
DISPATCH_DEMO=1 DISPATCH_CLI=0 npm start
```

Demo mode does three things:

- it creates a small `sample-app` project with one failing test, in `~/Dispatch Workspaces/`;
- it shows example tasks on the home screen;
- it makes every shell command wait for your approval.

`DISPATCH_CLI=0` keeps any Claude Code or Codex sessions on your computer out of the demo.

### 4. Try it

1. Open **http://localhost:4378**, choose a password (8+ characters) and sign in.
2. Tap the example task **Fix the failing test**, then **Start**.
3. Watch the steps:
   - The Nebius router picks a model.
   - The NVIDIA Nemotron agent reads the code and edits the bug.
   - The agent asks to run the tests; tap **Approve**.
4. When it's done, check the **Activity** tab (route, model, token use) and the **Changes** tab, or send a follow-up such as _"Now add a test for complete()"_. Settings → **Test connection** shows the Nebius endpoint and the router model.

### 5. Optional: use it from your phone

In a second terminal, put an HTTPS tunnel in front of Dispatch (needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)):

```bash
cloudflared tunnel --url http://localhost:4378
```

Open the `https://….trycloudflare.com` address it prints on your phone, and sign in with the same password.

### Alternative: Docker

No Node.js needed. Run this from the repo folder. The container can't set a password from the browser, so you pass it with `DISPATCH_PASSWORD`:

```bash
docker build -t dispatch .
```

```bash
docker run --rm -p 4378:4378 -e NEBIUS_API_KEY -e DISPATCH_PASSWORD=choose-a-password dispatch
```

Then open http://localhost:4378 and sign in with that password. `-e NEBIUS_API_KEY` passes on the key you exported in step 2.

### Clean up

Stop Dispatch with Ctrl+C, then delete the `~/Dispatch Workspaces` folder and the repo folder.

## What it does

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
export NEBIUS_API_KEY=your-key   # NEBIUS_TEMP_API_KEY also works
```

```bash
npm start
```

Open http://localhost:4378, set a password, and type a task. New tasks get their own folder under `~/Dispatch Workspaces` unless you pick a project.

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
