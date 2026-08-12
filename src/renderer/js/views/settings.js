// Settings: API connection, general preferences, chat styling, generation
// parameters, presets, data import/export, and developer tools.
//
// The Regular/Advanced split lives here: Regular mode shows provider, key,
// model, and the three essential generation controls. Advanced mode unlocks
// full sampler customization, presets, prompt overrides, base URLs, and the
// developer log.

import { el, clear, toast, confirmDialog, estimateTokens } from '../util.js';
import {
  state,
  PROVIDERS,
  isAdvanced,
  isChatMode,
  apiConfig,
  scheduleSettingsSave,
  saveSettingsNow,
  devLog,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_COMPRESSION_PROMPT,
  rememberModelContext,
  knownModelContext,
} from '../state.js';
import { sliderRow, checkboxRow, textRow, textareaRow, selectRow } from '../components.js';

let cb = {}; // { applyAppearance, reloadAll, renderSidebar }
let section = 'api';

export function initSettings(callbacks) {
  cb = callbacks;
}

/** Pre-select a section before navigating here (e.g. the chat model chip → 'api'). */
export function showSettingsSection(id) {
  section = id;
}

const SECTIONS = () => [
  ['api', 'API'],
  ['general', 'General'],
  ['chat', 'Chat Style'],
  ['generation', 'Generation'],
  // Prompt overrides target character cards — role play only
  ...(isAdvanced() ? [['presets', 'Presets'], ...(isChatMode() ? [] : [['prompts', 'Prompts']])] : []),
  ['data', 'Data'],
  ...(isAdvanced() && state.settings.developerMode ? [['developer', 'Developer']] : []),
];

export function renderSettings() {
  const main = document.getElementById('main');
  clear(main);

  const nav = el('div', { class: 'settings-nav' });
  const sections = SECTIONS();
  if (!sections.some(([id]) => id === section)) section = 'api';
  for (const [id, label] of sections) {
    nav.append(
      el(
        'button',
        {
          class: `nav-btn${section === id ? ' active' : ''}`,
          onclick: () => {
            section = id;
            renderSettings();
          },
        },
        label
      )
    );
  }

  const content = el('div', { class: 'settings-content' });
  const renderers = {
    api: renderAPI,
    general: renderGeneral,
    chat: renderChatStyle,
    generation: renderGeneration,
    presets: renderPresets,
    prompts: renderPrompts,
    data: renderData,
    developer: renderDeveloper,
  };
  content.append(renderers[section]());

  main.append(el('div', { class: 'settings-layout' }, nav, content));
}

// ---------------------------------------------------------------------------
// API

// Model lists cached per provider+key so the picker fills without a click
const modelCache = new Map();

async function fetchModels(config, { force = false } = {}) {
  const cacheKey = `${config.provider}|${config.apiKey}|${config.baseURL}`;
  if (force) modelCache.delete(cacheKey);
  let models = modelCache.get(cacheKey);
  if (!models) {
    models = await window.tavern.llm.models(config);
    modelCache.set(cacheKey, models);
  }
  return models;
}

function fillModelDatalist(datalist, models) {
  clear(datalist);
  for (const m of models) {
    datalist.append(el('option', { value: m.id }, m.context ? `${m.name} (${m.context.toLocaleString()} ctx)` : m.name));
  }
}

