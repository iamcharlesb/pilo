# Draft X thread

Status: not published. Each numbered item is a separate post.

1. New in Pilo: model-provider choice is now in Settings. Pick OpenAI, Qwen, or Kimi, paste your API key, and save. Suggested models/endpoints are prefilled; regional and custom endpoints stay editable.

2. The change underneath: one provider factory for client creation across Pilo’s execution engines. Each provider keeps its own credentials and endpoint. Your workflow can stay familiar when you change models.

3. Token costs need more than a cheaper model. Pilo’s token-lean loop uses compact instructions, on-demand playbooks, bounded code excerpts, and context limits. Designed to trim unnecessary input; no universal savings percentage claimed.

4. Also shipped: clearer first-run docs, compact Send/Stop controls, and composer-focus fixes. Hosted calls are provider-billed. The source checkout currently requires private submodule access. Built by me: https://github.com/iamcharlesb/pilo
