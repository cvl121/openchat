// Settings: API connection, general preferences, chat styling, generation
// parameters, presets, data import/export, and developer tools.
//
// The Regular/Advanced split lives here: Regular mode shows provider, key,
// model, and the three essential generation controls. Advanced mode unlocks
// full sampler customization, presets, prompt overrides, base URLs, and the
// developer log.

import { el, clear, toast, confirmDialog, modal, estimateTokens, formatModelPricing } from '../util.js';
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
  rememberModelPricing,
} from '../state.js';
import { sliderRow, checkboxRow, textRow, textareaRow, selectRow, combobox } from '../components.js';
import { t, LOCALES, LOCALE_LABELS } from '../../../shared/i18n.js';

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
  ['api', t('settings.sectionAPI')],
  ['general', t('settings.sectionGeneral')],
  ['chat', t('settings.sectionChatStyle')],
  ['generation', t('settings.sectionGeneration')],
  // Prompt overrides target character cards — role play only
  ...(isAdvanced()
    ? [['presets', t('settings.sectionPresets')], ...(isChatMode() ? [] : [['prompts', t('settings.sectionPrompts')]])]
    : []),
  ['data', t('settings.sectionData')],
  ...(isAdvanced() && state.settings.developerMode ? [['developer', t('settings.sectionDeveloper')]] : []),
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

/** Model list → combobox items, matching the chat model switcher's rows. */
function comboItems(models) {
  return models.map((m) => {
    const parts = [];
    if (m.name && m.name !== m.id) parts.push(m.name);
    if (m.context) parts.push(`${m.context.toLocaleString()} ctx`);
    const price = formatModelPricing(m.pricing);
    if (price) parts.push(price);
    return { value: m.id, sub: parts.join(' · ') };
  });
}

