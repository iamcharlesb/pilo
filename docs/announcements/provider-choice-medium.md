# Draft for Medium

Status: not published.

## Pilo’s latest update makes model choice part of the workflow

### A simpler setup, a shared provider factory, and a more deliberate approach to context costs

An agent app should make it easy to start with the model provider you already use. It should also let you change that choice as your tasks change.

That is the focus of this Pilo update.

Pilo is the local desktop bot workspace I’m building for research, writing, coding, and permitted browser tasks. The latest version adds a simpler connection flow for OpenAI, Qwen, and Kimi, alongside the existing model options.

### From configuration work to a short Settings flow

Open Settings, choose a provider, paste its API key, and save. Pilo supplies a suggested model and endpoint, while keeping both editable. Users with a regional Qwen account can enter the API Host matching their key. Other OpenAI-compatible services can be configured with their own endpoint and model ID.

Saving a connection does not start a model request. The selected configuration applies to subsequent requests, and existing runs keep the client they started with.

For users who prefer files, the environment example now puts the basic provider settings first. Google sign-in, MongoDB, and voice services are optional. The installation guide walks through cloning with submodules, installing dependencies, launching the app, and making the first test request.

### Why the factory matters

Previously, provider-specific client construction appeared in several parts of the runtime. That makes new providers harder to add and configuration mistakes easier to repeat.

The new flow separates three responsibilities:

- A registry describes provider presets and environment variable names.
- Model resolution identifies the provider and API mode for the selected model.
- A shared factory creates the configured client for the interactive engines and patch proposals.

Each provider uses its own credential and endpoint. Adding Qwen or Kimi does not mean sending an OpenAI key to another service. Tool permissions and approval decisions remain application responsibilities.

This is protocol compatibility, not a promise that every model can do every task. A browser workflow that uses screenshots needs image input and tool calling. A text-only model can still be useful for text tasks.

### Token efficiency is more than the price of one request

Provider choice gives users another cost lever. The amount of context sent to that provider matters too.

Pilo’s token-lean engine uses compact operating instructions, loads relevant playbooks when needed, retrieves bounded project excerpts, and removes complete older rounds when the configured context budget is exceeded. Images have a separate retention budget. The SDK engine shares task limits but does not inherit every history-compaction behavior of the token-lean loop.

These mechanisms are intended to reduce unnecessary context. They do not establish a universal savings percentage. Total cost depends on the model’s pricing, input and output tokens, tool results, retries, and the number of steps needed to finish.

The metric I want to improve is cost per useful completed task, alongside reliability. Selecting a lower-priced model helps only if it can complete the job adequately.

### A calmer desktop workspace

The update also tightens the day-to-day interface: smaller icons, a compact black Send/Stop control, improved composer focus, and stationary human portraits. The Mac Dock gets a separate blue-and-white Pilo icon while the mascot remains inside the app.

Pilo is still early. Hosted model calls can incur charges, and the public repository currently depends on a private application submodule. The documentation explains that requirement before installation.

The goal of this release is straightforward: fewer setup hurdles, more control over model choice, and clearer expectations about what the runtime sends and spends.

Project and setup guide: https://github.com/iamcharlesb/pilo
