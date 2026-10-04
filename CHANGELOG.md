# Changelog

## 0.1.1 — 2026-10-04

- **Connect a model:** pick Gemini, Groq, OpenRouter, OpenAI, DeepSeek, Ollama or LM Studio from a list. ApexDev sets the endpoint, asks for the key (with a link to the provider's key page) and picks a model the provider actually offers — no more editing the base URL by hand.
- New `/provider` command and **ApexDev: Connect a Model** in the Command Palette; **Change provider…** in the model picker opens the same list.
- A rejected API key now offers **Set API key** even when the provider answers with `400` (Gemini does).
- Updated the suggested Gemini model to `gemini-3.8-flash`; `gemini-2.5-flash` is no longer available to new Gemini users.

## 0.1.0 — 2026-10-04

First public release.

- Autonomous agent loop with a live plan, retries and automatic context trimming.
- Works with any OpenAI-compatible provider; model picker lists your provider's models and remembers recent ones.
- Composer with permission modes (Ask / Auto edits / Auto mode), `@` file and folder attachments, `/` commands, image attachments and voice input.
- Tools for files, search, terminal, VS Code (Problems, tasks, debugging), a real Chrome/Edge browser and the Windows desktop.
- Memory across chats, `APEXDEV.md` project notes, read-only sub-agents and saved chat history.
- API key stored in VS Code SecretStorage; no telemetry.
