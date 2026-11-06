# Cloudflare Workers AI

Symbiote connects to Cloudflare Workers AI using its OpenAI-compatible chat-completions endpoint. Cloudflare remains an optional provider; setting it up does not change `defaultProvider`.

## Credentials

1. Copy your Cloudflare account ID from the Cloudflare dashboard.
2. Create an API token with Workers AI read and write permissions.
3. Add both values to `.env`:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-32-character-account-id
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
```

Keep the token private and do not commit `.env`.

## Configuration

Add a provider entry to `symbiote.json`:

```json
{
  "providers": {
    "cloudflare": {
      "accountId": "${CLOUDFLARE_ACCOUNT_ID}",
      "apiKey": "${CLOUDFLARE_API_TOKEN}",
      "model": "@cf/zai-org/glm-4.7-flash",
      "maxTokens": 4096,
      "contextWindow": 32768
    }
  }
}
```

Choose any model ID supported by your Workers AI account; model IDs commonly use the `@cf/` namespace. Check the [Workers AI model catalog](https://developers.cloudflare.com/workers-ai/models/) for availability. Provider `models` lists model IDs permitted for SARSI routing; each route still uses the model specified by its SARSI rule. Add `"cloudflare"` to the top-level `sarsiProviders` list to permit these routes, independently from `fallbackProviders`. To make Cloudflare the default, set `defaultProvider` to `cloudflare` and set `defaultModel` to the exact model ID.

Set `contextWindow` to the limit actually accepted by your account/model endpoint and `maxTokens` to the desired output ceiling. The agent reserves space for both output and tool definitions, then trims older conversation messages before sending a request. Some Cloudflare-compatible routes report a smaller effective limit than the published model catalog.

Model discovery uses Cloudflare's account-scoped [Workers AI model search API](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/). Chat requests use the account-scoped OpenAI-compatible `/ai/v1/chat/completions` endpoint.

## SARSI model assignments

The recommended low-overhead routing assignments use the listed models' catalog capabilities:

| SARSI task | Model | Reason |
|---|---|---|
| `code` | `@cf/zai-org/glm-4.7-flash` | Tool calling and reasoning, with a 131K context window |
| `reasoning` | `@cf/zai-org/glm-5.3-flash` | Reasoning and tool calling with a 1M context window |
| `creative` | `@cf/openai/gpt-oss-20b` | Lower-latency general generation with tool calling |
| `simple_qa` | `@cf/qwen/qwen3-30b-a3b-fp8` | Cost-efficient text model with reasoning and tool calling |
| `long_context` | `@cf/deepseek-ai/deepseek-v4-flash-0731` | 1M context with reasoning and tool calling |

These are recommendations, not proof of account entitlement. Cloudflare's catalog lists per-token pricing for these models, and model access depends on the account plan. In particular, a previous check found `@cf/deepseek-ai/deepseek-v4-pro-0813` is unavailable on the Workers Free plan; that Pro model is intentionally not used by these routes.
