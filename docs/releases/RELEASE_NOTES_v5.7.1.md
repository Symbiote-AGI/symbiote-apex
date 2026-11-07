# Symbiote v5.7.1 - Stability and Gateway Reliability

**Release date:** November 7, 2026

Symbiote 5.7.1 focuses on a faster, more reliable Gateway and Electron runtime, provider hot-swapping, and preventing model context overflow.

## Added

- Cloudflare Workers AI provider support with account-scoped model discovery and documented SARSI model assignments.
- Artifact Engine as a local OpenAI-compatible provider, with model discovery and optional neural-memory embedding support.
- Discord provider/model selection and discovery for live provider hot-swapping.

## Changed

- Electron starts and supervises the Gateway, detects stale build output, and coordinates clean restarts without launching competing Gateway processes.
- Session summary caching and coalesced neural-memory backfills reduce repeated work during startup and session listing.
- Provider-specific context and output limits account for conversation history, tool schemas, generated output, and safety overhead.

## Fixed

- Cloudflare context overflow is prevented by selecting relevant tool schemas and trimming conversation history to fit the configured model context window.
- WebSocket handshake timeout handling and Discord interaction acknowledgement/reconnect paths are more resilient.
- Gateway startup and restart handling avoid stale child processes and repeated initialization work.

## Upgrade notes

- No configuration migration is required.
- Cloudflare context budgeting depends on a valid `contextWindow` and `maxTokens` configuration for the selected model.
- Source checkouts should use `npm ci`, `npm --prefix webapp ci`, then `npm run build`.
