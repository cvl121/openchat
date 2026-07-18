# OpenChat

**OpenChat** — a fast, local-first, open-source desktop AI chat app with two personalities: a clean general-purpose assistant chat, and a full story/role-play environment inspired by [SillyTavern](https://github.com/SillyTavern/SillyTavern).

OpenChat is built for instant startup, no server, no browser tabs, all data on your machine — in a cross-platform codebase with zero build step and a single dependency (Electron itself).

## Highlights

- **Two app modes** — **Chat** (the default) is a straightforward AI assistant with conversation history, file uploads, and image responses. **Story** unlocks role-playing with character cards, personas, world lore, swipes, and story tools. Switch anytime in Settings → General.
- **Bring your own key — or none** — designed primarily around **OpenRouter** (one key, hundreds of models, live searchable model list), with OpenAI, Anthropic Claude, Google Gemini, and local **Ollama** (no key, runs on your machine) also supported.
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
- **Streaming responses** rendered live as tokens arrive, with a Stop button / Escape key
- **File uploads** — attach images and text files via the 📎 button, paste, or drag-and-drop; images go to multimodal models as image parts, text files are inlined into the prompt
- **Image generation** — enable in Settings → API to get a 🎨 button that sends your prompt to a dedicated image provider/model (separate from your chat model); generated images render in the chat and can be saved to Downloads or any folder. Asking the chat model for an image in a plain message also works: if the chat model can't produce one, the request is automatically re-routed to your image model
- **Chat compression** — long chats are summarized in the background (threshold configurable) so each new reply stops resending the full history; Advanced mode can customize the summarization prompt
- **Token counters** — live token estimate for your draft, plus a per-conversation counter (with compressed-message count) in the toolbar; estimates are script-aware (CJK text is counted at ~1 token per character) so context trimming works correctly for Japanese, Chinese, and Korean chats
- **Account balance** — OpenRouter users see their remaining credits in Settings → API
- **Model pickers that know your key** — model lists load automatically once a key is entered (OpenRouter, OpenAI, Anthropic, Gemini, Ollama)
- **Swipes** — generate alternative responses and page between them; alternate greetings become swipes on the first message
- **Message editing** — edit, delete, copy, or regenerate any message; undo up to 10 steps with Cmd+Z
- **Chat history** — every conversation auto-saves per character; switch, export, or delete past chats from the history picker
- **Unified search** — search the current conversation or all chats from one dialog; results jump straight to the matching message
- **Tavern-flavored markdown** — `"dialogue"` (including CJK quoting: `「…」`, `『…』`, `“…”`), `*actions*`, and narrative text each get their own color; headers, bold, code blocks, blockquotes, lists, and rules are supported, with all input HTML-escaped
- **Update notifications** — a daily check against GitHub Releases shows a banner when a new version is out (toggle or run manually in Settings → General; no data about you is sent)

### Characters & World Building
- **TavernCardV2 import/export** — PNG cards with embedded data (`chara` / `ccv3` tEXt chunks) and JSON cards; drag-and-drop files onto the sidebar to import
- **Full character editor** — description, personality, scenario, first message, alternate greetings, tags; Advanced mode adds system prompt, post-history instructions, and example dialogue
- **Character books** — embedded lore entries with keyword triggers are honored during prompt building and preserved on save
- **World Lore books** — standalone keyword-triggered lore, assignable globally or per character, with SillyTavern world-info JSON import
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
| [Ollama](https://ollama.ai) | Local install | No key needed; reads your local model list. |

All requests run in the Electron main process (no CORS issues) and stream over SSE. Use **Settings → API → Test Connection** to verify a key with a tiny request.

## Getting Started

**Download**: grab the latest installer from [Releases](https://github.com/cvl121/openchat/releases) — macOS builds (Apple Silicon & Intel, DMG/zip) are signed and notarized; a Windows 10/11 installer is included (unsigned for now, so SmartScreen may ask you to confirm via "More info → Run anyway").

**Or run from source**:

```bash
cd openchat
npm install
npm start
```

1. **Add an API key** — Settings → API. OpenRouter is the recommended starting point (or pick Ollama to run a local model with no key).
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
- Chat branching and message drag-reorder
- NovelAI text provider
- Per-conversation chat style overrides (global styling is supported)

## License

OpenChat is free software, licensed under the [GNU General Public License v3.0](LICENSE). You may redistribute and/or modify it under the terms of the GPL; any distributed modified version must also be licensed under the GPL and make its source available.