function renderAPI() {
  const s = state.settings;
  const root = el('section', {}, el('h2', {}, 'AI Provider'));

  root.append(
    selectRow('Provider', {
      options: Object.entries(PROVIDERS).map(([id, p]) => [id, p.label]),
      get: () => s.activeAPI,
      set: (v) => {
        s.activeAPI = v;
        scheduleSettingsSave();
        renderSettings();
      },
      hint: 'OpenRouter is recommended: one key, hundreds of models.',
    })
  );

  const provider = PROVIDERS[s.activeAPI];

  // Custom OpenAI-compatible server: the base URL is the whole point, so it
  // lives here (not behind Advanced mode) and the key is optional.
  if (provider.requiresBaseURL) {
    const urlRow = textRow('Server URL', {
      get: () => s.baseURLs?.[s.activeAPI] ?? '',
      set: (v) => {
        s.baseURLs = s.baseURLs ?? {};
        if (v.trim()) s.baseURLs[s.activeAPI] = v.trim();
        else delete s.baseURLs[s.activeAPI];
        scheduleSettingsSave();
      },
      placeholder: 'http://localhost:1234/v1',
      hint: 'Any OpenAI-compatible endpoint: LM Studio, vLLM, llama.cpp, Groq, Together, DeepSeek, Mistral, …',
    });
    // Once the URL is committed, re-render so the model list loads from it
    urlRow.querySelector('input').addEventListener('change', () => renderSettings());
    root.append(urlRow);
  }

  if (provider.requiresKey || provider.requiresBaseURL) {
    const keyInput = el('input', {
      type: 'password',
      value: s.apiKeys[s.activeAPI] ?? '',
      placeholder: provider.requiresKey ? `${provider.label} API key` : 'API key (if your server needs one)',
    });
    keyInput.addEventListener('input', () => {
      s.apiKeys[s.activeAPI] = keyInput.value.trim();
      scheduleSettingsSave();
    });
    // Once the key is entered, re-render so the model list loads with it
    keyInput.addEventListener('change', () => renderSettings());
    const toggle = el('button', { class: 'btn' }, 'Show');
    toggle.addEventListener('click', () => {
      const hidden = keyInput.type === 'password';
      keyInput.type = hidden ? 'text' : 'password';
      toggle.textContent = hidden ? 'Hide' : 'Show';
    });
    root.append(
      el(
        'div',
        { class: 'form-row' },
        el('label', {}, provider.requiresKey ? 'API Key' : 'API Key (optional)'),
        el('div', { class: 'form-inline' }, keyInput, toggle),
        provider.keyURL
          ? el('div', { class: 'hint' },
              'Stored locally, only sent to the provider. Get a key: ',
              el('a', {
                href: '#',
                style: { color: 'var(--accent)' },
                onclick: (e) => {
                  e.preventDefault();
                  window.tavern.misc.openExternal(provider.keyURL);
                },
              }, provider.keyURL)
            )
          : el('div', { class: 'hint' }, 'Stored locally, only sent to your server.')
      )
    );
  } else if (s.activeAPI === 'ollama') {
    root.append(el('p', { class: 'hint', style: { marginBottom: '12px' } }, 'Ollama runs locally — no API key needed. Make sure `ollama serve` is running.'));
  }

  // Model picker — the list loads automatically once a key is present
  const modelInput = el('input', {
    type: 'text',
    value: s.models?.[s.activeAPI] || provider.defaultModel,
    list: 'model-list',
    placeholder: 'Model ID',
  });
  const datalist = el('datalist', { id: 'model-list' });
  let listedModels = []; // last fetched list, to cache the picked model's context
  const rememberPicked = () => {
    const picked = listedModels.find((m) => m.id === (s.models?.[s.activeAPI] ?? '').trim());
    if (picked) rememberModelContext(s.activeAPI, picked.id, picked.context ?? 0);
  };
  modelInput.addEventListener('input', () => {
    s.models = s.models ?? {};
    s.models[s.activeAPI] = modelInput.value.trim();
    scheduleSettingsSave();
    rememberPicked();
  });
  const refreshBtn = el('button', { class: 'btn' }, 'Refresh List');
  const modelHint = el('div', { class: 'hint' }, '');
  const loadMainModels = async (force) => {
    try {
      const models = await fetchModels(apiConfig(), { force });
      listedModels = models;
      fillModelDatalist(datalist, models);
      rememberPicked();
      modelHint.textContent = `${models.length} models available — type to search.`;
      modelHint.style.color = '';
    } catch (err) {
      modelHint.textContent = `Could not load models: ${err.message}`;
      modelHint.style.color = 'var(--danger)';
    }
  };
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Loading…';
    await loadMainModels(true);
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh List';
  });
  const canListModels = provider.requiresBaseURL
    ? !!s.baseURLs?.[s.activeAPI]
    : !provider.requiresKey || s.apiKeys[s.activeAPI];
  if (canListModels) {
    modelHint.textContent = 'Loading model list…';
    loadMainModels(false);
  } else {
    modelHint.textContent = provider.requiresBaseURL
      ? 'Enter your server URL to load the model list.'
      : 'Enter an API key to load the model list.';
  }
  root.append(
    el('div', { class: 'form-row' },
      el('label', {}, 'Model'),
      el('div', { class: 'form-inline' }, modelInput, refreshBtn),
      datalist,
      modelHint
    )
  );

  // Prepaid balance (OpenRouter exposes a credits endpoint)
  if (s.activeAPI === 'openrouter' && s.apiKeys.openrouter) {
    const balance = el('span', { class: 'hint' }, 'Checking balance…');
    window.tavern.llm
      .credits(apiConfig())
      .then((c) => {
        if (!c) return;
        balance.textContent = `$${c.remaining.toFixed(2)} remaining (used $${c.used.toFixed(2)} of $${c.total.toFixed(2)})`;
        if (c.remaining < 1) balance.style.color = 'var(--danger)';
      })
      .catch((err) => {
        balance.textContent = `Could not fetch balance: ${err.message}`;
      });
    root.append(el('div', { class: 'form-row' }, el('label', {}, 'Account Balance'), balance));
  }

  root.append(renderImageGen(s));

  if (isAdvanced() && (s.activeAPI === 'openrouter' || s.activeAPI === 'gemini')) {
    root.append(
      checkboxRow('Chat model may reply with images (advanced)', {
        get: () => !!s.requestImageOutput,
        set: (v) => {
          s.requestImageOutput = v;
          scheduleSettingsSave();
        },
        hint: 'Adds image output modalities to every normal chat request. Most people want the 🎨 button (Image Generation above) instead.',
      })
    );
  }

  if (isAdvanced() && !provider.requiresBaseURL) {
    root.append(
      textRow('Base URL Override', {
        get: () => s.baseURLs?.[s.activeAPI] ?? '',
        set: (v) => {
          s.baseURLs = s.baseURLs ?? {};
          if (v.trim()) s.baseURLs[s.activeAPI] = v.trim();
          else delete s.baseURLs[s.activeAPI];
          scheduleSettingsSave();
        },
        placeholder: 'Leave empty for the provider default',
        hint: 'For proxies or OpenAI-compatible endpoints.',
      })
    );
  }

  // Connection test
  const testBtn = el('button', { class: 'btn btn-primary' }, 'Test Connection');
  const testResult = el('span', { class: 'hint', style: { marginLeft: '10px' } });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testResult.textContent = 'Testing…';
    testResult.style.color = 'var(--text-dim)';
    try {
      await saveSettingsNow();
      const result = await window.tavern.llm.test(apiConfig());
      testResult.textContent = `✓ Connected (${result.latencyMs}ms) — "${result.sample.trim()}"`;
      testResult.style.color = 'var(--ok)';
      devLog('INFO', `Connection test OK in ${result.latencyMs}ms`);
    } catch (err) {
      testResult.textContent = `✗ ${err.message}`;
      testResult.style.color = 'var(--danger)';
      devLog('ERR', `Connection test failed: ${err.message}`);
    }
    testBtn.disabled = false;
  });
  root.append(el('div', { class: 'form-row', style: { marginTop: '18px' } }, testBtn, testResult));

  return root;
}

