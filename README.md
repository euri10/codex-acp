# ACP adapter for Codex CLI

[![npm version](https://img.shields.io/npm/v/%40agentclientprotocol%2Fcodex-acp)](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)

Use [OpenAI Codex](https://github.com/openai/codex) from [Agent Client Protocol](https://agentclientprotocol.com/) clients.

`codex-acp` is a stdio ACP agent server. It starts the Codex App Server, translates ACP requests into Codex operations, and maps Codex events back into the client.

## Features

- ChatGPT, API key, and client-provided custom gateway authentication.
- Model, reasoning effort, fast mode, approval, sandbox mode, and configured [Codex permission profile](docs/permission-profiles.md) selection.
- Concrete recommended model and reasoning-effort values through the opt-in [AIR recommended config values](docs/air-extensions.md#recommended-config-values) capability.
- Text prompts, embedded context, images, resource links, and additional workspace directories.
- Shell command, file change, [permission request](docs/air-extensions.md#permission-presentation), MCP tool call, terminal output, reasoning, [plan](docs/plans.md), web search, image generation, image view, token usage, and review events.
- Compact file changes through the negotiated [AIR diff patch extension](docs/air-extensions.md#diff-patch).
- For AIR, one tool call shape with each fact in one field, as the [tool call contract](docs/air-extensions.md#tool-call-contract) defines. Other clients keep the earlier fields.
- [Native ACP subagent sessions](docs/subagent-sessions.md) (after capability negotiation) with separate child histories and root-routed permissions; a legacy tool-call fallback otherwise.
- Mid-turn input through the [_session/steering extension](docs/steering.md), with an opt-in host-owned fallback when no turn can accept it.
- [Async Codex questions](docs/async-questions.md) as non-blocking form elicitations, with answers steered into the turn that asked them.
- [Background terminal tasks](docs/air-extensions.md#async-tasks) in AIR, with task status and targeted stop support after capability negotiation.
- Session-scoped long-running goals in AIR through the [goal extension](docs/air-extensions.md#goal).
- Typed warnings and errors through the opt-in [AIR session failure extension](docs/air-extensions.md#session-failure).
- All AIR extensions, capabilities, and `_meta` keys: [AIR extensions](docs/air-extensions.md).
- A per-turn [agent file-change report](docs/air-extensions.md#agent-file-change-report) after capability negotiation.
- Client-provided MCP servers over command-based stdio config and HTTP transport.
- Slash commands: `/status`, `/mcp` (with `/mcp reconnect`), `/skills`, `/goal`, `/review`, `/review-branch`, `/review-commit`, `/compact`, and `/logout`, as well as configured skills.

## Installation

Run the published package directly:

```bash
npx -y @agentclientprotocol/codex-acp
```

Or install it globally:

```bash
npm install -g @agentclientprotocol/codex-acp
codex-acp --version
```

The npm package includes a compatible `@openai/codex` dependency. Set `CODEX_PATH` only when you want the adapter to run a different Codex binary:

```bash
CODEX_PATH=/path/to/codex npx -y @agentclientprotocol/codex-acp
```

To try changes that have landed on `main` but are not released yet, install from the
`preview` channel. Pushes to `main` trigger preview publishing without waiting
for CI or release-please; release commits are excluded, and newer pushes can
replace queued previews. See
[docs/RELEASES.md](docs/RELEASES.md#preview-releases).

```bash
npx -y @agentclientprotocol/codex-acp@preview
```

## Authentication

The adapter advertises ACP auth methods during initialization. Clients can authenticate with:

- ChatGPT login. Set `NO_BROWSER=1` to hide this method in remote or browserless environments.
- API key via `CODEX_API_KEY` or `OPENAI_API_KEY`.
- A custom OpenAI-compatible gateway, when the client opts in to the gateway auth capability.

## Runtime options

### Resuming settings

`session/load` and `session/resume` let Codex restore its last effective model and
reasoning effort when the configured provider is unchanged; explicit Codex
configuration overrides still apply. An explicit change
to a different provider retains Codex's provider-switch behavior. Settings
selected in the client but never used in a prompt are not persisted by the adapter.

Native permissions restore only when they exactly match a supported mode,
including Full access. Read-only and workspace modes additionally require the
corresponding native built-in permission profile: the legacy sandbox projection
can hide custom read restrictions. Exact Full access can also restore without
profile metadata. Unknown or missing permission settings reject load/resume;
the adapter does not install a Session, choose a fallback or send a prompt.
Startup mode defaults apply only to new sessions.

Clients can offer an explicit replacement choice using the
`io.github.euri10.louiselm.resumePermissions` extension. A recoverable ACP error
has code `-32600` and data:

```json
{
  "reason": "resume_permissions_unavailable",
  "io.github.euri10.louiselm.resumePermissions": {
    "version": 1,
    "modes": [{"id": "read-only", "name": "Read-only", "description": "..."}]
  }
}
```

`modes` contains the four supported mode descriptors. The client may display
them alongside Cancel; it must not select a mode automatically or treat this as
an approval request. Only after an explicit choice, retry the original
`session/load` or `session/resume` with
`_meta["io.github.euri10.louiselm.resumePermissions"] = {"version":1,"modeId":"read-only"}`
(using the selected ID). This replaces the saved permission policy, subject to
current native constraints; it does not change Model or effort. A successful
explicit retry acknowledges the same object in response `_meta`, only after
native permissions match the choice. Missing acknowledgement is not consent to
continue. Cancellation leaves the failed load untouched; no retry or prompt is
sent by the adapter.

An older native live-thread fallback may expose no effective permission data
for a Session that has never received a prompt. That empty-history Session
cannot be safely acknowledged as restored; start a new Session instead. Its
error reason is `resume_unmaterialized_unavailable`, without replacement choices
that cannot succeed on that runtime.

### Environment variables

- `CODEX_API_KEY` - API key used when the API-key auth method is selected. Takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` - fallback API key used when the API-key auth method is selected.
- `CODEX_PATH` - run a specific Codex executable instead of the bundled package dependency.
- `CODEX_CONFIG` - JSON object merged into the Codex session config.
- `MODEL_PROVIDER` - model provider to pass to Codex for new sessions.
- `DEFAULT_AUTH_REQUEST` - ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` - initial mode id: `read-only`, `workspace-write`, `agent`, `agent-full-access`, or `permission-profile:<profile-id>`.
- `NO_BROWSER` - hide browser-based ChatGPT auth when set.
- `APP_SERVER_LOGS` - directory for adapter logs.

## Development

```bash
npm install
npm run start
npm run typecheck
npm test
```

Build standalone binaries in `dist/bin` with:

```bash
npm run bundle:all
```

See [readme-dev.md](readme-dev.md) for local client configuration, binary packaging, and Codex type regeneration.

### Subagent sessions

Codex subagents are reported as ACP child sessions that follow the ACP [Subagent Sessions RFD](https://agentclientprotocol.com/rfds/subagents). A v1 client opts in with `clientCapabilities.subagents: {}` during `initialize`. A v2 client gets them without negotiation. The adapter announces each child with `subagent_update`, reports delegated tasks as `session_message`, and references children from collaboration tool calls with `session` content. A client can cancel a child's current work with `session/cancel`.

JetBrains AIR clients keep an older private contract instead. Without either contract, the subagent lifecycle stays an ordinary ACP tool call.

See [docs/subagent-sessions.md](docs/subagent-sessions.md) for both contracts, `session/load` replay, and the fallback.

### Background terminal tasks

Codex can keep a shell command running after a turn continues. AIR clients can show this work in the Async Tasks panel and stop one command.

See [AIR extensions](docs/air-extensions.md#async-tasks) for the capability, lifecycle events, and stop request.

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
