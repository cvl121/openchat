# OpenChat

[![Test](https://github.com/cvl121/openchat/actions/workflows/test.yml/badge.svg)](https://github.com/cvl121/openchat/actions/workflows/test.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/status-beta-orange.svg)](https://github.com/cvl121/openchat/releases)

> **OpenChat is in beta.** It's stable for daily use, but expect rough edges and occasional breaking changes before 1.0.

**OpenChat** — a fast, local-first, open-source desktop AI chat app with two personalities: a clean general-purpose assistant chat, and a full story/role-play environment inspired by [SillyTavern](https://github.com/SillyTavern/SillyTavern).

OpenChat is built for instant startup, no server, no browser tabs, all data on your machine — in a cross-platform codebase with zero build step and a single dependency (Electron itself).

| Light | Dark |
|---|---|
| ![OpenChat in light mode](docs/screenshot-light.png) | ![OpenChat in dark mode](docs/screenshot-dark.png) |

## Why not just SillyTavern?

SillyTavern is the power tool: a browser app behind a Node server with a huge surface of extensions and knobs. OpenChat trades that surface for a double-clickable desktop app that works out of the box:

| | OpenChat | SillyTavern |
|---|---|---|
| Install | Download a signed installer, open it | Node.js + git + a server you keep running |
| First chat | Paste one API key in the setup wizard | Pick and configure an API backend first |
| Character cards, personas, lorebooks, swipes, presets | ✓ (TavernCardV2-compatible) | ✓ |
| Group chats, extensions, regex scripts, image pipelines | Not yet | ✓ |
| Also a clean general-purpose assistant app | ✓ (default mode) | — |

Your data stays compatible: character PNGs, world-info JSON, chat JSONL, and presets import directly from a SillyTavern install — and export back out.

## Highlights

- **Two app modes** — **Chat** (the default) is a straightforward AI assistant with conversation history, file uploads, and image responses. **Story** unlocks role-playing with character cards, personas, world lore, swipes, and story tools. Switch anytime in Settings → General.
- **Bring your own key — or none** — designed primarily around **OpenRouter** (one key, hundreds of models, live searchable model list), with OpenAI, Anthropic Claude, Google Gemini, DeepSeek, Kimi, Qwen, local **Ollama** (no key, runs on your machine), and any **custom OpenAI-compatible server** (LM Studio, vLLM, llama.cpp, Groq, Together, …) also supported.
- **Attachments & images** — attach images and text files to messages (multimodal models see the images; text files are inlined), and image-capable models can reply with images that are saved locally.
- **Local-first** — characters, chats, settings, and API keys never leave your machine except as requests to your chosen AI provider. The only other network call is an optional once-a-day version check against GitHub Releases (Settings → General).
- **Compatible formats** — TavernCardV2 character cards (PNG/JSON), SillyTavern-style JSONL chats, world info books, and presets. One-click import of an existing data folder.
- **Two user modes** — Regular mode keeps the UI clean and simple; Advanced mode unlocks deep customization of AI responses (see below).

## Chat vs. Story Mode

Switch in **Settings → General → App Mode**.

| | Chat (default) | Story |
|---|---|---|
| Streaming assistant chat, conversation list with auto-titles, search, export | ✓ | ✓ |
| File uploads (images & text) and image responses | ✓ | ✓ |
| Custom assistant system prompt | ✓ | — (per-character prompts) |
| Character cards, editor, PNG/JSON import-export | | ✓ |
| Personas, world lore books, generation swipes on greetings | | ✓ |
| Prompt overrides & reminder prompt (Advanced) | | ✓ |

Chat mode keeps the sidebar as a simple conversation list (rename, export, delete via right-click). Story mode is a full role-playing environment: it restores the character roster and all world-building tools.

## Features

### Chat
- **Streaming responses** rendered live as tokens arrive, with a Stop button / Escape key — plus automatic retry with backoff on rate limits and server errors, and a stall timeout so a dead connection never hangs a chat
- **File uploads** — attach images and text files via the 📎 button, paste, or drag-and-drop; images go to multimodal models as image parts, text files are inlined into the prompt
- **Image generation** — enable in Settings → API to get a 🎨 button that sends your prompt to a dedicated image provider/model (separate from your chat model); generated images render in the chat and can be saved to Downloads or any folder. Asking the chat model for an image in a plain message also works: if the chat model can't produce one, the request is automatically re-routed to your image model
- **Chat compression** — long chats are summarized in the background (threshold configurable) so each new reply stops resending the full history; Advanced mode can customize the summarization prompt
- **Token counters** — live token estimate for your draft, plus a per-conversation counter (with compressed-message count) in the toolbar; estimates are script-aware (CJK text is counted at ~1 token per character) so context trimming works correctly for Japanese, Chinese, and Korean chats
- **Account balance** — OpenRouter users see their remaining credits in Settings → API
- **Model pickers that know your key** — model lists load automatically once a key is entered (OpenRouter, OpenAI, Anthropic, Gemini, Ollama)
- **Swipes** — generate alternative responses and page between them; alternate greetings become swipes on the first message, and older messages with stored swipes stay pageable
- **Message editing** — edit, delete, copy, or regenerate any message; "Save & Regenerate" re-runs the reply after editing your latest message; undo up to 10 steps with Cmd+Z
- **Continue & Impersonate** — extend the last response in place, or let the AI draft *your* next message into the input (Story mode)
- **Branching** — fork any message into a new chat file; the original stays untouched in History
- **Quick model switcher** — click the model chip in the toolbar to search the provider's model list or jump back to a recent model, without a trip to Settings
- **Chat history** — every conversation auto-saves per character; switch, export, or delete past chats from the history picker; import SillyTavern/OpenChat `.jsonl` chats. Deletions go to the OS trash, not straight to oblivion
- **Unified search** — search the current conversation or all chats from one dialog; results jump straight to the matching message
- **Tavern-flavored markdown** — `"dialogue"` (including CJK quoting: `「…」`, `『…』`, `“…”`), `*actions*`, and narrative text each get their own color; headers, bold, blockquotes, lists, tables, strikethrough, and rules are supported, with all input HTML-escaped
- **Links & code** — markdown and bare URLs open safely in your browser (http/https only); fenced code blocks get language-aware syntax highlighting (JS/TS, Python, JSON, Bash, CSS, HTML) and a one-click copy button — still zero dependencies
- **Update notifications** — a daily check against GitHub Releases shows a banner when a new version is out (toggle or run manually in Settings → General; no data about you is sent)

### Characters & World Building
- **TavernCardV2 import/export** — PNG cards with embedded data (`chara` / `ccv3` tEXt chunks) and JSON cards; drag-and-drop files onto the sidebar to import; export as PNG or JSON from the editor, library grid, or sidebar. Unknown card fields (`extensions`, V3 extras) survive the round-trip untouched
- **Full character editor** — description, personality, scenario, first message, alternate greetings, tags; Advanced mode adds system prompt, post-history instructions, example dialogue, a version field, and a full editor for the card's embedded lore book
- **Character books** — embedded lore entries with keyword triggers are honored during prompt building, editable in the character editor, and preserved on save
- **World Lore books** — standalone keyword-triggered lore, assignable globally or per character; entries support secondary keywords (require-both matching) and custom insertion order; SillyTavern world-info JSON imports, and books export back to SillyTavern-compatible JSON
- **Author's Note** — a per-chat style/direction note injected near the end of the prompt at a configurable depth (Story mode, 📝 in the toolbar)
- **Personas** — multiple user identities with avatars and descriptions; per-character persona overrides
- **Pinned characters** — keep favorites at the top of the sidebar (right-click a conversation)

### Prompt Assembly

Prompts are assembled in this order:

```
system prompt → character description/personality/scenario → persona
→ character book entries (constant + keyword-triggered)
→ world info (constant + keyword-triggered) → example dialogue (few-shot)
→ chat history → reminder prompt → post-history instructions
```

`{{char}}` and `{{user}}` template variables are replaced throughout.

## Regular vs. Advanced Mode

Switch in **Settings → General → User Mode**.

| | Regular | Advanced |
|---|---|---|
| Provider, API key, model picker | ✓ | ✓ |
| Temperature, max tokens, streaming toggle | ✓ | ✓ |
| Chat styling, themes, personas, world lore | ✓ | ✓ |
| Full samplers (top-p, top-k, min-p, top-a, typical-p) | | ✓ |
| Repetition control (frequency/presence/repetition penalties) | | ✓ |
| Stop sequences, seed, context size | | ✓ |
| **Generation presets** (save/load, SillyTavern import/export) | | ✓ |
| **System prompt override** and **reminder prompt** | | ✓ |
| Base URL overrides (proxies, OpenAI-compatible endpoints) | | ✓ |
| Character editor extras (system prompt, examples, post-history) | | ✓ |
| Developer mode (live API request/response log) | | ✓ |

Regular mode is the default — everything works out of the box with sensible parameters. Advanced mode is for users who want to tune exactly how the AI responds.

## AI Providers

| Provider | What you need | Notes |
|----------|---------------|-------|
| [OpenRouter](https://openrouter.ai) | API key | **Recommended.** Hundreds of models, live model list, credit balance display, advanced samplers passed through. |
| [OpenAI](https://platform.openai.com) | API key | GPT models via Chat Completions. |
| [Anthropic Claude](https://console.anthropic.com) | API key | Messages API with proper system-prompt and turn-alternation handling. |
| [Google Gemini](https://aistudio.google.com) | API key | Streaming via SSE. |
| [DeepSeek](https://platform.deepseek.com) | API key | DeepSeek V3 (`deepseek-chat`) and R1 (`deepseek-reasoner`). |
| [Kimi](https://platform.moonshot.ai) | API key | Moonshot AI's Kimi K2 family. Defaults to the international endpoint; mainland-China users can point the Advanced base-URL override at `https://api.moonshot.cn/v1`. |
| [Qwen](https://modelstudio.console.alibabacloud.com) | API key | Alibaba Model Studio (DashScope). Defaults to the international endpoint; mainland-China users can override the base URL to `https://dashscope.aliyuncs.com/compatible-mode/v1`. |
| [Ollama](https://ollama.ai) | Local install | No key needed; native Ollama API, so Context Size is passed through as `num_ctx`. |
| Custom (OpenAI-compatible) | A server URL | LM Studio, vLLM, llama.cpp, Groq, Together, DeepSeek, Mistral, xAI, proxies… Point it at the `/v1`-style root; key optional. |

All requests run in the Electron main process (no CORS issues) and stream. Rate limits and server errors retry automatically with backoff; a stalled stream times out after two minutes. OpenAI reasoning models (o-series, GPT-5) get their parameter quirks (`max_completion_tokens`, fixed temperature) handled for you. Use **Settings → API → Test Connection** to verify a key with a tiny request.

## Getting Started

**Download**: grab the latest installer from [Releases](https://github.com/cvl121/openchat/releases) — macOS builds (Apple Silicon & Intel, DMG/zip) are signed and notarized; a Windows 10/11 installer is included (unsigned for now, so SmartScreen may ask you to confirm via "More info → Run anyway"); Linux ships as AppImage and deb.

**Or run from source**:

```bash
cd openchat
npm install
npm start
```

1. **Connect** — the first-run wizard walks you through picking a provider and pasting a key (or pointing at a local Ollama / OpenAI-compatible server), with a built-in connection test. OpenRouter is the recommended starting point.
2. **Chat** — you start in Chat mode: just send a message to the assistant.
3. **Optional: switch to Story mode** — Settings → General → App Mode, then drag a TavernCardV2 PNG/JSON onto the sidebar, use Characters → Import, or create a character from scratch.

### Importing an Existing Data Folder

Settings → Data → **Import Data Folder**: select an existing OpenChat data folder (same layout — `characters/`, `chats/`, `worlds/`, `presets/`, `user/`) and its characters, chats, world books, presets, and personas are copied over.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl + N | New chat |
| Cmd/Ctrl + Shift + N | New character |
| Cmd/Ctrl + F | Search |
| Cmd/Ctrl + Shift + H | Chat history |
| Cmd/Ctrl + R | Regenerate last response |
| Cmd/Ctrl + Z | Undo message edit/delete |
| Cmd/Ctrl + , | Settings |
| Enter / Shift+Enter | Send / newline (configurable) |
| ↑ (in empty input) | Edit your last message |
| Double-click a message | Edit it |
| Escape | Stop generating / close dialog |

## Data Storage

Everything lives in Electron's user-data directory — macOS: `~/Library/Application Support/OpenChat/`, Windows: `%APPDATA%\OpenChat\`, Linux: `~/.config/OpenChat/`:

| Data | Format | Location |
|------|--------|----------|
| Characters | PNG with base64 JSON in a `chara` tEXt chunk | `characters/` |
| Chats | JSONL (line 1 = metadata, then one message per line) | `chats/{CharacterName}/` |
| Settings & API keys | JSON — keys encrypted at rest via the OS credential store (macOS Keychain, Windows DPAPI, Linux Secret Service/keyring) | `user/settings.json` |
| World info | JSON | `worlds/` |
| Personas | JSON + avatar images | `user/personas.json`, `User Avatars/` |
| Presets | JSON | `presets/` |
| Uploads & generated images | Original files | `uploads/` |

## Not (Yet) Implemented

These features were left out for now to keep OpenChat focused on core functionality, speed, and ease of use:

- Group chats (multi-character turn-taking)
- Dedicated image-generation pipelines (DALL-E / Stability / NovelAI) — image responses from image-capable chat models are supported
- Regex find-and-replace scripts
- Message drag-reorder
- NovelAI text provider
- Per-conversation chat style overrides (global styling is supported)

## Contributing & Development

OpenChat is deliberately small: plain JavaScript, no build step, no framework, one dependency (Electron). To hack on it:

```bash
git clone https://github.com/cvl121/openchat && cd openchat
npm install
npm start     # run the app
npm test      # run the unit tests (node --test)
```

Layout: `src/main/` is the Electron main process (LLM providers in `llm.js`, disk layer in `storage.js`, IPC surface in `ipc.js`), `src/renderer/` is the UI (views in `js/views/`, prompt assembly in `js/promptBuilder.js`). Tests live in `tests/` and run on every push and pull request.

Bug reports, feature requests, and PRs are welcome on the [issue tracker](https://github.com/cvl121/openchat/issues). Please keep PRs dependency-free and run `npm test` before submitting.

## License

OpenChat is free software, licensed under the [GNU Affero General Public License v3.0](LICENSE). You may redistribute and/or modify it under the terms of the AGPL; any distributed modified version must also be licensed under the AGPL and make its source available — including when the modified version is offered to users over a network.
