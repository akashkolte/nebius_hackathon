# Dispatch on Nebius

**Message your coding agents from your phone. A Nebius-hosted router agent decides where each request goes, and a built-in Nebius coding agent does the work.**

Built for the Nebius × NVIDIA hackathon. Routing and coding both run on open models served by **Nebius Token Factory**, so it works on any machine with no desktop agent installed.

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

At startup and every minute Dispatch calls `GET /v1/models`. Roster models Nebius does not serve are switched off automatically, and the router model is picked from what is actually served. Both are editable in **Settings**, which also has a **Test connection** button.

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
