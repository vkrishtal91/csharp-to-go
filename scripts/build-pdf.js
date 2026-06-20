#!/usr/bin/env node
/*
 * build-pdf.js — собирает единый PDF из markdown-учебника «От .NET к Go».
 *
 * Стек: markdown-it (+ серверная подсветка highlight.js) → один HTML →
 * Chrome (puppeteer-core, без скачивания Chromium) рендерит mermaid и
 * Paged.js (книжная вёрстка с колонтитулами и оглавлением) → PDF.
 *
 * Структура PDF: картинка-обложка (assets/cover.png) → текстовая титульная
 * страница → страница автора (author.md, если есть) → оглавление с номерами
 * страниц → главы (docs/**) с бегущими колонтитулами.
 *
 * Запуск:  cd scripts && PUPPETEER_SKIP_DOWNLOAD=1 npm install && node build-pdf.js
 *
 * Корень репозитория = на уровень выше scripts/. Оттуда читаются docs/**,
 * assets/cover.png, author.md; PDF пишется в корень (csharp-to-go.pdf).
 *
 * Окружение/переопределения (все необязательны):
 *   CHROME_PATH   — путь к Google Chrome (дефолт — стандартный macOS-путь).
 *   COVER_IMAGE   — путь к картинке-обложке (дефолт assets/cover.png).
 *   AUTHOR_MD     — путь к странице автора (дефолт author.md в корне).
 *   REPO_ROOT     — корень репозитория (обычно вычисляется автоматически).
 *
 * Кэш: отрендеренные mermaid-SVG кэшируются в scripts/.cache/mermaid/<sha1>.svg
 * (gitignored). Повторные сборки берут диаграммы из кэша — фаза mermaid
 * становится практически мгновенной. Промежуточный book.html — в scripts/.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');
const puppeteer = require('puppeteer-core');

// Глобальный счётчик уникальных id заголовков (для якорей оглавления).
let tocCounter = 0;

// Набор sha1-хешей всех mermaid-диаграмм (по ИСПРАВЛЕННОМУ исходнику).
// Заполняется при рендере fence; используется для предзагрузки кэша.
const mermaidHashes = new Set();

function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// Абсолютный путь → file://-URL (Chrome запущен с --allow-file-access-from-files).
// На Windows добавляем ведущий '/' и нормализуем разделители.
function toFileUrl(abs) {
  const p = abs.replace(/\\/g, '/');
  return 'file://' + (p.startsWith('/') ? '' : '/') + p;
}

// Читает с диска SVG для тех хешей, что уже закэшированы. Возвращает {hash: svg}.
function loadMermaidCache(hashes) {
  const map = {};
  if (!fs.existsSync(MERMAID_CACHE_DIR)) return map;
  for (const h of hashes) {
    const f = path.join(MERMAID_CACHE_DIR, h + '.svg');
    try {
      if (fs.existsSync(f)) {
        const svg = fs.readFileSync(f, 'utf8');
        if (svg && svg.indexOf('<svg') !== -1) map[h] = svg;
      }
    } catch (_) {
      /* битый файл кэша — просто перерендерим */
    }
  }
  return map;
}

