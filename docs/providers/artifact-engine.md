# Artifact Engine

Artifact Engine is a local, OpenAI-compatible provider registered in the CLI and Gateway. It can serve chat completions and embeddings without sending requests to a third-party model API.

## Requirements

Run Artifact Engine locally with its OpenAI-compatible server enabled. By default, Symbiote connects to `http://127.0.0.1:8080`; use the server's `/v1/models` endpoint to find the loaded chat model ID.

## Chat configuration

```json
{
  "defaultProvider": "artifact-engine",
  "defaultModel": "YOUR_LOADED_MODEL_ID",
  "providers": {
    "artifact-engine": {
      "baseUrl": "http://127.0.0.1:8080/v1"
    }
  }
}
```

No external API key is required. The adapter supplies a local placeholder if the server expects an authorization header. If the service uses a non-default host or port, set `baseUrl` to its compatible endpoint.

## Model discovery

Symbiote discovers models from `GET /v1/models` on the configured base URL. Discovery results are cached briefly for interactive provider and model selection.

## Neural memory

Artifact Engine can also provide embeddings for the optional dense-memory index. Configure `memory.neural.provider` as `artifact-engine`, set `baseUrl` to the server's `/v1` endpoint, and choose a model with embedding support. For details and limitations of the local embedding implementation, see [Optional neural memory](../getting-started/configuration.md#optional-neural-memory).

Chat model availability and embedding capability depend on the models loaded by the local server.
