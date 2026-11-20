# Reddit release update

Status: published to r/SideProject as u/Stunning_Progress_19 on November 20, 2026. Verified the post title and body at its permalink.

Post: https://www.reddit.com/r/SideProject/comments/1y1g6jc/i_updated_my_local_ai_agent_app_so_switching/

## Title

I updated my local AI agent app so switching model providers doesn’t mean rewriting the workflow

## Post

I’m building Pilo, a local desktop app for working with personal and specialist bots. This week’s change came from a setup problem: choosing a model provider required knowing too much about the internals.

The new Settings flow has presets for OpenAI, Qwen, and Kimi. Choose a provider, paste its API key, and save. The model and endpoint are prefilled, with overrides for regional endpoints and other compatible services. Qwen’s endpoint still needs to match the key’s region.

The useful part is that the bot workflow stays the same. You can choose a provider for the task instead of rebuilding your setup around one vendor. Provider-specific credentials and client creation now live behind a shared factory.

I’m also trying to keep context costs understandable. Pilo uses compact operating instructions, retrieves relevant playbooks and project excerpts when needed, and bounds older conversation rounds in its token-lean engine. That is designed to avoid resending unnecessary context. I don’t have a verified percentage-savings claim, and a cheaper model isn’t automatically cheaper overall if it needs more retries.

Other changes in this update: clearer installation docs, smaller controls, a single Send/Stop position, and fixes for composer focus and portrait animations.

Disclosure: I built Pilo. It runs locally, but hosted model requests are billed by the provider. The current source checkout requires access to a private application submodule, so the public repo alone is not a complete install.

Project and setup: https://github.com/iamcharlesb/pilo

For people who use multiple model APIs: what would make you switch providers for a task—cost, tool reliability, image support, or response speed?