// Сохраняет свежеотрендеренные SVG в кэш (по одному файлу на хеш).
function saveMermaidCache(freshSvgByHash) {
  if (!freshSvgByHash) return 0;
  fs.mkdirSync(MERMAID_CACHE_DIR, { recursive: true });
  let written = 0;
  for (const [h, svg] of Object.entries(freshSvgByHash)) {
    if (!h || !svg || svg.indexOf('<svg') === -1) continue;
    try {
      fs.writeFileSync(path.join(MERMAID_CACHE_DIR, h + '.svg'), svg, 'utf8');
      written++;
    } catch (_) {
      /* не критично */
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Пути
// ---------------------------------------------------------------------------
const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Корень репозитория: либо аргумент, либо два уровня вверх от scripts/, либо CWD.
const REPO_ROOT = (() => {
  if (process.env.REPO_ROOT) return process.env.REPO_ROOT;
  // если скрипт лежит в <repo>/scripts/, берём родителя
  const maybe = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(maybe, 'docs')) && fs.existsSync(path.join(maybe, 'README.md'))) {
    return maybe;
  }
  return process.cwd();
})();

const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const README = path.join(REPO_ROOT, 'README.md');
const OUT_PDF = path.join(REPO_ROOT, 'csharp-to-go.pdf');

// Картинка-обложка (самая первая страница PDF). По умолчанию — assets/cover.png
// относительно корня репозитория, чтобы пересборка работала «из коробки».
// Переопределяется переменной окружения COVER_IMAGE.
const COVER_IMAGE = process.env.COVER_IMAGE || path.join(REPO_ROOT, 'assets', 'cover.png');

// Локальная страница «Об авторе» (НЕ в git). Если файл есть — рендерим её
// отдельной страницей после обложки; если нет — молча пропускаем.
const AUTHOR_MD = process.env.AUTHOR_MD || path.join(REPO_ROOT, 'author.md');

// Кэш отрендеренных mermaid-SVG. Ключ — sha1 от ИСПРАВЛЕННОГО (fixMermaid)
// исходника диаграммы; повторные сборки берут SVG из кэша, не открывая браузер.
const CACHE_DIR = path.join(__dirname, '.cache');
const MERMAID_CACHE_DIR = path.join(CACHE_DIR, 'mermaid');

// node_modules — рядом со скриптом (в pdfbuild) или внутри scripts/.
function resolveModuleFile(rel) {
  const candidates = [
    path.join(__dirname, 'node_modules', rel),
    path.join(REPO_ROOT, 'node_modules', rel),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // последняя попытка — через require.resolve
  try {
    return require.resolve(rel);
  } catch (_) {
    throw new Error(`Не найден ресурс модуля: ${rel}\nИскал в:\n  ${candidates.join('\n  ')}`);
  }
}

const HTML_OUT = path.join(__dirname, 'book.html');

// ---------------------------------------------------------------------------
// markdown-it с серверной подсветкой и кастомным fence для mermaid
// ---------------------------------------------------------------------------
const md = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false,
  highlight(code, lang) {
    if (lang === 'mermaid') return ''; // обрабатывается кастомным fence ниже
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch (_) {
        /* ignore */
      }
    }
    try {
      return hljs.highlightAuto(code).value;
    } catch (_) {
      return md.utils.escapeHtml(code);
    }
  },
});

// id заголовкам присваиваем вручную при рендере глав (см. renderChapters),
// чтобы иметь стабильные уникальные якоря для target-counter в оглавлении.

