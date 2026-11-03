# Neural Memory and VDB

Symbiote keeps its original documents and lexical index in the local VDB. When neural memory is enabled, it adds dense embeddings and a persistent HNSW index without replacing or discarding existing records.

Retrieval combines:

- BM25 and TF-IDF lexical ranking for exact terms.
- Dense cosine similarity for semantic matches.
- Reciprocal-rank fusion, metadata filters, importance, and time decay.
- Original VDB text and provenance when returning a result.

Conversation turns are episodic, imported skills are procedural, and Memograph facts are classified as episodic, semantic, or relational. Boot knowledge, projects, and other records retain their source references. The VDB remains the source of truth; the dense index is a rebuildable derivative.

## Enable local embeddings

Install Ollama and a model, then enable the neural block in `symbiote.json`:

```json
{
  "memory": {
    "neural": {
      "enabled": true,
      "provider": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "model": "bge-m3",
      "lexicalWeight": 0.4,
      "denseWeight": 0.6,
      "temporalHalfLifeDays": 180
    }
  }
}
```

```sh
ollama pull bge-m3
```

The configured model can be changed to another Ollama embedding model, such as `qwen3-embedding:8b`. Each provider/model pair gets a separate index; existing VDB documents are embedded incrementally after a model change. No cloud embedding service is required.

The persistent dense index is stored under `<workspace>/.symbiote/neural-memory/`. Memory tools and context retrieval continue to use lexical VDB results if the embedding service is unavailable, and report the degraded state rather than treating it as a successful dense search.

The current engine is local-only. A remote/self-hosted vector-store API, entity extraction, automated contradiction resolution, and multi-vector model support are not yet implemented.
