# Current status

## Implemented

- Agent Gateway with MCP, HTTP, and optional ACP adapters.
- External-agent orchestration by default (`JARVIS_ORCHESTRATION=external`). The internal planner remains behind `JARVIS_ORCHESTRATION=legacy` only and must not be reintroduced as the default loop.
- Optional Node laptop Brain server.
- Gemini and Anthropic provider support in laptop mode.
- Embedded Brain hosted by the React Native app in the current phase.
- Android foreground service.
- Accessibility observation and actions.
- Notification listener.
- SMS/call bridge foundations.
- Floating overlay.
- Local AI Runtime screen.
- MediaPipe/LiteRT local model import, load, offline test, diagnostics foundations.
- Event Bus.
- Rule Engine.
- World State Manager.
- Working Memory.
- Screen Observer.
- Context Builder.
- Event History.
- Capability Manager foundation.
- Generic app resolution from installed launcher apps and observable labels.

## Scaffolded

- Goal Manager.
- Memory Core candidate pipeline.
- Long-term runtime replacement boundary.
- Local model registry/recommendation system.
- Developer diagnostics and observability surfaces.

## Planned

- Dedicated embedded JavaScript runtime for the Brain.
- Durable Memory Core with embeddings and retrieval.
- Wake word and voice instruction path.
- Vision layer as a supplement to Accessibility.
- Plugin SDK.
- Autonomous behavior policy.
- Production release hardening.
- Better benchmark-driven local model recommendation.

## Known constraints

- React Native still owns embedded Brain lifecycle.
- Durable procedure memory is implemented as lexical RAG playbooks. Embeddings are not required. Pins and secrets are redacted; review `brain/data/procedures.jsonl` for leftover private text.
- Wake word is not implemented.
- Vision is not implemented.
- Planner quality depends on selected LLM/model.
- Jarvis cannot unlock the phone, approve biometrics, enter PINs, or read `FLAG_SECURE` screens.
- Logs and traces can contain private data.