// Приводит текст mermaid-диаграммы к синтаксису, совместимому с mermaid v11.
// Исходные .md НЕ трогаем — правки делаются только в памяти при сборке.
// Три класса несовместимостей, найденные в учебнике:
//   1) flowchart: пустая подпись у пунктирной связи  «-. .->» / «-. .-»
//      mermaid v11 такое не парсит → делаем обычную пунктирную связь «-.->» / «-.-».
//   2) node-лейблы с экранированными кавычками  \"  → entity #quot;
//      (mermaid v11 не понимает обратный слэш внутри ["..."]).
//   3) sequenceDiagram: символ «;» — разделитель инструкций; внутри текста
//      сообщения (строка с стрелкой и «:») заменяем «;» на «,».
function fixMermaid(code) {
  const firstLine = (code.trim().split('\n')[0] || '').toLowerCase();
  let out = code;
  // 1) пустая пунктирная подпись
  out = out.replace(/-\.\s+\.->/g, '-.->').replace(/-\.\s+\.-(?!>)/g, '-.-');
  // 2) \" → #quot;
  out = out.replace(/\\"/g, '#quot;');
  // 3) sequenceDiagram: ';' в тексте сообщения → ','
  if (firstLine.startsWith('sequencediagram')) {
    out = out
      .split('\n')
      .map((line) => {
        const ci = line.indexOf(':');
        if (ci > -1 && line.slice(0, ci).includes('>')) {
          return line.slice(0, ci + 1) + line.slice(ci + 1).replace(/;/g, ',');
        }
        return line;
      })
      .join('\n');
  }
  return out;
}

// Кастомный fence: ```mermaid → <pre class="mermaid"> с СЫРЫМ (после fixMermaid) текстом.
const defaultFence =
  md.renderer.rules.fence ||
  function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
md.renderer.rules.fence = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const info = (token.info || '').trim().split(/\s+/g)[0];
  if (info === 'mermaid') {
    // Применяем 3 in-memory фикса ДО хеширования — чтобы ключ кэша был
    // стабилен независимо от мелких различий исходного текста.
    const fixed = fixMermaid(token.content);
    const hash = sha1(fixed);
    mermaidHashes.add(hash);
    // Оборачиваем в <figure class="diagram"> — контейнер, который не рвётся
    // и ограничивает высоту SVG (см. CSS). Сырой текст диаграммы без
    // HTML-экранирования — mermaid v10+ читает .mermaid.
    return `<figure class="diagram"><pre class="mermaid" data-mhash="${hash}">${fixed}</pre></figure>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// ---------------------------------------------------------------------------
// Сбор списка файлов глав
// ---------------------------------------------------------------------------
function listChapterFiles() {
  // папки docs/*/ отсортированы строкой (bonus окажется после 14 — это верно)
  const dirs = fs
    .readdirSync(DOCS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const files = [];
  for (const dir of dirs) {
    const abs = path.join(DOCS_DIR, dir);
    const readme = path.join(abs, 'README.md');
    if (fs.existsSync(readme)) files.push(readme);

    const numbered = fs
      .readdirSync(abs)
      .filter((f) => /^\d+.*\.md$/.test(f))
      .sort(); // 01-, 02-, ... по возрастанию строкой
    for (const f of numbered) files.push(path.join(abs, f));
  }
  return files;
}

// Удаляет хвостовой навигационный футер: строку «[⌂ Главная]…» и предшествующий ей «---».
function stripFooter(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  // ищем последнюю строку, начинающуюся с [⌂ Главная]
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimStart().startsWith('[⌂ Главная]')) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx === -1) return src;
  // отрезаем от footerIdx и назад: убираем пустые строки и предшествующий ---
  let cut = footerIdx;
  // назад от футера: пропускаем пустые строки
  let j = footerIdx - 1;
  while (j >= 0 && lines[j].trim() === '') j--;
  if (j >= 0 && lines[j].trim() === '---') {
    cut = j; // отрезаем начиная с разделителя
  } else {
    cut = footerIdx;
  }
  return lines.slice(0, cut).join('\n').replace(/\s+$/g, '') + '\n';
}

// Текстовая титульная страница: H1 + первые два абзаца README
// (до первого --- / «Оглавление»). Ведущий <p align="center"><img ...></p>
// из README отбрасываем: картинка-обложка теперь отдельная первая страница,
// а её относительный путь в book.html не разрешается (давал «битую» иконку).
function buildCover() {
  let raw = fs.readFileSync(README, 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const out = [];
  for (const line of lines) {
    if (line.trim() === '---') break;
    if (/^##\s/.test(line) && /Оглавление/i.test(line)) break;
    out.push(line);
  }
  let text = out.join('\n');
  // Убираем верхний центрированный блок с <img> (HTML внутри markdown).
  text = text.replace(/^\s*<p[^>]*>\s*<img[\s\S]*?<\/p>\s*/i, '');
  return text.trim();
}

// ---------------------------------------------------------------------------
// Рендер глав в HTML + сбор данных оглавления
// ---------------------------------------------------------------------------
function renderChapters() {
  const files = listChapterFiles();
  const chaptersHtml = [];
  const toc = []; // {level, title, id}

  for (const file of files) {
    const isReadme = path.basename(file).toLowerCase() === 'readme.md';
    let src = fs.readFileSync(file, 'utf8');
    src = stripFooter(src);

    // Токенизируем, чтобы вытащить H1/H2 для оглавления и проставить им id.
    const env = {};
    const tokens = md.parse(src, env);

    // Найдём заголовки и присвоим им стабильные уникальные id вручную —
    // эти id нужны для якорей оглавления (target-counter по attr(data-href)).
    const headings = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'heading_open') {
        const level = parseInt(t.tag.slice(1), 10);
        const inline = tokens[i + 1];
        const text = inline && inline.type === 'inline' ? inline.content : '';
        // присвоим id
        const id = `ch-${tocCounter++}`;
        t.attrSet('id', id);
        headings.push({ level, text, id });
      }
    }

    const body = md.renderer.render(tokens, md.options, env);

    // Класс страницы для обложечного @page не нужен здесь — это контентные главы.
    chaptersHtml.push(`<section class="chapter">\n${body}\n</section>`);

    // В оглавление: H1 всех глав + H2 верхнего уровня.
    for (const h of headings) {
      if (h.level === 1) toc.push({ level: 1, title: h.text, id: h.id });
      else if (h.level === 2) toc.push({ level: 2, title: h.text, id: h.id });
    }
  }

  return { chaptersHtml, toc };
}

// ---------------------------------------------------------------------------
// Сборка финального HTML
// ---------------------------------------------------------------------------
function buildHtml() {
  const mermaidJs = fs.readFileSync(
    resolveModuleFile('mermaid/dist/mermaid.js'),
    'utf8'
  );
  const pagedJs = fs.readFileSync(
    resolveModuleFile('pagedjs/dist/paged.polyfill.js'),
    'utf8'
  );
  const hljsCss = fs.readFileSync(
    resolveModuleFile('highlight.js/styles/github.css'),
    'utf8'
  );

  const coverMd = buildCover();
  const coverHtml = md.render(coverMd);

  // renderChapters() заполняет mermaidHashes (через fence) — читаем кэш ПОСЛЕ.
  const { chaptersHtml, toc } = renderChapters();

  // --- Картинка-обложка: самая первая страница (полностраничный file://) ---
  const hasCoverImage = fs.existsSync(COVER_IMAGE);
  const coverImageSection = hasCoverImage
    ? `
<!-- ОБЛОЖКА-КАРТИНКА (первая страница) -->
<section class="cover-image">
<img src="${toFileUrl(COVER_IMAGE)}" alt="Обложка">
</section>`
    : '';
  if (!hasCoverImage) {
    console.log('Картинка-обложка не найдена (пропущена):', COVER_IMAGE);
  }

  // --- Страница автора из author.md (если файл существует) ---
  let authorSection = '';
  if (fs.existsSync(AUTHOR_MD)) {
    const authorHtml = md.render(fs.readFileSync(AUTHOR_MD, 'utf8'));
    authorSection = `
<!-- СТРАНИЦА АВТОРА (из author.md, не в git) -->
<section class="author-page">
${authorHtml}
</section>`;
    console.log('Страница автора добавлена из', AUTHOR_MD);
  } else {
    console.log('author.md не найден — страница автора пропущена.');
  }

  // --- Предзагрузка кэша mermaid: {hash: "<svg>"} для уже отрендеренных ---
  const mermaidCache = loadMermaidCache(mermaidHashes);
  const cachedCount = Object.keys(mermaidCache).length;
  console.log(
    `mermaid: всего диаграмм ${mermaidHashes.size}, в кэше ${cachedCount}, ` +
      `будет отрендерено ${mermaidHashes.size - cachedCount}.`
  );
  const mermaidCacheJson = JSON.stringify(mermaidCache);

  // Оглавление: H1 — пункт верхнего уровня, H2 — вложенный.
  // Структура пункта (flex): [.t заголовок] [.dots пунктир] [.pg номер страницы].
  // Номер страницы даёт Paged.js через target-counter(attr(data-href), page).
  // leader() в Paged.js не поддерживается — пунктир рисуем dotted-border у .dots.
  const tocItems = toc
    .map((t) => {
      const cls = t.level === 1 ? 'toc-h1' : 'toc-h2';
      const title = escapeHtml(plainTitle(t.title));
      return (
        `<li class="${cls}">` +
        `<span class="t"><a href="#${t.id}">${title}</a></span>` +
        `<span class="dots"></span>` +
        `<span class="pg" data-href="#${t.id}"></span>` +
        `</li>`
      );
    })
    .join('\n');

  const css = buildCss(hljsCss);

  const browserScript = buildBrowserScript();

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>От .NET к Go</title>
<style>
${css}
</style>
</head>
<body>
${coverImageSection}

<!-- ТИТУЛЬНАЯ СТРАНИЦА (текст) -->
<section class="cover">
${coverHtml}
<div class="cover-meta">Путеводитель для C#-разработчика</div>
</section>
${authorSection}

<!-- ОГЛАВЛЕНИЕ -->
<section class="toc-page">
<h1 class="toc-title">Оглавление</h1>
<ul class="toc">
${tocItems}
</ul>
</section>

<!-- ГЛАВЫ -->
${chaptersHtml.join('\n\n')}

<!-- Библиотеки (инлайн, без CDN/file://) -->
<script>window.PagedConfig = { auto: false };</script>
<script>window.__mermaidCache = ${mermaidCacheJson};</script>
<script>
${mermaidJs}
</script>
<script>
${pagedJs}
</script>
<script>
${browserScript}
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Превращает inline-markdown заголовка в чистый текст для оглавления:
// убираем `code`-бэктики, **bold**/*italic*, ссылки [текст](url) → текст.
function plainTitle(s) {
  return String(s)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

// ---------------------------------------------------------------------------
// CSS — книжная вёрстка через Paged.js / @page
// ---------------------------------------------------------------------------
function buildCss(hljsCss) {
  return `
/* ====== highlight.js github theme (inline) ====== */
${hljsCss}

/* ====== @page: A4, поля, колонтитулы ====== */
@page {
  size: A4;
  margin: 20mm 18mm 20mm 18mm;
  @top-center {
    content: string(chaptertitle);
    font-size: 9pt;
    color: #666;
    vertical-align: bottom;
    padding-bottom: 4mm;
  }
  @bottom-center {
    content: counter(page);
    font-size: 9pt;
    color: #666;
    vertical-align: top;
    padding-top: 4mm;
  }
}

/* Картинка-обложка — самая первая страница: без полей и колонтитулов,
   полностраничная картинка целиком (object-fit: contain), тёмный индиго-фон
   работает рамкой по бокам. */
.cover-image {
  page: coverimg;
  break-after: page;
  break-inside: avoid;
  margin: 0;
  padding: 0;
  width: 210mm;
  height: 297mm;
  background: #1e1b4b;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.cover-image img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  max-width: 100%;
}
@page coverimg {
  size: A4;
  margin: 0;
  background: #1e1b4b;
  @top-center { content: none; }
  @bottom-center { content: none; }
  @top-left { content: none; }
  @top-right { content: none; }
  @bottom-left { content: none; }
  @bottom-right { content: none; }
}

/* Текстовая титульная страница — без колонтитулов, своя именованная страница */
.cover { page: cover; }
@page cover {
  @top-center { content: none; }
  @bottom-center { content: none; }
}

/* Страница автора (из author.md) — без бегущего колонтитула */
.author-page { page: authorpg; }
@page authorpg {
  @top-center { content: none; }
  @bottom-center { content: none; }
}

/* Страница оглавления — без верхнего колонтитула главы */
.toc-page { page: toc; }
@page toc {
  @top-center { content: "Оглавление"; font-size: 9pt; color:#666; }
}

/* ====== Базовая типографика ====== */
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: 10.5pt;
  line-height: 1.5;
  color: #1a1a1a;
  margin: 0;
  padding: 0;
  hyphens: none;
}

/* Сироты/вдовы: не оставляем 1-2 висячие строки абзаца у границы страницы. */
p, li { orphans: 3; widows: 3; }
p { margin: 0.5em 0; }

/* Заголовки держим со следующим контентом (не отрываем заголовок от текста). */
h1, h2, h3, h4 {
  font-weight: 700;
  line-height: 1.25;
  color: #0b1f3a;
  break-after: avoid;
}
h1 { font-size: 20pt; margin: 0 0 0.5em; }
h2 { font-size: 15pt; margin: 1.2em 0 0.4em; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.2em; }
h3 { font-size: 12.5pt; margin: 1em 0 0.3em; }
h4 { font-size: 11pt; margin: 0.9em 0 0.3em; }

a { color: #1d4ed8; text-decoration: none; }

/* Каждая глава — с новой страницы; H1 → бегущий колонтитул */
.chapter { break-before: page; }
.chapter h1 { string-set: chaptertitle content(text); }

/* ====== Код ====== */
pre, code {
  font-family: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
}
code {
  font-size: 0.88em;
  background: #f3f4f6;
  padding: 0.1em 0.35em;
  border-radius: 3px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
pre {
  background: #f6f8fa;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 8.6pt;
  line-height: 1.42;
  overflow: visible;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  /* Блоки кода могут быть выше страницы — разрешаем разрыв, чтобы не было
     больших пустот перед длинным кодом и чтобы он не выпадал за поля. */
  break-inside: auto;
  margin: 0.7em 0;
}
pre code {
  background: none;
  padding: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: inherit;
}

/* ====== Цитаты / врезки ====== */
blockquote {
  margin: 0.8em 0;
  padding: 0.4em 1em;
  border-left: 4px solid #93c5fd;
  background: #eff6ff;
  color: #1e3a5f;
  break-inside: avoid;
}
blockquote p { margin: 0.3em 0; }

/* ====== Списки ====== */
ul, ol { margin: 0.5em 0; padding-left: 1.5em; }
li { margin: 0.2em 0; }

/* ====== Таблицы ====== */
/* Таблицы могут быть длиннее страницы — разрешаем разрыв по строкам,
   а заголовок (thead) повторяем на каждой новой странице. */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 8.6pt;
  margin: 0.8em 0;
  break-inside: auto;
  table-layout: fixed;
}
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td {
  border: 1px solid #d1d5db;
  padding: 4px 6px;
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
  word-break: break-word;
}
th { background: #f1f5f9; font-weight: 700; }
tr:nth-child(even) td { background: #fafafa; }

/* ====== Mermaid SVG ====== */
/* Контейнер диаграммы: не рвём (гарантированно влезает за счёт max-height),
   ограничиваем высоту, чтобы высокие диаграммы ужимались под страницу,
   а не выпадали за поля и не обрезались. */
figure.diagram {
  margin: 1em 0;
  padding: 0;
  text-align: center;
  break-inside: avoid;
}
pre.mermaid {
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  text-align: center;
}
figure.diagram svg,
.mermaid svg {
  max-width: 100% !important;
  height: auto !important;
  /* Печатная область A4 при полях 20мм по вертикали ≈ 257мм; берём с запасом
     под бегущие колонтитулы, чтобы диаграмма помещалась на одной странице. */
  max-height: 215mm;
}

img { max-width: 100%; height: auto; }

hr { border: none; border-top: 1px solid #e2e8f0; margin: 1.2em 0; }

/* ====== Обложка ====== */
.cover {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 247mm; /* высота печатной области A4 при полях 20мм */
  text-align: center;
  break-after: page;
}
.cover h1 {
  font-size: 30pt;
  line-height: 1.15;
  color: #0b1f3a;
  margin-bottom: 0.6em;
  string-set: none;
}
.cover p {
  font-size: 12pt;
  color: #374151;
  max-width: 150mm;
  margin: 0.6em auto;
  text-align: left;
}
.cover-meta {
  margin-top: 2.5em;
  font-size: 13pt;
  color: #2563eb;
  font-weight: 600;
  letter-spacing: 0.5px;
}

/* ====== Оглавление ====== */
.toc-page { break-before: page; break-after: page; }
.toc-title { font-size: 22pt; margin-bottom: 0.8em; }
.toc { list-style: none; padding: 0; margin: 0; }
.toc li {
  display: flex;
  align-items: baseline;
  margin: 0.16em 0;
  break-inside: avoid;
}
.toc li .t {
  flex: 0 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toc li .t a { color: #1a1a1a; }
.toc li .dots {
  flex: 1 1 auto;
  border-bottom: 1px dotted #b8b8b8;
  margin: 0 5px;
  transform: translateY(-3px);
  min-width: 1em;
}
.toc li .pg { flex: 0 0 auto; white-space: nowrap; color: #555; font-size: 9.5pt; }
/* Номер страницы цели (Paged.js поддерживает target-counter) */
.toc li .pg::after { content: target-counter(attr(data-href), page); }

.toc-h1 { margin-top: 0.7em; }
.toc-h1 .t a { font-weight: 700; font-size: 11pt; color: #0b1f3a; }
.toc-h2 .t { padding-left: 1.4em; }
.toc-h2 .t a { font-weight: 400; font-size: 9.6pt; color: #374151; }
.toc-h2 .pg { font-size: 9pt; }
`;
}

// ---------------------------------------------------------------------------
// Скрипт, исполняемый в браузере: mermaid → Paged.js → __pdfReady
// ---------------------------------------------------------------------------
function buildBrowserScript() {
  return `
(async function () {
  function log(msg) {
    try { console.log('[build-pdf] ' + msg); } catch (e) {}
  }
  var __t0 = (performance && performance.now) ? performance.now() : Date.now();
  function ms(since) {
    var now = (performance && performance.now) ? performance.now() : Date.now();
    return Math.round(now - since);
  }

  // 1) Mermaid — сначала. Рендерим ПОНОДНО, чтобы одна сбойная диаграмма
  //    не прерывала остальные (mermaid.run на массиве бросает на первой ошибке).
  //    Перед рендером проверяем кэш: если для хеша диаграммы есть готовый SVG,
  //    вставляем его напрямую и НЕ запускаем mermaid (резко ускоряет повтор).
  var okCount = 0,
    errCount = 0,
    cacheCount = 0,
    renderCount = 0;
  var cache = window.__mermaidCache || {};
  var fresh = {}; // {hash: outerHTML-нового-SVG} — Node сохранит в .cache
  try {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('pre.mermaid'));
    log('mermaid nodes found: ' + nodes.length);

    // Сначала разложим кэш — до initialize, чтобы не платить за рендер.
    var toRender = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var h = node.getAttribute('data-mhash');
      if (h && cache[h] && cache[h].indexOf('<svg') !== -1) {
        node.innerHTML = cache[h];
        node.setAttribute('data-processed', 'true');
        cacheCount++;
        okCount++;
      } else {
        toRender.push(node);
      }
    }
    log('mermaid from cache: ' + cacheCount + ', to render: ' + toRender.length);

    if (toRender.length > 0) {
      if (typeof mermaid === 'undefined') {
        log('ERROR: mermaid global is undefined');
      } else {
        mermaid.initialize({
          startOnLoad: false,
          theme: 'neutral',
          securityLevel: 'loose',
          flowchart: { htmlLabels: true, useMaxWidth: true },
          themeVariables: { fontSize: '14px' },
        });
        for (var j = 0; j < toRender.length; j++) {
          var n2 = toRender[j];
          var h2 = n2.getAttribute('data-mhash');
          try {
            await mermaid.run({ nodes: [n2] });
            var svg = n2.querySelector('svg');
            if (svg && svg.getAttribute('aria-roledescription') === 'error') {
              errCount++;
              log('mermaid ERROR-SVG at #' + j);
            } else {
              okCount++;
              renderCount++;
              if (h2 && svg) fresh[h2] = svg.outerHTML; // в кэш
            }
          } catch (e2) {
            errCount++;
            log('mermaid throw at #' + j + ': ' + (e2 && e2.message ? e2.message.split('\\n')[0] : e2));
          }
        }
      }
    }
    log('mermaid OK: ' + okCount + ' (cache ' + cacheCount + ', rendered ' + renderCount + '), errors: ' + errCount + ' [' + ms(__t0) + ' ms]');
  } catch (e) {
    log('mermaid fatal: ' + (e && e.message ? e.message : e));
  }
  var __tPaged = (performance && performance.now) ? performance.now() : Date.now();
  window.__mermaidOk = okCount;
  window.__mermaidErr = errCount;
  window.__mermaidCached = cacheCount;
  window.__mermaidRendered = renderCount;
  window.__freshMermaid = fresh;

  // 2) Paged.js — только после mermaid.
  try {
    var totalSvg = document.querySelectorAll('svg').length;
    log('total SVG before paging: ' + totalSvg);
    window.__svgCount = totalSvg;

    if (window.PagedPolyfill && typeof window.PagedPolyfill.preview === 'function') {
      await window.PagedPolyfill.preview();
      var pages = document.querySelectorAll('.pagedjs_page').length;
      log('Paged.js pages: ' + pages + ' [' + ms(__tPaged) + ' ms]');
      window.__pageCount = pages;
      window.__pagedOk = true;
    } else {
      log('ERROR: PagedPolyfill not available');
      window.__pagedOk = false;
    }
  } catch (e) {
    log('Paged.js error: ' + (e && e.message ? e.message : e));
    window.__pagedOk = false;
  }

  window.__pdfReady = true;
})();
`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  console.log('REPO_ROOT =', REPO_ROOT);
  console.log('Сборка HTML...');
  const html = buildHtml();
  fs.writeFileSync(HTML_OUT, html, 'utf8');
  console.log('HTML записан:', HTML_OUT, '(', (html.length / 1024 / 1024).toFixed(2), 'MB )');

  console.log('Запуск Chrome...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-web-security'],
  });

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.startsWith('[build-pdf]')) console.log('  browser:', t);
    });
    page.on('pageerror', (err) => console.log('  PAGEERROR:', err.message));

    const fileUrl = 'file://' + HTML_OUT;
    console.log('Открытие', fileUrl);
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 120000 });

    console.log('Ожидание рендера (mermaid + Paged.js)...');
    await page.waitForFunction('window.__pdfReady === true', { timeout: 300000 });

    const stats = await page.evaluate(() => ({
      svg: window.__svgCount || document.querySelectorAll('svg').length,
      pages: window.__pageCount || document.querySelectorAll('.pagedjs_page').length,
      pagedOk: window.__pagedOk === true,
      mermaidOk: window.__mermaidOk || 0,
      mermaidErr: window.__mermaidErr || 0,
      mermaidCached: window.__mermaidCached || 0,
      mermaidRendered: window.__mermaidRendered || 0,
    }));
    console.log('Mermaid: OK =', stats.mermaidOk, ', ошибок =', stats.mermaidErr);
    console.log(
      'Mermaid: из кэша =', stats.mermaidCached, ', отрендерено =', stats.mermaidRendered
    );
    console.log('SVG отрендерено:', stats.svg);
    console.log('Страниц (Paged.js):', stats.pages);
    console.log('Paged.js OK:', stats.pagedOk);

    // Сохраняем свежеотрендеренные диаграммы в кэш (для ускорения следующих сборок).
    try {
      const fresh = await page.evaluate(() => window.__freshMermaid || {});
      const written = saveMermaidCache(fresh);
      if (written > 0) console.log('Кэш mermaid: записано', written, 'новых SVG в', MERMAID_CACHE_DIR);
    } catch (e) {
      console.log('Не удалось сохранить кэш mermaid:', e && e.message ? e.message : e);
    }

    const usePagedMode = stats.pagedOk && stats.pages > 0;

    if (usePagedMode) {
      console.log('Режим: Paged.js (бегущие колонтитулы).');
      await page.pdf({
        path: OUT_PDF,
        printBackground: true,
        preferCSSPageSize: true,
      });
    } else {
      console.log('Режим: ФОЛБЭК — нативный Puppeteer (статичный заголовок).');
      await page.pdf({
        path: OUT_PDF,
        printBackground: true,
        format: 'A4',
        margin: { top: '18mm', bottom: '18mm', left: '18mm', right: '18mm' },
        displayHeaderFooter: true,
        headerTemplate:
          '<div style="font-size:9px;width:100%;text-align:center;color:#666">От .NET к Go</div>',
        footerTemplate:
          '<div style="font-size:9px;width:100%;text-align:center;color:#666"><span class="pageNumber"></span></div>',
      });
    }

    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    let sizeMb = 0;
    try {
      sizeMb = +(fs.statSync(OUT_PDF).size / 1024 / 1024).toFixed(2);
    } catch (_) {}

    // Сохраним режим/статистику для отчёта в .cache/ (gitignored, не засоряет дерево).
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(CACHE_DIR, 'build-stats.json'),
      JSON.stringify(
        {
          ...stats,
          mode: usePagedMode ? 'pagedjs' : 'fallback',
          sizeMb,
          elapsedSec: +elapsedSec,
        },
        null,
        2
      )
    );

    console.log('PDF записан:', OUT_PDF, '(', sizeMb, 'MB )');
    console.log('Время сборки:', elapsedSec, 'сек.');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