/** Image Generation group: a dedicated provider/model for the 🎨 button. */
function renderImageGen(s) {
  const group = el('div', {}, el('h3', {}, 'Image Generation'));
  group.append(
    checkboxRow('Enable image generation (adds a 🎨 button to the chat input)', {
      get: () => !!s.imageGen?.enabled,
      set: (v) => {
        s.imageGen = s.imageGen ?? { provider: '', model: '' };
        s.imageGen.enabled = v;
        scheduleSettingsSave();
        renderSettings();
      },
      hint: 'The 🎨 button sends your prompt to the image model below instead of the chat model.',
    })
  );
  if (!s.imageGen?.enabled) return group;

  const imageProvider = s.imageGen.provider || s.activeAPI;
  group.append(
    selectRow('Image Provider', {
      options: [
        ['', `Same as chat (${PROVIDERS[s.activeAPI].label})`],
        ['openrouter', 'OpenRouter'],
        ['gemini', 'Google Gemini'],
      ],
      get: () => s.imageGen.provider ?? '',
      set: (v) => {
        s.imageGen.provider = v;
        scheduleSettingsSave();
        renderSettings();
      },
      hint: PROVIDERS[imageProvider].requiresKey && !s.apiKeys[imageProvider]
        ? `No API key stored for ${PROVIDERS[imageProvider].label} — add one with that provider selected above.`
        : undefined,
    })
  );

  const modelInput = el('input', {
    type: 'text',
    value: s.imageGen.model ?? '',
    list: 'image-model-list',
    placeholder: 'e.g. google/gemini-3.1-flash-image',
  });
  const datalist = el('datalist', { id: 'image-model-list' });
  const hint = el('div', { class: 'hint' }, 'Only models that can output images are listed.');
  // A typo here (e.g. "gemini-3.1-image" instead of "google/gemini-3.1-flash-image")
  // only surfaces as a provider error mid-chat — warn right where it can be fixed.
  let imageModelIds = null; // known image-capable IDs once the provider list loads
  let baseHint = hint.textContent;
  const refreshHint = () => {
    const value = (s.imageGen.model ?? '').trim();
    hint.textContent =
      imageModelIds?.length && value && !imageModelIds.includes(value)
        ? `⚠ “${value}” is not an image-capable ${PROVIDERS[imageProvider].label} model — pick one from the list (e.g. ${imageModelIds[0]}).`
        : baseHint;
  };
  modelInput.addEventListener('input', () => {
    s.imageGen.model = modelInput.value.trim();
    scheduleSettingsSave();
    refreshHint();
  });
  if (!PROVIDERS[imageProvider].requiresKey || s.apiKeys[imageProvider]) {
    fetchModels({
      provider: imageProvider,
      apiKey: s.apiKeys[imageProvider] ?? '',
      baseURL: s.baseURLs?.[imageProvider] ?? '',
    })
      .then((models) => {
        const imageModels = models.filter((m) => m.imageOutput);
        fillModelDatalist(datalist, imageModels.length ? imageModels : models);
        imageModelIds = imageModels.map((m) => m.id);
        baseHint = imageModels.length
          ? `${imageModels.length} image-capable models — type to search.`
          : 'Provider did not flag image-output models; full list shown.';
        refreshHint();
      })
      .catch(() => {});
  }
  group.append(el('div', { class: 'form-row' }, el('label', {}, 'Image Model'), modelInput, datalist, hint));
  return group;
}

