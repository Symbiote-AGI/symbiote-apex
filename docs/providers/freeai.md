# FreeAI Provider

FreeAI provides free-tier access to multiple LLM models through a single API endpoint.

## Configuration

```json
{
  "providers": {
    "freeai": {
      "apiKey": "${FREEAI_API_KEY}",
      "baseUrl": "https://api.freetheai.org/v1"
    }
  }
}
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `FREEAI_API_KEY` | Yes | API key from the FreeAI service |

## Notes

- Free tier with rate limits.
- Good for development and testing.
- Model availability may change.
- Chat requests and model discovery use `Authorization: Bearer`; keep the key in `.env` and reference it from `symbiote.json`.
