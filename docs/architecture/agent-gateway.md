# Agent Gateway

Jarvis is an Android execution platform. External agents own reasoning, planning, tool selection, retries, and completion. Jarvis owns device capabilities, permissions, observations, memory/context services, and safety.

```text
Any agent
  -> Protocol adapter (MCP, HTTP, optional ACP)
  -> Jarvis Gateway
  -> Capability Manager
  -> Android
  -> Observation
  -> Agent decides next action
```

OpenCode is the first integration target, not a core dependency.

## Protocols

- **MCP**: how an agent discovers and invokes Jarvis tools. Implemented at `POST /mcp` and `npm run mcp`.
- **ACP**: how a host can drive an agent such as OpenCode. Optional. Jarvis can be an ACP client; OpenCode still uses Jarvis through MCP.
- **HTTP**: agent-agnostic `GET /v1/tools` and `POST /v1/tools/invoke`.

## Runtime

OpenCode is a Node/system CLI. It does not run inside Android.

```text
Android Jarvis app
  -> laptop Brain / Gateway (port 3000)
  -> OpenCode or another MCP/HTTP agent
```

Set `JARVIS_ORCHESTRATION=legacy` only if you need the old internal LLM loop. Default is `external`.

## OpenCode

```bash
cd brain
npm start
# another terminal
opencode mcp add jarvis --url http://127.0.0.1:3000/mcp --header Authorization=Bearer $PHONE_AUTH_TOKEN
```

Or stdio (must set auth; HTTP MCP at `/mcp` is the recommended path):

```bash
export JARVIS_AUTH_TOKEN="$PHONE_AUTH_TOKEN"
export JARVIS_GATEWAY_URL="http://127.0.0.1:3000/mcp"
opencode mcp add jarvis -- npm run mcp
```

Missing `JARVIS_AUTH_TOKEN` / `PHONE_AUTH_TOKEN` exits with an error instead of silently failing.

Then ask OpenCode to `open_app` after `resolve_app`. Jarvis executes and returns an observation. OpenCode decides the next tool.

## Tool contract

Device actions return machine-readable JSON. Bare `success` / `ok` / `true` normalize to `{ok:true}`. Arrays (`list_apps`, `get_recent_calls`) stay arrays.

Preferred UI primitive: `find_and_click` (on-device find + click). `find_element` + `click_element` remains available.

Preferred navigation: `press_back` (reports `keyboardDismissed`, `screenChanged`, and `navigated`). Preferred hang-up: `end_call`.

`read_screen` returns `observationFresh`. A recent cached tree may be returned after a transition instead of timing out.

`find_and_click` prefers non-editable content over input fields and reports `MATCH_AMBIGUOUS` or `NO_VISIBLE_CHANGE` instead of a false success.

`compose_message` drafts only and pins a messaging package (default SMS / Google Messages). It does not pick caller-ID apps such as Truecaller unless that package is requested, does not change the default SMS app, and reports `NOT_DEFAULT_SMS_APP` when a draft cannot be created. `send_sms` and `make_call` require `confirmSensitive=true`.

`open_app` launches the exact requested package and reports `requested`, `resolvedPackage`, and `openedPackage`. It does not fuzzy-substitute a different app.

`find_and_click` performs exactly one click per request (`clickCount: 1`). Stale recovery does not click again after a side effect was dispatched.

The catalog in `brain/src/capabilityCatalog.ts` is the single source of truth for HTTP, MCP, and the gateway.

## Learned procedures (RAG)

Jarvis persists successful device paths in `brain/data/procedures.jsonl` on the laptop brain (override with `JARVIS_MEMORY_PATH`). The portable/React Native brain keeps the same playbooks in RAM plus built-in seeds so Metro never bundles `node:fs`. `get_relevant_context` and `get_similar_procedures` retrieve the closest playbooks. `remember_procedure` / `complete_task` save the current session so the next similar goal does not start from zero. Observations may include `learnedPlaybook` when a prior path matches. Pins and long numbers are redacted. This is memory for the external agent, not an internal planner loop.
