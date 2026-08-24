// Curated per-release notes for the What's New dialog, shown once after the
// app first launches on a new version.
//
// Release checklist: add an entry at the TOP for every release, before
// bumping package.json. Keep items user-facing — what someone would notice
// or should try, not internals. `en` is required; other locales are optional
// and fall back to English.
import { compareVersions } from './version.js';

export const WHATS_NEW = [
  {
    version: '0.9.10',
    items: {
      en: [
        'Fixed: collapsing the 💭 thinking block while a response streams now works reliably every time — fast token streams could previously swallow the click before it registered.',
      ],
      es: [
        'Corregido: plegar el bloque de pensamiento 💭 mientras se transmite una respuesta ahora funciona de forma fiable siempre — antes, los flujos rápidos de tokens podían tragarse el clic antes de registrarse.',
      ],
      'zh-CN': [
        '修复：在回复流式生成期间折叠 💭 思考区块现在每次都可靠生效 — 此前较快的 token 流可能在点击生效前将其吞掉。',
      ],
      ja: [
        '修正：返信のストリーミング中に 💭 思考ブロックを折りたたむ操作が毎回確実に効くようになりました — 以前は高速なトークンストリームがクリックを取りこぼすことがありました。',
      ],
    },
  },
  {
    version: '0.9.9',
    items: {
      en: [
        'The sidebar collapse button now sits at the sidebar’s right edge and rides along as you resize it; hiding the sidebar slides the button to the window’s top-left corner — beside the traffic lights on macOS, into the free corner on Windows and Linux.',
      ],
      es: [
        'El botón de plegar la barra lateral ahora se sitúa en el borde derecho de la barra y la acompaña al redimensionarla; al ocultar la barra, el botón se desliza a la esquina superior izquierda de la ventana — junto a los botones de semáforo en macOS, y en la esquina libre en Windows y Linux.',
      ],
      'zh-CN': [
        '侧边栏折叠按钮现在位于侧边栏右缘，并随拖拽调宽而移动；隐藏侧边栏时，按钮滑动到窗口左上角 — 在 macOS 上紧邻红绿灯按钮，在 Windows 和 Linux 上占据空闲的角落。',
      ],
      ja: [
        'サイドバーの折りたたみボタンがサイドバーの右端に配置され、幅の変更にも追従するようになりました。サイドバーを隠すとボタンはウィンドウ左上へスライドします — macOS では信号機ボタンの隣に、Windows と Linux では空いた角に収まります。',
      ],
    },
  },
  {
    version: '0.9.8',
    items: {
      en: [
        'The 💭 thinking block is now fully usable while the model is still thinking: scroll through it freely (it holds your place, and follows the newest text when you’re at the bottom), collapse or expand it mid-stream and it stays that way — reopening jumps back to the live tail.',
        'New "Show thinking" setting (Settings → Generation) hides reasoning-model thinking entirely if you’d rather not see it — the usual typing dots show while the model thinks, and the reply appears as normal.',
        'The sidebar collapse button now stays put in the top-left when you hide the sidebar — like other chat apps — instead of dropping down into the header.',
        'The bottom-left navigation box now lines up exactly with the message box, so the bottom of the window reads as one clean row.',
      ],
      es: [
        'El bloque de pensamiento 💭 ahora es totalmente usable mientras el modelo sigue pensando: desplázate por él libremente (mantiene tu posición y sigue el texto más reciente cuando estás al final), pliégalo o expándelo en plena transmisión y así se queda — al reabrirlo vuelve al final en vivo.',
        'Nuevo ajuste «Mostrar el pensamiento» (Ajustes → Generación) que oculta por completo el pensamiento de los modelos de razonamiento si prefieres no verlo — se muestran los puntos habituales mientras el modelo piensa, y la respuesta aparece con normalidad.',
        'El botón de plegar la barra lateral ahora se queda fijo arriba a la izquierda al ocultar la barra — como en otras apps de chat — en lugar de bajar a la cabecera.',
        'El cuadro de navegación inferior izquierdo ahora se alinea exactamente con el cuadro de mensaje, así que la parte inferior de la ventana se ve como una sola fila limpia.',
      ],
      'zh-CN': [
        '💭 思考区块在模型思考期间现已完全可用：可以自由滚动（保持你的位置，滚到底部时跟随最新文本），流式生成中折叠或展开都会保持原样 — 重新展开时会跳回实时末尾。',
        '新增「显示思考过程」设置（设置 → 生成）：如果不想看到推理模型的思考，可将其完全隐藏 — 模型思考时显示常规的输入圆点，回复照常出现。',
        '隐藏侧边栏时，折叠按钮现在固定停留在左上角 — 与其他聊天应用一致 — 而不再下移到页眉中。',
        '左下角的导航框现在与消息输入框精确对齐，窗口底部看起来是整齐的一行。',
      ],
      ja: [
        '💭 思考ブロックがモデルの思考中でも完全に操作可能に：自由にスクロールでき（位置を保持し、最下部にいるときは最新のテキストに追従）、ストリーミング中に折りたたみ・展開してもその状態が維持されます — 再展開するとライブの末尾に戻ります。',
        '新しい「思考を表示」設定（設定 → 生成）：推論モデルの思考を見たくない場合は完全に非表示にできます — 思考中はいつものドットが表示され、返信は通常どおり届きます。',
        'サイドバーを隠したとき、折りたたみボタンが左上に固定されたままになりました — 他のチャットアプリと同様で、ヘッダーに降りてくることはありません。',
        '左下のナビゲーションボックスがメッセージ入力欄とぴったり揃い、ウィンドウの下部がきれいな一列に見えるようになりました。',
      ],
    },
  },
  {
    version: '0.9.7',
    items: {
      en: [
        'Huge chats are now first-class: only the newest messages are built on screen and earlier ones stream in as you scroll up, so a thousand-message conversation opens instantly — search jumps still land anywhere in the history.',
        'Big SillyTavern libraries import smoothly: the app stays responsive with live progress, corrupt lines in a chat file are skipped (and reported) instead of losing the whole chat, and failures are listed by name.',
        'Heavy work moved off the hot path: chat files are read and written on a background thread, and searching all chats no longer freezes the app — mid-typing searches cancel instantly.',
        'Chat compression got safer: big backlogs are summarized in batches that always fit the model, and small-context models no longer re-compress on every turn.',
        'You can now drag the top edge of the message box to make it taller (double-click resets), and the sidebar collapse button tucks neatly into the header when the sidebar is hidden.',
      ],
      es: [
        'Los chats enormes ahora son de primera clase: solo se construyen en pantalla los mensajes más recientes y los anteriores aparecen al desplazarte hacia arriba, así que una conversación de mil mensajes se abre al instante — los saltos de búsqueda siguen llegando a cualquier punto del historial.',
        'Las bibliotecas grandes de SillyTavern se importan sin problemas: la app sigue respondiendo con progreso en vivo, las líneas corruptas de un chat se omiten (y se informan) en lugar de perder todo el chat, y los fallos se listan por nombre.',
        'El trabajo pesado salió del camino crítico: los archivos de chat se leen y escriben en un hilo en segundo plano, y buscar en todos los chats ya no congela la app — las búsquedas a mitad de escritura se cancelan al instante.',
        'La compresión de chats es más segura: los historiales grandes se resumen en lotes que siempre caben en el modelo, y los modelos de contexto pequeño ya no recomprimen en cada turno.',
        'Ahora puedes arrastrar el borde superior del cuadro de mensaje para hacerlo más alto (doble clic lo restablece), y el botón de plegar la barra lateral se integra en la cabecera cuando la barra está oculta.',
      ],
      'zh-CN': [
        '超长对话现已获得一流支持：屏幕上只构建最新的消息，向上滚动时较早的消息无缝载入，上千条消息的对话瞬间打开 — 搜索跳转仍可到达历史记录中的任何位置。',
        '大型 SillyTavern 库可以顺畅导入：应用保持响应并实时显示进度，聊天文件中的损坏行会被跳过（并报告）而不会丢失整个聊天，失败项会按名称列出。',
        '繁重工作移出了关键路径：聊天文件在后台线程读写，搜索全部聊天不再冻结应用 — 输入中途的搜索会立即取消。',
        '聊天压缩更安全：大量积压的消息会分批摘要，始终不超过模型的上下文，小上下文模型也不再每轮都重新压缩。',
        '现在可以拖动消息输入框的上边缘调高它（双击重置），侧边栏折叠按钮在侧边栏隐藏时会整齐地收进页眉。',
      ],
      ja: [
        '巨大なチャットを本格サポート：画面には最新のメッセージだけを構築し、上にスクロールすると過去分がシームレスに読み込まれます。1000件のメッセージがある会話も一瞬で開き、検索ジャンプは履歴のどこへでも移動できます。',
        '大きな SillyTavern ライブラリもスムーズにインポート：進行状況をライブ表示しながらアプリは応答し続け、チャットファイル内の壊れた行はチャット全体を失う代わりにスキップ（および報告）され、失敗は名前つきで一覧表示されます。',
        '重い処理をホットパスから移動：チャットファイルの読み書きはバックグラウンドスレッドで行われ、全チャット検索でアプリが固まらなくなりました — 入力途中の検索は即座にキャンセルされます。',
        'チャット圧縮がより安全に：大量の未圧縮履歴はモデルに必ず収まるバッチで要約され、小さいコンテキストのモデルで毎ターン再圧縮されることもなくなりました。',
        'メッセージ入力欄の上端をドラッグして高くできるようになりました（ダブルクリックでリセット）。サイドバーを隠すと、折りたたみボタンがヘッダーにきれいに収まります。',
      ],
    },
  },
  {
    version: '0.9.6',
    items: {
      en: [
        'Reasoning models (GLM, DeepSeek R1, o-series) no longer look stuck: their thinking now streams live into a collapsible 💭 block above the reply, so you can watch — or stop — a long think instead of staring at dots.',
        'New Reasoning Effort setting (Settings → Generation): keep the model default, cap thinking at low/medium/high, or turn it off where the model allows.',
        'If a model spends its entire response budget thinking and produces no reply, the app now says exactly that — with its thoughts kept visible — instead of showing a mysteriously empty message.',
      ],
      es: [
        'Los modelos de razonamiento (GLM, DeepSeek R1, serie o) ya no parecen colgados: su pensamiento se transmite en vivo en un bloque 💭 plegable encima de la respuesta, para que puedas observar — o detener — un pensamiento largo en lugar de mirar puntos suspensivos.',
        'Nuevo ajuste Esfuerzo de razonamiento (Ajustes → Generación): mantén el valor predeterminado del modelo, limita el pensamiento a bajo/medio/alto, o desactívalo donde el modelo lo permita.',
        'Si un modelo gasta todo su presupuesto de respuesta pensando y no produce ninguna respuesta, la app ahora lo dice claramente — manteniendo sus pensamientos visibles — en lugar de mostrar un mensaje misteriosamente vacío.',
      ],
      'zh-CN': [
        '推理模型（GLM、DeepSeek R1、o 系列）不再像卡住了一样：思考过程会实时显示在回复上方的可折叠 💭 区块中，你可以观看 — 或中止 — 长时间的思考，而不是干等省略号。',
        '新增推理强度设置（设置 → 生成）：保持模型默认、将思考限制为低/中/高，或在模型支持时关闭。',
        '如果模型把全部回复预算都用于思考而没有生成回复，应用现在会明确说明 — 并保留其思考内容可见 — 而不是显示一条莫名其妙的空消息。',
      ],
      ja: [
        '推論モデル（GLM、DeepSeek R1、o シリーズ）が固まって見える問題を解消：思考が返信の上の折りたたみ可能な 💭 ブロックにライブ表示されるので、長い思考を眺める — または停止する — ことができます。',
        '新しい「推論の深さ」設定（設定 → 生成）：モデルの既定のまま、低/中/高で思考を制限、または対応モデルではオフにできます。',
        'モデルが応答予算のすべてを思考に費やして返答を生成しなかった場合、謎の空メッセージではなく、その旨をはっきり表示します — 思考内容も見えるまま残ります。',
      ],
    },
  },
  {
    version: '0.9.5',
    items: {
      en: [
        'Long chats are now faster and cheaper: prompts are arranged so providers can cache your character card and lore between turns — automatic for most models, with explicit caching for Claude (including via OpenRouter).',
        'World lore got smarter: entries keep triggering from the compressed-chat summary, stay active a few turns after their keywords scroll away (new per-entry Sticky setting), and a new “Match whole words” option stops look-alike keywords from firing mid-word.',
        'Real costs: token counts and dollar amounts now come straight from the provider when reported — including cached-token discounts — instead of estimates. Hover a message’s timestamp to see them.',
        'Chat compression now also triggers by conversation size (not just message count), runs for conversations that finish in the background, and keeps structured notes on facts, characters, and open plot threads.',
        'Claude and Gemini now receive author’s notes, reminders, and post-history instructions near the end of the prompt — where they belong — instead of buried at the top.',
      ],
      es: [
        'Los chats largos ahora son más rápidos y baratos: los prompts se organizan para que los proveedores puedan cachear tu tarjeta de personaje y el lore entre turnos — automático para la mayoría de modelos, con caché explícita para Claude (incluso vía OpenRouter).',
        'El lore del mundo es más inteligente: las entradas siguen activándose desde el resumen del chat comprimido, permanecen activas unos turnos después de que sus palabras clave desaparezcan (nuevo ajuste Persistencia por entrada), y la nueva opción «Solo palabras completas» evita activaciones dentro de otras palabras.',
        'Costes reales: los recuentos de tokens y los importes en dólares ahora vienen directamente del proveedor cuando los informa — incluidos los descuentos por tokens en caché — en lugar de estimaciones. Pasa el cursor sobre la hora de un mensaje para verlos.',
        'La compresión de chats ahora también se activa por el tamaño de la conversación (no solo por número de mensajes), funciona para conversaciones que terminan en segundo plano y mantiene notas estructuradas de hechos, personajes y tramas abiertas.',
        'Claude y Gemini ahora reciben las notas de autor, los recordatorios y las instrucciones post-historial cerca del final del prompt — donde corresponde — en lugar de enterrados al principio.',
      ],
      'zh-CN': [
        '长对话更快更省钱：提示词经过重新编排，服务商可以在多轮之间缓存你的角色卡和世界设定 — 大多数模型自动生效，Claude 使用显式缓存（包括通过 OpenRouter）。',
        '世界设定更智能：条目可以从压缩摘要中继续触发，关键词滚出范围后仍保持激活几轮（每条目新增“延续”设置），新的“仅匹配完整单词”选项可避免相似关键词在单词中间误触发。',
        '真实费用：token 数量和美元金额现在在服务商报告时直接采用其数据 — 包括缓存 token 折扣 — 而非估算值。将鼠标悬停在消息时间上即可查看。',
        '聊天压缩现在也会按对话大小触发（不只是消息数量），对在后台完成的对话同样生效，并以结构化笔记保留事实、角色和未完结的情节线索。',
        'Claude 和 Gemini 现在会在提示词末尾附近收到作者注释、提醒和后置指令 — 在它们应在的位置 — 而不是被埋在开头。',
      ],
      ja: [
        '長いチャットがより速く、より安くなりました。プロンプトの構成を見直し、キャラクターカードやロアをターン間でプロバイダーがキャッシュできるようになりました — 多くのモデルで自動、Claude では明示的キャッシュ（OpenRouter 経由も含む）。',
        'ワールドロアが賢くなりました。圧縮された要約からもエントリが発動し続け、キーワードが範囲外になっても数ターンは有効なまま（エントリごとの新しい「持続」設定）。新しい「単語単位で一致」オプションで、単語の途中での誤発動を防げます。',
        '実際のコスト表示: トークン数と金額は、プロバイダーが報告する場合はその値をそのまま使用します — キャッシュトークンの割引も含む — 推定値ではありません。メッセージの時刻にカーソルを合わせると確認できます。',
        'チャット圧縮は、メッセージ数だけでなく会話のサイズでも発動するようになり、バックグラウンドで完了した会話にも働き、事実・登場人物・未解決の筋書きを構造化されたメモとして保持します。',
        'Claude と Gemini では、作者ノート・リマインダー・ポストヒストリー指示がプロンプトの末尾近く（本来の位置）に配置されるようになりました。冒頭に埋もれることはもうありません。',
      ],
    },
  },
  {
    version: '0.9.4',
    items: {
      en: [
        'The model pickers in Settings now open a proper in-app list — click to browse every model or type to search, with context sizes and pricing, and smooth scrolling even through hundreds of models.',
        'Deleting a character now archives its chat history on disk (chats/_archived), so a new character with the same name starts fresh instead of inheriting old chats.',
        'Characters without a picture now show a grey silhouette instead of a blank circle.',
        'UI polish: icon buttons, toolbars, and the chat input bar now line up evenly across the app.',
      ],
      es: [
        'Los selectores de modelo en Ajustes ahora abren una lista propia de la app — haz clic para explorar todos los modelos o escribe para buscar, con tamaños de contexto y precios, y desplazamiento fluido incluso con cientos de modelos.',
        'Eliminar un personaje ahora archiva su historial de chat en el disco (chats/_archived), así que un personaje nuevo con el mismo nombre empieza de cero en vez de heredar chats antiguos.',
        'Los personajes sin imagen ahora muestran una silueta gris en lugar de un círculo vacío.',
        'Pulido de la interfaz: los botones de icono, las barras de herramientas y la barra de entrada del chat ahora quedan alineados en toda la app.',
      ],
      'zh-CN': [
        '设置中的模型选择器现在使用应用内置列表 — 点击浏览全部模型或输入搜索，显示上下文大小和价格，即使有数百个模型也能流畅滚动。',
        '删除角色时会将其聊天记录归档到磁盘（chats/_archived），因此同名的新角色将从零开始，而不会继承旧聊天。',
        '没有图片的角色现在显示灰色剪影，而不是空白圆圈。',
        '界面打磨：图标按钮、工具栏和聊天输入栏在整个应用中对齐一致。',
      ],
      ja: [
        '設定のモデル選択がアプリ内リストになりました — クリックで全モデルを一覧でき、入力で検索。コンテキストサイズと価格を表示し、数百モデルでもスムーズにスクロールできます。',
        'キャラクターを削除すると、チャット履歴はディスク上にアーカイブされます（chats/_archived）。同じ名前の新しいキャラクターは、古いチャットを引き継がずまっさらな状態で始まります。',
        '画像のないキャラクターは、空白の円ではなくグレーのシルエットで表示されるようになりました。',
        'UI の仕上げ: アイコンボタン、ツールバー、チャット入力欄がアプリ全体で揃うようになりました。',
      ],
    },
  },
  {
    version: '0.9.3',
    items: {
      en: [
        'One-click updates: when a new version is out, the banner now downloads and installs it right in the app — no more manual downloads (macOS, Windows, and Linux AppImage; starting with the next update).',
      ],
      es: [
        'Actualizaciones con un clic: cuando hay una nueva versión, el banner ahora la descarga e instala directamente en la app — se acabaron las descargas manuales (macOS, Windows y AppImage de Linux; a partir de la próxima actualización).',
      ],
      'zh-CN': [
        '一键更新：有新版本时，横幅现在可以直接在应用内下载并安装 — 无需再手动下载（macOS、Windows 和 Linux AppImage；从下一次更新开始生效）。',
      ],
      ja: [
        'ワンクリック更新: 新しいバージョンが出ると、バナーからアプリ内で直接ダウンロードしてインストールできるようになりました — 手動ダウンロードは不要です（macOS、Windows、Linux AppImage。次回の更新から有効）。',
      ],
    },
  },
  {
    version: '0.9.2',
    items: {
      en: [
        'New provider: NanoGPT — hundreds of models with one pay-as-you-go key, with live pricing and context sizes in the model picker.',
        'Simpler provider lineup: OpenRouter, NanoGPT, OpenAI, Anthropic Claude, and Google Gemini. If your previous provider was removed, pick a new one in Settings → API.',
        'Fixed the update check sometimes reporting a new version when you were already up to date.',
      ],
      es: [
        'Nuevo proveedor: NanoGPT — cientos de modelos con una sola clave de pago por uso, con precios y tamaños de contexto en vivo en el selector de modelos.',
        'Lista de proveedores simplificada: OpenRouter, NanoGPT, OpenAI, Anthropic Claude y Google Gemini. Si tu proveedor anterior fue eliminado, elige uno nuevo en Ajustes → API.',
        'Corregido: la comprobación de actualizaciones a veces indicaba una nueva versión cuando ya estabas al día.',
      ],
      'zh-CN': [
        '新增服务商：NanoGPT — 一个按量付费的密钥即可使用数百个模型，模型选择器中实时显示价格和上下文大小。',
        '服务商列表更精简：OpenRouter、NanoGPT、OpenAI、Anthropic Claude 和 Google Gemini。如果你之前的服务商已被移除，请在 设置 → API 中重新选择。',
        '修复了已是最新版本时更新检查仍可能提示新版本的问题。',
      ],
      ja: [
        '新しいプロバイダー: NanoGPT — 従量課金のキー1つで数百のモデルを利用でき、モデル選択画面に価格とコンテキストサイズをライブ表示します。',
        'プロバイダー構成を整理: OpenRouter、NanoGPT、OpenAI、Anthropic Claude、Google Gemini。以前のプロバイダーが削除された場合は、設定 → API で選び直してください。',
        '最新版なのに更新チェックが新バージョンありと表示することがある問題を修正しました。',
      ],
    },
  },
  {
    version: '0.9.1',
    items: {
      en: [
        'After each update, this What’s New dialog now summarizes the changes.',
        'Editing a character no longer drops hidden card data (SillyTavern extensions, V3 extras) when saving.',
        'OpenAI reasoning models (o-series, GPT-5) now work through the Custom provider when pointed at api.openai.com.',
        'Windows: the installer now has a proper app icon.',
      ],
      es: [
        'Después de cada actualización, este diálogo de novedades resume los cambios.',
        'Editar un personaje ya no elimina datos ocultos de la tarjeta (extensiones de SillyTavern, extras V3) al guardar.',
        'Los modelos de razonamiento de OpenAI (serie o, GPT-5) ahora funcionan con el proveedor personalizado apuntando a api.openai.com.',
        'Windows: el instalador ahora tiene un icono adecuado.',
      ],
      'zh-CN': [
        '每次更新后，这个“新功能”对话框会总结变更内容。',
        '编辑角色时不再丢失卡片中的隐藏数据（SillyTavern 扩展、V3 附加字段）。',
        'OpenAI 推理模型（o 系列、GPT-5）现在可通过指向 api.openai.com 的自定义服务商使用。',
        'Windows：安装程序现在有了正确的应用图标。',
      ],
      ja: [
        'アップデート後に、この「新機能」ダイアログが変更点をまとめて表示します。',
        'キャラクター編集時に、カードの非表示データ（SillyTavern 拡張、V3 の追加フィールド）が保存で失われなくなりました。',
        'OpenAI の推論モデル（o シリーズ、GPT-5）が、api.openai.com を指すカスタムプロバイダー経由でも動作するようになりました。',
        'Windows：インストーラーに正しいアプリアイコンが付きました。',
      ],
    },
  },
  {
    version: '0.9.0',
    items: {
      en: [
        'The entire UI now speaks English, Spanish, Simplified Chinese, and Japanese — switch in the settings.',
        'Generate images with the 🎨 button, powered by a dedicated image model.',
        'Long chats stay fast: older messages are summarized automatically in the background.',
      ],
      es: [
        'La interfaz ahora está disponible en inglés, español, chino simplificado y japonés — cámbialo en los ajustes.',
        'Genera imágenes con el botón 🎨, con un modelo de imagen dedicado.',
        'Los chats largos siguen siendo rápidos: los mensajes antiguos se resumen automáticamente en segundo plano.',
      ],
      'zh-CN': [
        '界面现已支持英语、西班牙语、简体中文和日语，可在设置中切换。',
        '使用 🎨 按钮生成图片，由专用图像模型驱动。',
        '长对话保持流畅：较早的消息会在后台自动压缩为摘要。',
      ],
      ja: [
        'UI が英語・スペイン語・簡体字中国語・日本語に対応しました。設定から切り替えられます。',
        '🎨 ボタンで専用の画像モデルによる画像生成ができます。',
        '長いチャットも快適に：古いメッセージはバックグラウンドで自動的に要約されます。',
      ],
    },
  },
];

/**
 * Notes for every version newer than `lastSeen` up to and including
 * `current`, newest first, with items resolved for `locale` (English
 * fallback). Returns [{ version, items: [string] }].
 */
export function notesSince(lastSeen, current, locale = 'en') {
  return WHATS_NEW.filter(
    (e) => compareVersions(e.version, lastSeen) > 0 && compareVersions(e.version, current) <= 0
  )
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((e) => ({ version: e.version, items: e.items[locale] ?? e.items.en }))
    .filter((e) => e.items?.length);
}
