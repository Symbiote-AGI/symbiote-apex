# Provider Abstraction

This directory documents the normalized provider layer used by the runtime.

## Available Providers

| Provider | Doc | Auth |
|----------|-----|------|
| Groq | [groq.md](groq.md) | `GROQ_API_KEY` |
| Anthropic | [anthropic.md](anthropic.md) | `ANTHROPIC_API_KEY` |
| OpenAI | [openai.md](openai.md) | `OPENAI_API_KEY` |
| Gemini | [gemini.md](gemini.md) | `GEMINI_API_KEY` |
| xAI | [xai.md](xai.md) | `XAI_API_KEY` |
| GitHub Copilot | [github-copilot.md](github-copilot.md) | `gh auth` |
| Ollama | [ollama.md](ollama.md) | Local |
| Gladius | [gladius.md](gladius.md) | Local |
| Artifact Engine | [artifact-engine.md](artifact-engine.md) | Local |
| OpenRouter | [openrouter.md](openrouter.md) | `OPENROUTER_API_KEY` |
| NVIDIA | [nvidia.md](nvidia.md) | `NVIDIA_API_KEY` |
| Cloudflare Workers AI | [cloudflare.md](cloudflare.md) | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
| FreeAI | [freeai.md](freeai.md) | `FREEAI_API_KEY` |

## Overview

- [Provider Overview](overview.md) — the provider contract, message model, and adapter policy

The table above lists providers currently registered for CLI and Gateway selection. These documented adapters are not currently registered for selection:

- [Qwen](qwen.md)
- [AI Horde](aihorde.md)
- [OmniRoute](omniroute.md)

Use this abstraction when adding new backends so the engine stays provider-agnostic.