// ---------------------------------------------------------------------------
// General

function renderGeneral() {
  const s = state.settings;
  const root = el('section', {}, el('h2', {}, 'General'));

  root.append(
    selectRow('App Mode', {
      options: [
        ['chat', 'Chat — a clean, general-purpose AI assistant'],
        ['roleplay', 'Story — role-play with characters, personas & world lore'],
      ],
      get: () => s.appMode ?? 'chat',
      set: (v) => {
        if (v === (s.appMode ?? 'chat')) return;
        s.appMode = v;
        saveSettingsNow();
        cb.onModeChange?.();
      },
      hint: 'Chat is a straightforward assistant. Story mode unlocks role-playing with character cards, personas, world lore books, and story tools.',
    })
  );

  root.append(
    checkboxRow('Check for updates automatically', {
      get: () => s.updateCheck !== false,
      set: (v) => {
        s.updateCheck = v;
        scheduleSettingsSave();
      },
      hint: 'Checks GitHub Releases once a day for a newer version. Only the version number is fetched — nothing about you or your chats is sent.',
    })
  );
  const updateBtn = el('button', { class: 'btn' }, 'Check Now');
  const updateStatus = el('span', { class: 'hint', style: { marginLeft: '10px' } });
  window.tavern.misc.appVersion().then((v) => {
    updateStatus.textContent = `Current version: ${v}`;
  });
  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    updateStatus.textContent = 'Checking…';
    try {
      const update = await window.tavern.updates.check();
      if (update) {
        updateStatus.textContent = `Version ${update.version} is available.`;
        cb.showUpdateBanner?.(update);
      } else {
        updateStatus.textContent = 'You are on the latest version.';
      }
    } catch (err) {
      updateStatus.textContent = `Check failed: ${err.message}`;
    }
    updateBtn.disabled = false;
  });
  root.append(
    el('div', { class: 'form-row' },
      el('label', {}, 'Updates'),
      el('div', { class: 'form-inline' }, updateBtn, updateStatus)
    )
  );

  if (isChatMode()) {
    root.append(
      textareaRow('Assistant System Prompt', {
        get: () => s.chatSystemPrompt,
        set: (v) => {
          s.chatSystemPrompt = v;
          scheduleSettingsSave();
        },
        rows: 3,
        placeholder: DEFAULT_CHAT_SYSTEM_PROMPT,
        hint: 'How the assistant should behave. Leave empty for the default.',
      })
    );
  }

  root.append(
    selectRow('User Mode', {
      options: [
        ['regular', 'Regular — clean and simple'],
        ['advanced', 'Advanced — full control over AI responses'],
      ],
      get: () => s.uiMode,
      set: (v) => {
        s.uiMode = v;
        scheduleSettingsSave();
        renderSettings();
        toast(v === 'advanced' ? 'Advanced mode: extra settings unlocked' : 'Regular mode', 'ok');
      },
      hint: 'Advanced mode unlocks sampler parameters, presets, prompt overrides, base URLs, and developer tools.',
    }),
    selectRow('Theme', {
      options: [
        ['system', 'Match system'],
        ['dark', 'Dark'],
        ['light', 'Light'],
      ],
      get: () => s.theme,
      set: (v) => {
        s.theme = v;
        scheduleSettingsSave();
        cb.applyAppearance?.();
      },
    }),
    sliderRow('UI Scale', {
      min: 0.8,
      max: 1.4,
      step: 0.05,
      get: () => s.uiScale ?? 1.0,
      set: (v) => {
        s.uiScale = v;
        scheduleSettingsSave();
        cb.applyAppearance?.();
      },
    }),
    sliderRow('App Font Size', {
      min: 11,
      max: 17,
      step: 1,
      get: () => s.appFontSize ?? 13,
      set: (v) => {
        s.appFontSize = v;
        scheduleSettingsSave();
        cb.applyAppearance?.();
      },
      hint: 'Base text size for the whole app. Chat text has its own size in Chat Style.',
    }),
    selectRow('App Font', {
      options: [
        ['system', 'System (default)'],
        ['serif', 'Serif'],
        ['rounded', 'Rounded'],
        ['mono', 'Monospace'],
      ],
      get: () => s.appFontFamily ?? 'system',
      set: (v) => {
        s.appFontFamily = v;
        scheduleSettingsSave();
        cb.applyAppearance?.();
      },
    }),
    checkboxRow('Send message on Enter (Shift+Enter for newline)', {
      get: () => s.sendOnEnter,
      set: (v) => {
        s.sendOnEnter = v;
        scheduleSettingsSave();
      },
    })
  );

  if (isAdvanced()) {
    root.append(
      checkboxRow('Developer mode (log API requests/responses)', {
        get: () => s.developerMode,
        set: (v) => {
          s.developerMode = v;
          scheduleSettingsSave();
          renderSettings();
        },
      })
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// Chat style

function renderChatStyle() {
  const s = state.settings;
  const style = s.chatStyle;
  const root = el('section', {}, el('h2', {}, 'Chat Text Styling'));

  const preview = el('div', {
    class: 'card msg-content',
    style: { fontSize: 'var(--chat-font-size)', lineHeight: 1.55 },
  });
  const updatePreview = () => {
    preview.innerHTML =
      `<span class='md-quote'>"Dialogue text looks like this,"</span> she said. ` +
      `<em class='md-action'>She gestured toward the window.</em> The narrative text fills in everything else.`;
  };
  updatePreview();

  const colorRow = (label, key) => {
    const input = el('input', { type: 'color', value: style[key] });
    input.addEventListener('input', () => {
      style[key] = input.value;
      scheduleSettingsSave();
      cb.applyAppearance?.();
      updatePreview();
    });
    return el('div', { class: 'form-inline', style: { marginBottom: '10px', justifyContent: 'space-between', maxWidth: '320px' } },
      el('label', { style: { margin: 0 } }, label), input);
  };

  root.append(
    el('p', { class: 'hint', style: { marginBottom: '14px' } }, 'Colors for the three kinds of chat text, matching SillyTavern conventions.'),
    colorRow('Dialogue (quoted text)', 'quoteColor'),
    colorRow('Actions (*italic text*)', 'actionColor'),
    colorRow('Narrative (everything else)', 'narrativeColor'),
    sliderRow('Chat Font Size', {
      min: 11,
      max: 20,
      step: 1,
      get: () => style.fontSize,
      set: (v) => {
        style.fontSize = v;
        scheduleSettingsSave();
        cb.applyAppearance?.();
      },
    }),
    el('h3', {}, 'Preview'),
    preview,
    el('button', {
      class: 'btn',
      onclick: () => {
        Object.assign(style, { quoteColor: '#e8b75f', actionColor: '#a89bd4', narrativeColor: '#d8d8e0', fontSize: 14 });
        scheduleSettingsSave();
        cb.applyAppearance?.();
        renderSettings();
      },
    }, 'Reset to Defaults')
  );
  return root;
}

// ---------------------------------------------------------------------------
// Generation parameters

function renderGeneration() {
  const s = state.settings;
  const p = s.generationParams;
  const set = (key) => (v) => {
    p[key] = v;
    scheduleSettingsSave();
  };
  const root = el('section', {}, el('h2', {}, 'Generation'));

  if (isAdvanced() && state.presets.length) {
    root.append(
      selectRow('Active Preset', {
        options: state.presets.map((preset) => [preset.name, preset.name]),
        get: () => s.activePresetName ?? 'Default',
        set: (v) => {
          const preset = state.presets.find((x) => x.name === v);
          if (preset) {
            s.activePresetName = v;
            s.generationParams = { ...preset.generationParams };
            scheduleSettingsSave();
            renderSettings();
          }
        },
        hint: 'Loading a preset replaces the parameters below. Manage presets in the Presets section.',
      })
    );
  }

  root.append(
    sliderRow('Temperature', { min: 0, max: 2, step: 0.05, get: () => p.temperature, set: set('temperature'),
      hint: 'Higher = more creative, lower = more focused.' }),
    sliderRow('Max Response Tokens', { min: 64, max: 32768, step: 64, get: () => p.max_tokens, set: set('max_tokens'),
      hint: 'Upper bound on response length. Modern Claude/GPT models accept 32k+; older or smaller models may reject values above their own limit.' }),
    checkboxRow('Stream responses (show text as it generates)', { get: () => p.stream_response, set: set('stream_response') })
  );

  // Chat compression — keeps long conversations from resending everything
  const comp = s.chatCompression;
  root.append(
    el('h3', {}, 'Chat Compression'),
    checkboxRow('Compress long chats (summarize older messages to cut cost)', {
      get: () => !!comp.enabled,
      set: (v) => {
        comp.enabled = v;
        scheduleSettingsSave();
        renderSettings();
      },
      hint: 'Older messages are folded into a running summary so each new reply stops resending the whole history to the API.',
    })
  );
  if (comp.enabled) {
    root.append(
      sliderRow('Compress after (messages)', {
        min: 20, max: 200, step: 10,
        get: () => comp.afterMessages ?? 60,
        set: (v) => {
          comp.afterMessages = v;
          scheduleSettingsSave();
        },
        hint: 'When a chat grows past this, older messages are summarized in the background with your current model. The newest 16 messages are always sent in full.',
      })
    );
    if (isAdvanced()) {
      root.append(
        textareaRow('Compression Prompt Override', {
          get: () => comp.prompt ?? '',
          set: (v) => {
            comp.prompt = v;
            scheduleSettingsSave();
          },
          rows: 3,
          placeholder: DEFAULT_COMPRESSION_PROMPT,
          hint: 'Instructions given to the model when summarizing. Leave empty for the default.',
        })
      );
    }
  }

  if (!isAdvanced()) {
    root.append(el('p', { class: 'hint' }, 'Switch to Advanced mode in General settings for full sampler control (top-p, top-k, penalties, min-p, seeds, stop sequences, and more).'));
    return root;
  }

  root.append(
    el('h3', {}, 'Sampling'),
    sliderRow('Top P (nucleus sampling)', { min: 0, max: 1, step: 0.01, get: () => p.top_p, set: set('top_p') }),
    sliderRow('Top K (0 = disabled)', { min: 0, max: 200, step: 1, get: () => p.top_k, set: set('top_k') }),
    sliderRow('Min P (0 = disabled)', { min: 0, max: 1, step: 0.01, get: () => p.min_p, set: set('min_p') }),
    sliderRow('Top A (0 = disabled)', { min: 0, max: 1, step: 0.01, get: () => p.top_a, set: set('top_a') }),
    sliderRow('Typical P (1 = disabled)', { min: 0, max: 1, step: 0.01, get: () => p.typical_p, set: set('typical_p') }),
    el('h3', {}, 'Repetition Control'),
    sliderRow('Frequency Penalty', { min: -2, max: 2, step: 0.05, get: () => p.frequency_penalty, set: set('frequency_penalty') }),
    sliderRow('Presence Penalty', { min: -2, max: 2, step: 0.05, get: () => p.presence_penalty, set: set('presence_penalty') }),
    sliderRow('Repetition Penalty (1 = disabled)', { min: 0.5, max: 2, step: 0.01, get: () => p.repetition_penalty, set: set('repetition_penalty'),
      hint: 'Passed through to OpenRouter/Ollama models that support it.' }),
    el('h3', {}, 'Context'),
    checkboxRow('Auto context size — match the selected model', {
      get: () => p.context_size_auto ?? true,
      set: (v) => {
        p.context_size_auto = v;
        scheduleSettingsSave();
        renderSettings();
      },
      hint: contextAutoHint(),
    }),
    sliderRow('Context Size (tokens of history to keep)', {
      min: 0, max: 1048576, step: 1024, softMax: true,
      get: () => p.context_size, set: set('context_size'),
      hint: (p.context_size_auto ?? true)
        ? 'Fallback when the provider doesn\'t report the model\'s context window. 0 = unlimited. Type any value — the box accepts more than the slider.'
        : '0 = unlimited (send the full history). Type any value — the box accepts more than the slider.',
    }),
    textRow('Stop Sequences (comma-separated)', {
      get: () => (p.stop_sequences ?? []).join(', '),
      set: (v) => {
        p.stop_sequences = v.split(',').map((x) => x.trim()).filter(Boolean);
        scheduleSettingsSave();
      },
    }),
    textRow('Seed (-1 = random)', {
      get: () => String(p.seed ?? -1),
      set: (v) => {
        const n = parseInt(v, 10);
        p.seed = Number.isFinite(n) ? n : -1;
        scheduleSettingsSave();
      },
    })
  );
  return root;
}

/** Live hint for the auto-context toggle: what auto resolves to right now. */
function contextAutoHint() {
  const base = 'Uses the model\'s advertised max context when the provider reports one.';
  const config = apiConfig();
  const known = knownModelContext(config.provider, config.model);
  if (known > 0) return `${base} ${config.model}: ${known.toLocaleString()} tokens.`;
  if (known === 0) return `${base} ${config.model} doesn't report one — the manual value below applies.`;
  return `${base} Resolved on first use of the model.`;
}

// ---------------------------------------------------------------------------
// Presets (advanced)

function renderPresets() {
  const s = state.settings;
  const root = el('section', {}, el('h2', {}, 'Generation Presets'));
  root.append(el('p', { class: 'hint', style: { marginBottom: '14px' } },
    'Save the current generation parameters under a name, or import SillyTavern preset files.'));

  const nameInput = el('input', { type: 'text', placeholder: 'Preset name', style: { maxWidth: '240px' } });
  root.append(
    el('div', { class: 'form-inline', style: { marginBottom: '16px' } },
      nameInput,
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) return toast('Enter a preset name', 'error');
          try {
            await window.tavern.presets.save({ name, generationParams: { ...s.generationParams } });
            s.activePresetName = name;
            scheduleSettingsSave();
            await cb.reloadPresets?.();
            renderSettings();
            toast(`Preset "${name}" saved`, 'ok');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Save Current as Preset'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          const files = await window.tavern.dialog.openFile({ filters: [{ name: 'Preset JSON', extensions: ['json'] }] });
          if (!files[0]) return;
          try {
            const preset = await window.tavern.presets.import(files[0]);
            await cb.reloadPresets?.();
            renderSettings();
            toast(`Imported "${preset.name}"`, 'ok');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Import…')
    )
  );

  for (const preset of state.presets) {
    const isActive = s.activePresetName === preset.name;
    root.append(
      el('div', { class: 'list-row' },
        el('div', { class: 'list-main' },
          el('div', { class: 'list-title' }, preset.name, isActive ? el('span', { class: 'mode-badge', style: { marginLeft: '8px' } }, 'Active') : null),
          el('div', { class: 'list-sub' },
            `temp ${preset.generationParams.temperature} · top_p ${preset.generationParams.top_p} · ${preset.generationParams.max_tokens} tokens`)
        ),
        el('button', {
          class: 'btn btn-small',
          onclick: () => {
            s.activePresetName = preset.name;
            s.generationParams = { ...preset.generationParams };
            scheduleSettingsSave();
            renderSettings();
            toast(`Loaded "${preset.name}"`, 'ok');
          },
        }, 'Load'),
        el('button', {
          class: 'btn-icon',
          title: 'Export',
          onclick: async () => {
            try {
              const saved = await window.tavern.presets.export(preset.name);
              if (saved) toast('Preset exported', 'ok');
            } catch (err) {
              toast(`Export failed: ${err.message}`, 'error');
            }
          },
        }, '⬆'),
        preset.name !== 'Default'
          ? el('button', {
              class: 'btn-icon',
              title: 'Delete',
              onclick: async () => {
                const ok = await confirmDialog(`Delete preset "${preset.name}"?`);
                if (!ok) return;
                await window.tavern.presets.delete(preset.name);
                await cb.reloadPresets?.();
                renderSettings();
              },
            }, '🗑')
          : null
      )
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// Prompt overrides (advanced)

function renderPrompts() {
  const s = state.settings;
  const root = el('section', {}, el('h2', {}, 'Prompt Customization'));
  root.append(
    textareaRow('System Prompt Override', {
      get: () => s.systemPromptOverride,
      set: (v) => {
        s.systemPromptOverride = v;
        scheduleSettingsSave();
      },
      rows: 4,
      placeholder: 'Overrides every character\'s system prompt. Supports {{char}} and {{user}}.',
      hint: `Leave empty to use each character's own system prompt. ~${estimateTokens(s.systemPromptOverride)} tokens.`,
    }),
    textareaRow('Reminder Prompt', {
      get: () => s.reminderPrompt,
      set: (v) => {
        s.reminderPrompt = v;
        scheduleSettingsSave();
      },
      rows: 3,
      placeholder: 'e.g. "Stay in character. Write in present tense. Keep responses under 3 paragraphs."',
      hint: 'Injected near the end of the conversation to reinforce style and formatting that models forget in long chats.',
    })
  );
  return root;
}

// ---------------------------------------------------------------------------
// Data

function renderData() {
  const root = el('section', {}, el('h2', {}, 'Data'));
  const dirHint = el('p', { class: 'hint', style: { marginBottom: '16px' } }, 'Loading data location…');
  window.tavern.misc.dataDir().then((dir) => {
    dirHint.textContent = `All data is stored locally in ${dir} — nothing is sent anywhere except your chosen AI provider (plus an optional daily version check against GitHub Releases).`;
  });

  root.append(
    dirHint,
    el('h3', {}, 'Import Data Folder'),
    el('p', { class: 'hint', style: { marginBottom: '10px' } },
      'Select an existing OpenChat data folder to copy its characters, chats, world books, presets, and personas. The folder must use the same layout (characters/, chats/, worlds/, presets/, user/).'),
    el('button', {
      class: 'btn',
      onclick: async () => {
        const dir = await window.tavern.dialog.openDirectory();
        if (!dir) return;
        try {
          const copied = await window.tavern.misc.importDataFolder(dir);
          toast(`Imported ${copied.characters} characters, ${copied.chats} chats, ${copied.worlds} world books, ${copied.presets} presets`, 'ok');
          await cb.reloadAll?.();
          renderSettings();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, 'Choose Folder…')
  );

  const stPreview = el('div');
  root.append(
    el('h3', { style: { marginTop: '22px' } }, 'Import from SillyTavern'),
    el('p', { class: 'hint', style: { marginBottom: '10px' } },
      'Select your SillyTavern folder (the install folder, its data folder, or a user folder inside data) to bring over characters, chats, lorebooks, personas, and generation presets. Groups, themes, and quick replies are not supported. Nothing is overwritten — imported duplicates are renamed.'),
    el('button', {
      class: 'btn',
      onclick: async () => {
        const dir = await window.tavern.dialog.openDirectory();
        if (!dir) return;
        try {
          const scan = await window.tavern.sillytavern.scan(dir);
          const total = Object.values(scan.counts).reduce((a, b) => a + b, 0);
          if (!total) return toast('Found a SillyTavern layout but nothing to import.', 'error');
          renderSTPreview(stPreview, scan);
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, 'Choose SillyTavern Folder…'),
    stPreview
  );
  return root;
}

const ST_CATEGORIES = [
  ['characters', 'Characters'],
  ['chats', 'Chats'],
  ['lorebooks', 'Lorebooks (world info)'],
  ['personas', 'Personas'],
  ['presets', 'Generation presets'],
];

/** Two-phase SillyTavern import: scan result → category checkboxes → import. */
function renderSTPreview(host, scan) {
  clear(host);
  const selected = {};
  const rows = [];
  for (const [key, label] of ST_CATEGORIES) {
    if (!scan.counts[key]) continue; // omit empty categories
    selected[key] = true;
    rows.push(checkboxRow(`${label} (${scan.counts[key]})`, {
      get: () => selected[key],
      set: (v) => (selected[key] = v),
    }));
  }
  const importBtn = el('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      if (!Object.values(selected).some(Boolean)) return toast('Nothing selected', 'error');
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        // Fast local file copying — a button state is proportionate progress UI
        const res = await window.tavern.sillytavern.import(scan.dir, selected);
        const parts = ST_CATEGORIES
          .filter(([key]) => selected[key])
          .map(([key, label]) => {
            const n = res.imported[key];
            const word = label.toLowerCase().replace(/ \(.*/, '');
            return `${n} ${n === 1 ? word.replace(/s$/, '') : word}`;
          });
        const failures = res.errors.length ? ` — ${res.errors.length} items failed` : '';
        clear(host);
        toast(`Imported ${parts.join(', ')}${failures}`, res.errors.length ? 'error' : 'ok');
        await cb.reloadAll?.();
        renderSettings();
      } catch (err) {
        toast(err.message, 'error');
        importBtn.disabled = false;
        importBtn.textContent = 'Import Selected';
      }
    },
  }, 'Import Selected');
  host.append(
    el('div', { style: { margin: '12px 0 0', padding: '12px', border: '1px solid var(--border)', borderRadius: '8px', maxWidth: '420px' } },
      ...rows,
      el('div', { class: 'form-inline', style: { marginTop: '10px' } },
        importBtn,
        el('button', { class: 'btn', onclick: () => clear(host) }, 'Cancel')
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Developer (advanced + developerMode)

let devlogCleanup = null;

function renderDeveloper() {
  const root = el('section', {}, el('h2', {}, 'Developer Log'));
  const log = el('div', { class: 'devlog' });
  const renderLog = () => {
    clear(log);
    if (!state.devLog.length) log.append(el('div', { class: 'log-INFO' }, 'No entries yet. API requests will appear here.'));
    for (const entry of state.devLog.slice(-200)) {
      log.append(el('div', { class: `log-${entry.type}` }, `[${entry.time.slice(11, 19)}] ${entry.type} ${entry.message}`));
    }
    log.scrollTop = log.scrollHeight;
  };
  renderLog();
  devlogCleanup?.();
  document.addEventListener('devlog-updated', renderLog);
  devlogCleanup = () => document.removeEventListener('devlog-updated', renderLog);
  root.append(
    log,
    el('div', { style: { marginTop: '10px' } },
      el('button', {
        class: 'btn btn-small',
        onclick: () => {
          state.devLog = [];
          renderLog();
        },
      }, 'Clear Log')
    )
  );
  return root;
}
