# ApexDev Code

An autonomous AI coding agent for VS Code. Give it a goal in the sidebar and it reads your code, plans the steps, edits files and runs commands, then checks the result.

It works with **any OpenAI-compatible API** — OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, Together, Mistral, LM Studio, Ollama and others. You bring your own API key; requests go straight from VS Code to your provider.

## Install

- **VS Code:** open the Extensions view (`Ctrl+Shift+X`), search for **ApexDev Code** and click **Install**.
- **Cursor, VSCodium, Windsurf:** search for **ApexDev Code** in the extensions view (published on Open VSX).
- **Offline / manual:** download the `.vsix` from the [GitHub releases](https://github.com/UsamaShafique218/apexdev-code/releases), then run `code --install-extension apexdev-code-<version>.vsix` or use **Extensions → … → Install from VSIX…**.

## Get started

1. Click the **ApexDev** (△) icon in the activity bar, or press `Ctrl+Alt+A` (`Cmd+Alt+A` on macOS).
2. Click **Add API key** and paste your key. It is stored in VS Code's encrypted SecretStorage, never in settings files.
3. Pick your provider: open the model chip in the composer → **Change provider…**, or set these in Settings (`ApexDev`):

| Provider   | `apexdev.baseUrl`                                          | Example `apexdev.model`   |
| ---------- | ---------------------------------------------------------- | ------------------------- |
| OpenAI     | `https://api.openai.com/v1`                                | `gpt-4o`                  |
| Gemini     | `https://generativelanguage.googleapis.com/v1beta/openai`  | `gemini-2.5-flash`        |
| OpenRouter | `https://openrouter.ai/api/v1`                             | `openai/gpt-4o`           |
| Groq       | `https://api.groq.com/openai/v1`                           | `llama-3.3-70b-versatile` |
| DeepSeek   | `https://api.deepseek.com/v1`                              | `deepseek-chat`           |
| LM Studio  | `http://localhost:1234/v1` (no key needed)                 | the loaded model's ID     |
| Ollama     | `http://localhost:11434/v1` (no key needed)                | `qwen2.5-coder:14b`       |

4. Type a goal, for example *"Add a dark mode toggle to the settings page and make sure the tests still pass"*, and press Enter.

The model must support **tool / function calling**. The model picker lists every model your provider offers and remembers the ones you used recently.

## The composer

| Control        | What it does                                                                  |
| -------------- | ----------------------------------------------------------------------------- |
| Mode           | **Ask mode** (approve every edit and command), **Auto edits** (edits apply on their own, commands still ask) or **Auto mode** (everything runs; risky commands still ask) |
| `@`            | Attach a file or folder from your workspace to the message                    |
| `/`            | Commands: `/explain`, `/fix`, `/test`, `/review`, `/init`, `/new`, `/history`, `/model`, `/mode`, `/memory`, `/key`, `/settings` |
| Image          | Attach or paste screenshots and mockups (needs a vision model)                |
| Model chip     | Search and switch models, change provider, set the API key                    |
| Microphone     | Speak your request; it is transcribed into the input box (Windows)            |

## What it can do

- **Agent loop:** plans the work, runs tools, reads the results and repeats until the task is done. It retries on rate limits, can be stopped at any time and trims old context automatically.
- **Files, search and terminal:** reads, writes and edits files, searches with glob and grep, and runs commands (with timeouts and background processes). New VS Code errors after an edit are reported back to the model.
- **VS Code:** reads the Problems panel, open editors and terminals, runs tasks, starts debugging and executes VS Code commands.
- **Live plan:** a sticky Plan panel above the composer shows progress and the current step.
- **Browser:** drives a real Chrome or Edge window (its own profile) to open, test and use web pages, including console errors.
- **Desktop (Windows):** sees the screen and operates desktop applications through UI Automation, OCR, mouse and keyboard.
- **Memory and project notes:** remembers preferences across chats, and follows an `APEXDEV.md` file in your workspace root (`/init` creates one).
- **Sub-agents:** delegates research to read-only agents that run in parallel.
- **Chat history:** chats are saved automatically and can be reopened from the History button or `/history`.
- **Your language:** greets you in English and replies in the language you write in, including Roman Urdu.

## Privacy and safety

- Your API key stays in VS Code SecretStorage. Requests go directly to the provider you configure — there is no ApexDev server and no telemetry.
- In **Ask mode** every file change shows a diff and waits for your approval. Browser and desktop actions are treated like commands.
- Destructive commands (`rm -rf`, `git push`, `Remove-Item -Recurse` and similar) always ask, in every mode.
- The memory tool refuses to store secrets.

## Settings

| Setting                            | Default                     | Description                                           |
| ---------------------------------- | --------------------------- | ----------------------------------------------------- |
| `apexdev.baseUrl`                  | `https://api.openai.com/v1` | OpenAI-compatible endpoint                            |
| `apexdev.model`                    | `gpt-4o`                    | Model ID                                              |
| `apexdev.permissionMode`           | `ask`                       | `ask` · `autoEdit` · `fullAuto`                       |
| `apexdev.maxTokens`                | `0`                         | Max output tokens (`0` = provider default)            |
| `apexdev.temperature`              | `null`                      | Sampling temperature (`null` = provider default)      |
| `apexdev.maxIterations`            | `60`                        | Model ↔ tool round trips per request                  |
| `apexdev.contextCharBudget`        | `400000`                    | Conversation size before old tool output is trimmed   |
| `apexdev.shell`                    | `auto`                      | `auto` (Git Bash → PowerShell) · `bash` · `powershell` · `cmd` |
| `apexdev.vision`                   | `true`                      | Send screenshots to the model (needs a vision model)  |
| `apexdev.voice.transcription`      | `chat`                      | `chat` (audio-capable chat model, e.g. Gemini) · `whisper` (`/audio/transcriptions`) |
| `apexdev.voice.model`              | `""`                        | Transcription model (empty = chat model / `whisper-1`) |
| `apexdev.browser.enabled`          | `true`                      | Browser tools                                         |
| `apexdev.browser.executablePath`   | `""`                        | Chrome/Edge path (empty = auto-detect)                |
| `apexdev.browser.headless`         | `false`                     | Run the browser without a window                      |
| `apexdev.desktop.enabled`          | `true`                      | Desktop tools (Windows)                               |
| `apexdev.memory.enabled`           | `true`                      | Memory tool and remembered facts in the prompt        |
| `apexdev.subAgents.enabled`        | `true`                      | Read-only research sub-agents                         |
| `apexdev.subAgents.maxIterations`  | `30`                        | Round trips per sub-agent                             |
| `apexdev.history.enabled`          | `true`                      | Save chats                                            |

## Requirements

- VS Code 1.90 or newer (or a compatible editor such as Cursor or VSCodium).
- An API key for an OpenAI-compatible provider, or a local server such as Ollama or LM Studio.
- Desktop control and voice input need Windows. Browser tools need Chrome or Edge installed.

## Feedback and contributing

Report bugs and ideas on [GitHub Issues](https://github.com/UsamaShafique218/apexdev-code/issues). See [CONTRIBUTING.md](CONTRIBUTING.md) to build and run the extension from source.

## License

[MIT](LICENSE)