function renderAPI() {
  const s = state.settings;
  const root = el('section', {}, el('h2', {}, t('settings.aiProvider')));

  root.append(
    selectRow(t('settings.provider'), {
      options: Object.entries(PROVIDERS).map(([id, p]) => [id, p.label]),
      get: () => s.activeAPI,
      set: (v) => {
        s.activeAPI = v;
        scheduleSettingsSave();
        renderSettings();
      },
      hint: t('settings.providerHint'),
    })
  );

  const provider = PROVIDERS[s.activeAPI];

  {
    const keyInput = el('input', {
      type: 'password',
      value: s.apiKeys[s.activeAPI] ?? '',
      placeholder: t('settings.keyPlaceholder', { label: provider.label }),
    });
    keyInput.addEventListener('input', () => {
      s.apiKeys[s.activeAPI] = keyInput.value.trim();
      scheduleSettingsSave();
    });
    // Once the key is entered, re-render so the model list loads with it
    keyInput.addEventListener('change', () => renderSettings());
    const toggle = el('button', { class: 'btn' }, t('common.show'));
    toggle.addEventListener('click', () => {
      const hidden = keyInput.type === 'password';
      keyInput.type = hidden ? 'text' : 'password';
      toggle.textContent = hidden ? t('common.hide') : t('common.show');
    });
    root.append(
      el(
        'div',
        { class: 'form-row' },
        el('label', {}, t('settings.apiKey')),
        el('div', { class: 'form-inline' }, keyInput, toggle),
        el('div', { class: 'hint' },
          t('settings.keyStoredProvider'),
          el('a', {
            href: '#',
            style: { color: 'var(--accent)' },
            onclick: (e) => {
              e.preventDefault();
              window.tavern.misc.openExternal(provider.keyURL);
            },
          }, provider.keyURL)
        )
      )
    );
  }

  // Model picker — the list loads automatically once a key is present
  let listedModels = []; // last fetched list, to cache the picked model's context
  const rememberPicked = () => {
    const picked = listedModels.find((m) => m.id === (s.models?.[s.activeAPI] ?? '').trim());
    if (picked) {
      rememberModelContext(s.activeAPI, picked.id, picked.context ?? 0);
      if (picked.pricing) rememberModelPricing(s.activeAPI, picked.id, picked.pricing);
    }
  };
  const modelCombo = combobox({
    value: s.models?.[s.activeAPI] || provider.defaultModel,
    placeholder: t('settings.modelID'),
    emptyText: t('chat.noMatchingModels'),
    onChange: (v) => {
      s.models = s.models ?? {};
      s.models[s.activeAPI] = v.trim();
      scheduleSettingsSave();
      rememberPicked();
    },
  });
  const refreshBtn = el('button', { class: 'btn' }, t('settings.refreshList'));
  const modelHint = el('div', { class: 'hint' }, '');
  const loadMainModels = async (force) => {
    try {
      const models = await fetchModels(apiConfig(), { force });
      listedModels = models;
      modelCombo.setItems(comboItems(models));
      rememberPicked();
      modelHint.textContent = t('settings.modelsAvailable', { count: models.length });
      modelHint.style.color = '';
    } catch (err) {
      modelHint.textContent = t('chat.couldNotLoadModels', { msg: err.message });
      modelHint.style.color = 'var(--danger)';
    }
  };
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = t('settings.loading');
    await loadMainModels(true);
    refreshBtn.disabled = false;
    refreshBtn.textContent = t('settings.refreshList');
  });
  if (s.apiKeys[s.activeAPI]) {
    modelHint.textContent = t('settings.loadingModels');
    loadMainModels(false);
  } else {
    modelHint.textContent = t('settings.enterKeyForModels');
  }
  root.append(
    el('div', { class: 'form-row' },
      el('label', {}, t('settings.model')),
      el('div', { class: 'form-inline' }, modelCombo.root, refreshBtn),
      modelHint
    )
  );

  // Prepaid balance (OpenRouter exposes a credits endpoint)
  if (s.activeAPI === 'openrouter' && s.apiKeys.openrouter) {
    const balance = el('span', { class: 'hint' }, t('settings.checkingBalance'));
    window.tavern.llm
      .credits(apiConfig())
      .then((c) => {
        if (!c) return;
        balance.textContent = t('settings.balance', {
          remaining: c.remaining.toFixed(2),
          used: c.used.toFixed(2),
          total: c.total.toFixed(2),
        });
        if (c.remaining < 1) balance.style.color = 'var(--danger)';
      })
      .catch((err) => {
        balance.textContent = t('settings.balanceFailed', { msg: err.message });
      });
    root.append(el('div', { class: 'form-row' }, el('label', {}, t('settings.accountBalance')), balance));
  }

  root.append(renderImageGen(s));

  if (isAdvanced() && (s.activeAPI === 'openrouter' || s.activeAPI === 'gemini')) {
    root.append(
      checkboxRow(t('settings.chatModelImages'), {
        get: () => !!s.requestImageOutput,
        set: (v) => {
          s.requestImageOutput = v;
          scheduleSettingsSave();
        },
        hint: t('settings.chatModelImagesHint'),
      })
    );
  }

  if (isAdvanced()) {
    root.append(
      textRow(t('settings.baseURLOverride'), {
        get: () => s.baseURLs?.[s.activeAPI] ?? '',
        set: (v) => {
          s.baseURLs = s.baseURLs ?? {};
          if (v.trim()) s.baseURLs[s.activeAPI] = v.trim();
          else delete s.baseURLs[s.activeAPI];
          scheduleSettingsSave();
        },
        placeholder: t('settings.baseURLPlaceholder'),
        hint: t('settings.baseURLHint'),
      })
    );
  }

  // Connection test
  const testBtn = el('button', { class: 'btn btn-primary' }, t('settings.testConnection'));
  const testResult = el('span', { class: 'hint', style: { marginLeft: '10px' } });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testResult.textContent = t('settings.testing');
    testResult.style.color = 'var(--text-dim)';
    try {
      await saveSettingsNow();
      const result = await window.tavern.llm.test(apiConfig());
      testResult.textContent = t('settings.connected', { ms: result.latencyMs, sample: result.sample.trim() });
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
  const group = el('div', {}, el('h3', {}, t('settings.imageGeneration')));
  group.append(
    checkboxRow(t('settings.enableImageGen'), {
      get: () => !!s.imageGen?.enabled,
      set: (v) => {
        s.imageGen = s.imageGen ?? { provider: '', model: '' };
        s.imageGen.enabled = v;
        scheduleSettingsSave();
        renderSettings();
      },
      hint: t('settings.enableImageGenHint'),
    })
  );
  if (!s.imageGen?.enabled) return group;

  const imageProvider = s.imageGen.provider || s.activeAPI;
  group.append(
    selectRow(t('settings.imageProvider'), {
      options: [
        ['', t('settings.sameAsChat', { label: PROVIDERS[s.activeAPI].label })],
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
        ? t('settings.noKeyForProvider', { label: PROVIDERS[imageProvider].label })
        : undefined,
    })
  );

  const hint = el('div', { class: 'hint' }, t('settings.imageModelHint'));
  // A typo here (e.g. "gemini-3.1-image" instead of "google/gemini-3.1-flash-image")
  // only surfaces as a provider error mid-chat — warn right where it can be fixed.
  let imageModelIds = null; // known image-capable IDs once the provider list loads
  let baseHint = hint.textContent;
  const refreshHint = () => {
    const value = (s.imageGen.model ?? '').trim();
    hint.textContent =
      imageModelIds?.length && value && !imageModelIds.includes(value)
        ? t('settings.imageModelWarn', { value, label: PROVIDERS[imageProvider].label, example: imageModelIds[0] })
        : baseHint;
  };
  const modelCombo = combobox({
    value: s.imageGen.model ?? '',
    placeholder: 'e.g. google/gemini-3.1-flash-image',
    emptyText: t('chat.noMatchingModels'),
    onChange: (v) => {
      s.imageGen.model = v.trim();
      scheduleSettingsSave();
      refreshHint();
    },
  });
  if (!PROVIDERS[imageProvider].requiresKey || s.apiKeys[imageProvider]) {
    fetchModels({
      provider: imageProvider,
      apiKey: s.apiKeys[imageProvider] ?? '',
      baseURL: s.baseURLs?.[imageProvider] ?? '',
    })
      .then((models) => {
        const imageModels = models.filter((m) => m.imageOutput);
        modelCombo.setItems(comboItems(imageModels.length ? imageModels : models));
        imageModelIds = imageModels.map((m) => m.id);
        baseHint = imageModels.length
          ? t('settings.imageModelsAvailable', { count: imageModels.length })
          : t('settings.imageModelsUnflagged');
        refreshHint();
      })
      .catch(() => {});
  }
  group.append(el('div', { class: 'form-row' }, el('label', {}, t('settings.imageModel')), modelCombo.root, hint));
  return group;
}

// ---------------------------------------------------------------------------
// General

function renderGeneral() {
  const s = state.settings;
  const root = el('section', {}, el('h2', {}, t('settings.general')));

  root.append(
    selectRow(t('settings.appMode'), {
      options: [
        ['chat', t('settings.appModeChat')],
        ['roleplay', t('settings.appModeStory')],
      ],
      get: () => s.appMode ?? 'chat',
      set: (v) => {
        if (v === (s.appMode ?? 'chat')) return;
        s.appMode = v;
        saveSettingsNow();
        cb.onModeChange?.();
      },
      hint: t('settings.appModeHint'),
    }),
    selectRow(t('settings.language'), {
      options: [
        ['system', t('settings.languageSystem')],
        ...Object.keys(LOCALES).map((code) => [code, LOCALE_LABELS[code]]),
      ],
      get: () => s.language ?? 'system',
      set: (v) => {
        s.language = v;
        saveSettingsNow();
        cb.applyLocale?.();
        cb.renderSidebar?.();
        renderSettings();
      },
    })
  );

  root.append(
    checkboxRow(t('settings.updateCheck'), {
      get: () => s.updateCheck !== false,
      set: (v) => {
        s.updateCheck = v;
        scheduleSettingsSave();
      },
      hint: t('settings.updateCheckHint'),
    })
  );
  const updateBtn = el('button', { class: 'btn' }, t('settings.checkNow'));
  const updateStatus = el('span', { class: 'hint', style: { marginLeft: '10px' } });
  window.tavern.misc.appVersion().then((v) => {
    updateStatus.textContent = t('settings.currentVersion', { version: v });
  });
  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    updateStatus.textContent = t('settings.checking');
    try {
      const update = await window.tavern.updates.check();
      if (update) {
        updateStatus.textContent = t('settings.versionAvailable', { version: update.version });
        cb.showUpdateBanner?.(update);
      } else {
        updateStatus.textContent = t('settings.latestVersion');
      }
    } catch (err) {
      updateStatus.textContent = t('settings.checkFailed', { msg: err.message });
    }
    updateBtn.disabled = false;
  });
  root.append(
    el('div', { class: 'form-row' },
      el('label', {}, t('settings.updates')),
      el('div', { class: 'form-inline' }, updateBtn, updateStatus)
    )
  );

  if (isChatMode()) {
    root.append(
      textareaRow(t('settings.assistantPrompt'), {
        get: () => s.chatSystemPrompt,
        set: (v) => {
          s.chatSystemPrompt = v;
          scheduleSettingsSave();
        },
        rows: 3,
        placeholder: DEFAULT_CHAT_SYSTEM_PROMPT,
        hint: t('settings.assistantPromptHint'),
      })
    );
  }

  root.append(
    selectRow(t('settings.userMode'), {
      options: [
        ['regular', t('settings.userModeRegular')],
        ['advanced', t('settings.userModeAdvanced')],
      ],
      get: () => s.uiMode,
      set: (v) => {
        s.uiMode = v;
        scheduleSettingsSave();
        renderSettings();
        toast(v === 'advanced' ? t('settings.advancedUnlocked') : t('settings.regularMode'), 'ok');
      },
      hint: t('settings.userModeHint'),
    }),
    selectRow(t('settings.theme'), {
      options: [
        ['system', t('settings.themeSystem')],
        ['dark', t('settings.themeDark')],
        ['light', t('settings.themeLight')],
      ],
      get: () => s.theme,
      set: (v) => {
        s.theme = v;
        scheduleSettingsSave();
        cb.applyAppearance?.();
      },
    }),
    sliderRow(t('settings.uiScale'), {
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
    sliderRow(t('settings.appFontSize'), {
      min: 11,
      max: 17,
      step: 1,
      get: () => s.appFontSize ?? 13,
      set: (v) => {
        s.appFontSize = v;
        scheduleSettingsSave();
        cb.applyAppearance?.();
      },
      hint: t('settings.appFontSizeHint'),
    }),
    selectRow(t('settings.appFont'), {
      options: [
        ['system', t('settings.fontSystem')],
        ['serif', t('settings.fontSerif')],
        ['rounded', t('settings.fontRounded')],
        ['mono', t('settings.fontMono')],
      ],
      get: () => s.appFontFamily ?? 'system',
      set: (v) => {
        s.appFontFamily = v;
        scheduleSettingsSave();
        cb.applyAppearance?.();
      },
    }),
    checkboxRow(t('settings.sendOnEnter'), {
      get: () => s.sendOnEnter,
      set: (v) => {
        s.sendOnEnter = v;
        scheduleSettingsSave();
      },
    })
  );

  if (isAdvanced()) {
    root.append(
      checkboxRow(t('settings.developerMode'), {
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
  const root = el('section', {}, el('h2', {}, t('settings.chatStyling')));

  const preview = el('div', {
    class: 'card msg-content',
    style: { fontSize: 'var(--chat-font-size)', lineHeight: 1.55 },
  });
  const updatePreview = () => {
    clear(preview);
    const quote = el('span', { class: 'md-quote' }, t('settings.previewDialogue'));
    const action = el('em', { class: 'md-action' }, t('settings.previewAction'));
    preview.append(quote, t('settings.previewSaid'), action, t('settings.previewNarrative'));
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
    el('p', { class: 'hint', style: { marginBottom: '14px' } }, t('settings.chatStylingHint')),
    colorRow(t('settings.dialogueColor'), 'quoteColor'),
    colorRow(t('settings.actionColor'), 'actionColor'),
    colorRow(t('settings.narrativeColor'), 'narrativeColor'),
    sliderRow(t('settings.chatFontSize'), {
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
    el('h3', {}, t('settings.preview')),
    preview,
    el('button', {
      class: 'btn',
      onclick: () => {
        Object.assign(style, { quoteColor: '#e8b75f', actionColor: '#a89bd4', narrativeColor: '#d8d8e0', fontSize: 14 });
        scheduleSettingsSave();
        cb.applyAppearance?.();
        renderSettings();
      },
    }, t('settings.resetDefaults'))
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
  const root = el('section', {}, el('h2', {}, t('settings.sectionGeneration')));

  if (isAdvanced() && state.presets.length) {
    root.append(
      selectRow(t('settings.activePreset'), {
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
        hint: t('settings.activePresetHint'),
      })
    );
  }

  root.append(
    sliderRow(t('settings.temperature'), { min: 0, max: 2, step: 0.05, get: () => p.temperature, set: set('temperature'),
      hint: t('settings.temperatureHint') }),
    sliderRow(t('settings.maxTokens'), { min: 64, max: 32768, step: 64, get: () => p.max_tokens, set: set('max_tokens'),
      hint: t('settings.maxTokensHint') }),
    checkboxRow(t('settings.streamResponses'), { get: () => p.stream_response, set: set('stream_response') }),
    selectRow(t('settings.reasoningEffort'), {
      options: [
        ['auto', t('settings.reasoningAuto')],
        ['none', t('settings.reasoningNone')],
        ['low', t('settings.reasoningLow')],
        ['medium', t('settings.reasoningMedium')],
        ['high', t('settings.reasoningHigh')],
      ],
      get: () => p.reasoning_effort ?? 'auto',
      set: set('reasoning_effort'),
      hint: t('settings.reasoningEffortHint'),
    }),
    checkboxRow(t('settings.costEstimates'), {
      get: () => s.showCostEstimates ?? true,
      set: (v) => {
        s.showCostEstimates = v;
        scheduleSettingsSave();
      },
      hint: t('settings.costEstimatesHint'),
    })
  );

  // Chat compression — keeps long conversations from resending everything
  const comp = s.chatCompression;
  root.append(
    el('h3', {}, t('settings.chatCompression')),
    checkboxRow(t('settings.compressChats'), {
      get: () => !!comp.enabled,
      set: (v) => {
        comp.enabled = v;
        scheduleSettingsSave();
        renderSettings();
      },
      hint: t('settings.compressChatsHint'),
    })
  );
  if (comp.enabled) {
    root.append(
      sliderRow(t('settings.compressAfter'), {
        min: 20, max: 200, step: 10,
        get: () => comp.afterMessages ?? 60,
        set: (v) => {
          comp.afterMessages = v;
          scheduleSettingsSave();
        },
        hint: t('settings.compressAfterHint'),
      })
    );
    if (isAdvanced()) {
      root.append(
        textareaRow(t('settings.compressionPrompt'), {
          get: () => comp.prompt ?? '',
          set: (v) => {
            comp.prompt = v;
            scheduleSettingsSave();
          },
          rows: 3,
          placeholder: DEFAULT_COMPRESSION_PROMPT,
          hint: t('settings.compressionPromptHint'),
        })
      );
    }
  }

  if (!isAdvanced()) {
    root.append(el('p', { class: 'hint' }, t('settings.advancedTeaser')));
    return root;
  }

  root.append(
    el('h3', {}, t('settings.sampling')),
    sliderRow(t('settings.topP'), { min: 0, max: 1, step: 0.01, get: () => p.top_p, set: set('top_p') }),
    sliderRow(t('settings.topK'), { min: 0, max: 200, step: 1, get: () => p.top_k, set: set('top_k') }),
    sliderRow(t('settings.minP'), { min: 0, max: 1, step: 0.01, get: () => p.min_p, set: set('min_p') }),
    sliderRow(t('settings.topA'), { min: 0, max: 1, step: 0.01, get: () => p.top_a, set: set('top_a') }),
    el('h3', {}, t('settings.repetitionControl')),
    sliderRow(t('settings.freqPenalty'), { min: -2, max: 2, step: 0.05, get: () => p.frequency_penalty, set: set('frequency_penalty') }),
    sliderRow(t('settings.presPenalty'), { min: -2, max: 2, step: 0.05, get: () => p.presence_penalty, set: set('presence_penalty') }),
    sliderRow(t('settings.repPenalty'), { min: 0.5, max: 2, step: 0.01, get: () => p.repetition_penalty, set: set('repetition_penalty'),
      hint: t('settings.repPenaltyHint') }),
    el('h3', {}, t('settings.context')),
    checkboxRow(t('settings.autoContext'), {
      get: () => p.context_size_auto ?? true,
      set: (v) => {
        p.context_size_auto = v;
        scheduleSettingsSave();
        renderSettings();
      },
      hint: contextAutoHint(),
    }),
    sliderRow(t('settings.contextSize'), {
      min: 0, max: 1048576, step: 1024, softMax: true,
      get: () => p.context_size, set: set('context_size'),
      hint: (p.context_size_auto ?? true) ? t('settings.contextSizeHintAuto') : t('settings.contextSizeHint'),
    }),
    textRow(t('settings.stopSequences'), {
      get: () => (p.stop_sequences ?? []).join(', '),
      set: (v) => {
        p.stop_sequences = v.split(',').map((x) => x.trim()).filter(Boolean);
        scheduleSettingsSave();
      },
    }),
    textRow(t('settings.seed'), {
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
  const base = t('settings.autoContextBase');
  const config = apiConfig();
  const known = knownModelContext(config.provider, config.model);
  if (known > 0) return t('settings.autoContextKnown', { base, model: config.model, tokens: known.toLocaleString() });
  if (known === 0) return t('settings.autoContextUnreported', { base, model: config.model });
  return t('settings.autoContextUnresolved', { base });
}

// ---------------------------------------------------------------------------
// Presets (advanced)

function renderPresets() {
  const s = state.settings;
  const root = el('section', {}, el('h2', {}, t('settings.generationPresets')));
  root.append(el('p', { class: 'hint', style: { marginBottom: '14px' } }, t('settings.presetsHint')));

  const nameInput = el('input', { type: 'text', placeholder: t('settings.presetName'), style: { maxWidth: '240px' } });
  root.append(
    el('div', { class: 'form-inline', style: { marginBottom: '16px' } },
      nameInput,
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) return toast(t('settings.enterPresetName'), 'error');
          try {
            await window.tavern.presets.save({ name, generationParams: { ...s.generationParams } });
            s.activePresetName = name;
            scheduleSettingsSave();
            await cb.reloadPresets?.();
            renderSettings();
            toast(t('settings.presetSaved', { name }), 'ok');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, t('settings.savePreset')),
      el('button', {
        class: 'btn',
        onclick: async () => {
          const files = await window.tavern.dialog.openFile({ filters: [{ name: t('settings.filterPresetJSON'), extensions: ['json'] }] });
          if (!files[0]) return;
          try {
            const preset = await window.tavern.presets.import(files[0]);
            await cb.reloadPresets?.();
            renderSettings();
            toast(t('settings.presetImported', { name: preset.name }), 'ok');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, t('common.import'))
    )
  );

  for (const preset of state.presets) {
    const isActive = s.activePresetName === preset.name;
    root.append(
      el('div', { class: 'list-row' },
        el('div', { class: 'list-main' },
          el('div', { class: 'list-title' }, preset.name, isActive ? el('span', { class: 'mode-badge', style: { marginLeft: '8px' } }, t('personas.active')) : null),
          el('div', { class: 'list-sub' },
            t('settings.presetSub', {
              temp: preset.generationParams.temperature,
              topP: preset.generationParams.top_p,
              tokens: preset.generationParams.max_tokens,
            }))
        ),
        el('button', {
          class: 'btn btn-small',
          onclick: () => {
            s.activePresetName = preset.name;
            s.generationParams = { ...preset.generationParams };
            scheduleSettingsSave();
            renderSettings();
            toast(t('settings.presetLoaded', { name: preset.name }), 'ok');
          },
        }, t('settings.load')),
        el('button', {
          class: 'btn-icon',
          title: t('common.export'),
          onclick: async () => {
            try {
              const saved = await window.tavern.presets.export(preset.name);
              if (saved) toast(t('settings.presetExported'), 'ok');
            } catch (err) {
              toast(t('common.exportFailed', { msg: err.message }), 'error');
            }
          },
        }, '⬆'),
        preset.name !== 'Default'
          ? el('button', {
              class: 'btn-icon',
              title: t('common.delete'),
              onclick: async () => {
                const ok = await confirmDialog(t('settings.deletePresetConfirm', { name: preset.name }));
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
  const root = el('section', {}, el('h2', {}, t('settings.promptCustomization')));
  root.append(
    textareaRow(t('settings.systemPromptOverride'), {
      get: () => s.systemPromptOverride,
      set: (v) => {
        s.systemPromptOverride = v;
        scheduleSettingsSave();
      },
      rows: 4,
      placeholder: t('settings.systemPromptPlaceholder'),
      hint: t('settings.systemPromptHint', { tokens: estimateTokens(s.systemPromptOverride) }),
    }),
    textareaRow(t('settings.reminderPrompt'), {
      get: () => s.reminderPrompt,
      set: (v) => {
        s.reminderPrompt = v;
        scheduleSettingsSave();
      },
      rows: 3,
      placeholder: t('settings.reminderPlaceholder'),
      hint: t('settings.reminderHint'),
    })
  );
  return root;
}

// ---------------------------------------------------------------------------
// Data

function renderData() {
  const root = el('section', {}, el('h2', {}, t('settings.data')));
  const dirHint = el('p', { class: 'hint', style: { marginBottom: '16px' } }, t('settings.loadingDataDir'));
  window.tavern.misc.dataDir().then((dir) => {
    dirHint.textContent = t('settings.dataDirInfo', { dir });
  });

  root.append(
    dirHint,
    el('h3', {}, t('settings.importDataFolder')),
    el('p', { class: 'hint', style: { marginBottom: '10px' } }, t('settings.importDataHint')),
    el('button', {
      class: 'btn',
      onclick: async () => {
        const dir = await window.tavern.dialog.openDirectory();
        if (!dir) return;
        try {
          const copied = await window.tavern.misc.importDataFolder(dir);
          toast(t('settings.dataImported', {
            characters: copied.characters,
            chats: copied.chats,
            worlds: copied.worlds,
            presets: copied.presets,
          }), 'ok');
          await cb.reloadAll?.();
          renderSettings();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, t('settings.chooseFolder'))
  );

  const stPreview = el('div');
  root.append(
    el('h3', { style: { marginTop: '22px' } }, t('settings.importST')),
    el('p', { class: 'hint', style: { marginBottom: '10px' } }, t('settings.importSTHint')),
    el('button', {
      class: 'btn',
      onclick: async () => {
        const dir = await window.tavern.dialog.openDirectory();
        if (!dir) return;
        try {
          const scan = await window.tavern.sillytavern.scan(dir);
          const total = Object.values(scan.counts).reduce((a, b) => a + b, 0);
          if (!total) return toast(t('settings.stNothingToImport'), 'error');
          renderSTPreview(stPreview, scan);
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }, t('settings.chooseSTFolder')),
    stPreview
  );
  return root;
}

const ST_CATEGORIES = () => [
  ['characters', t('settings.stCharacters')],
  ['chats', t('settings.stChats')],
  ['lorebooks', t('settings.stLorebooks')],
  ['personas', t('settings.stPersonas')],
  ['presets', t('settings.stPresets')],
];

/** Two-phase SillyTavern import: scan result → category checkboxes → import. */
function renderSTPreview(host, scan) {
  clear(host);
  const selected = {};
  const rows = [];
  for (const [key, label] of ST_CATEGORIES()) {
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
      if (!Object.values(selected).some(Boolean)) return toast(t('settings.nothingSelected'), 'error');
      importBtn.disabled = true;
      importBtn.textContent = t('settings.importing');
      // Live progress from the chunked main-process import (large ST
      // libraries take a while; the app stays responsive throughout)
      const offProgress = window.tavern.on('st:progress', ({ done, total }) => {
        importBtn.textContent = `${t('settings.importing')} ${done}/${total}`;
      });
      try {
        const res = await window.tavern.sillytavern.import(scan.dir, selected);
        // "Label: count" pairs are plural-agnostic, so they translate cleanly
        const parts = ST_CATEGORIES()
          .filter(([key]) => selected[key])
          .map(([key, label]) => `${label}: ${res.imported[key]}`);
        const failures = res.errors.length ? t('settings.stImportFailures', { count: res.errors.length }) : '';
        clear(host);
        toast(t('settings.stImported', { parts: parts.join(', ') }) + failures, res.errors.length ? 'error' : 'ok');
        // The count alone hides WHICH items were dropped — show the list
        if (res.errors.length) {
          modal(
            el('div', {},
              el('h2', {}, t('settings.stImportFailuresTitle')),
              el('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '12px', maxHeight: '50vh', overflowY: 'auto' } },
                res.errors.slice(0, 100).join('\n') + (res.errors.length > 100 ? `\n… +${res.errors.length - 100}` : ''))
            ),
            { width: 640 }
          );
        }
        await cb.reloadAll?.();
        renderSettings();
      } catch (err) {
        toast(err.message, 'error');
        importBtn.disabled = false;
        importBtn.textContent = t('settings.importSelected');
      } finally {
        offProgress?.();
      }
    },
  }, t('settings.importSelected'));
  host.append(
    el('div', { style: { margin: '12px 0 0', padding: '12px', border: '1px solid var(--border)', borderRadius: '8px', maxWidth: '420px' } },
      ...rows,
      el('div', { class: 'form-inline', style: { marginTop: '10px' } },
        importBtn,
        el('button', { class: 'btn', onclick: () => clear(host) }, t('common.cancel'))
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Developer (advanced + developerMode)

let devlogCleanup = null;

function renderDeveloper() {
  const root = el('section', {}, el('h2', {}, t('settings.developerLog')));
  const log = el('div', { class: 'devlog' });
  const renderLog = () => {
    clear(log);
    if (!state.devLog.length) log.append(el('div', { class: 'log-INFO' }, t('settings.noLogEntries')));
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
      }, t('settings.clearLog'))
    )
  );
  return root;
}
