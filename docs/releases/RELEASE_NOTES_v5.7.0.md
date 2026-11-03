# Symbiote v5.7.0 - Apex

**Released November 2, 2026**

Symbiote 5.7.0 adds a first-class connector platform, agent-enabled Markets and intelligence workspaces, optional local neural memory, and a more responsive startup and recovery experience. It also brings major improvements to hands-free voice, the agent's state animations, and the Memory graph.

## Major upgrades

- **Faster, staged startup:** The Gateway now reports core readiness before launching integrations, channels, memory, market-data, and self-improvement initialization as concurrent Gamma background tasks. Optional startup work no longer holds the core ready signal hostage. Electron displays a dedicated animated thinking-orb startup screen, with a clear status if the Gateway takes longer to connect. Heavy webapp views are loaded on demand.
- **A coherent four-state agent orb:** Replaced the scattered particle swarm with a single, deterministic hero animation that transitions between idle, thinking, executing, and responding states. The animation uses 1,000 particles and reflects the live agent state.
- **Connector platform:** Added manifest-based REST and MCP adapters, encrypted credential storage, explicit per-agent capability grants, connection health checks, and bounded execution history. The initial REST catalog includes GitHub, Notion, Slack, Figma, and Canva.
- **Markets and public intelligence:** Added an agent-enabled Markets workspace with public price and history feeds, persistent chart drawings and indicators, a chart tool, and dedicated chat and voice input. An optional MetaTrader 5 bridge supports market data and trade-journal synchronization. The resource aggregator adds OpenSky aircraft positions and further public market and intelligence sources.
- **A richer Memory experience:** Added optional local neural retrieval using Ollama embeddings and a persistent HNSW index alongside lexical VDB search. Restored the Memory map as a responsive 3D force graph, with clustered nodes, filtering, node details, and image export.
- **Hands-free voice:** Added profile-driven wake-word activation so the phrase follows the active agent's name rather than a hardcoded alias. Voice activation can open a fresh chat with listening enabled; dictation supports a trailing “send” command. Added optional offline Vosk speech recognition with a persistent worker.
- **Provider and workflow options:** Registered FreeAI in the CLI and Gateway and added provider/model discovery for interactive switching. Added admin-only n8n workflow operations and safer local-first integration controls.

## Fixes and reliability

- Improved speech recognition for short recordings by finalizing audio before recognition and adding trailing silence. Wake-word matching now normalizes names and tolerates common speech-recognition variation. Offline Vosk falls back to Windows speech recognition when its package or model is unavailable.
- Improved Gateway startup and recovery reporting so background initialization failures are visible and do not prevent the core-ready state. Electron supervises Gateway startup and provides a useful recovery status rather than leaving an uninformative blank window.
- Improved chart-state persistence and public data-source status handling.
- Corrected the hero orb's display size to prevent stretching and removed its brightness control without affecting global appearance settings.
- Improved Windows project-terminal lifecycle handling and session continuity.

## Additional improvements

- Refined the API registry, integrations, browser, IDE, maps, health, and Markets interfaces for more consistent layout and theme behavior.
- Added CI, CodeQL, release publishing, dependency-update, and repository-label automation.
- Added desktop and mobile screenshots for the webapp, native recovery UI, and CLI.
- Updated release packaging to publish version-matched assets and SPDX software bills of materials.

## Upgrade notes

- No existing configuration migration is required.
- Connectors are optional. Provide credentials for each service you choose to connect and grant agents only the capabilities they need.
- Neural memory is optional and requires Ollama plus a locally installed embedding model. The example configuration uses `bge-m3`; `qwen3-embedding:8b` is another option. Existing lexical memories remain available without neural memory.
- Offline Vosk recognition requires the `vosk` Python package and the `vosk-model-small-en-us-0.15` model under `.symbiote/models`. Set `SYMBIOTE_VOICE_MODEL` to use a model elsewhere. Windows speech recognition remains the fallback if Vosk is unavailable.
- The MetaTrader 5 bridge is optional and requires a configured MetaTrader 5 terminal and its Python integration.
- To build from a source checkout, run `npm ci`, `npm --prefix webapp ci`, then `npm run build`.
