import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Blocks,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  Download,
  FileArchive,
  FolderOpen,
  History,
  Languages,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Minus,
  PackageOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  ScrollText,
  Trash2,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";
import {
  buildJapaneseResourcePack,
  mergeParsedModpacks,
  removeModFromParsedModpack,
  type JapaneseTranslations,
  type ParsedMod,
  type ParsedModpack,
} from "./lib/modArchive";
import { parseArchiveInWorker, parseJarFilesInWorker } from "./lib/archiveClient";
import {
  GEMMA_MODELS,
  GemmaTranslator,
  formatDebugValue,
  supportsWebGpu,
  type GemmaModel,
} from "./lib/gemmaTranslator";
import {
  LFM_MODEL,
  LfmTranslator,
  getRecommendedLfmBatchSize,
  type LfmModel,
} from "./lib/lfmTranslator";
import { categoryFromKey } from "./lib/placeholders";
import { TranslationTaskController } from "./lib/translationTask";

type View = "workspace" | "glossary";

interface TranslationProgress {
  label: string;
  current: number;
  total: number;
}

type TranslationState = "idle" | "running" | "paused" | "stopping";

type TranslationStatus = "untranslated" | "ai" | "manual" | "builtin";
type TranslationOrigin = Extract<TranslationStatus, "ai" | "manual">;
type TranslationOrigins = Record<string, Record<string, TranslationOrigin>>;

const TRANSLATION_STATUS_LABELS: Record<TranslationStatus, string> = {
  untranslated: "未翻訳",
  ai: "AI翻訳済み",
  manual: "手動修正",
  builtin: "ビルトイン",
};

type DetailLogLevel = "info" | "success" | "warning" | "error";

interface DetailLogEntry {
  id: number;
  timestamp: string;
  level: DetailLogLevel;
  message: string;
}

const DETAIL_LOG_LABELS: Record<DetailLogLevel, string> = {
  info: "情報",
  success: "完了",
  warning: "警告",
  error: "エラー",
};

function logTimestamp(): string {
  return new Date().toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function initialDetailLogs(parsed: ParsedModpack, fileName: string): Omit<DetailLogEntry, "id">[] {
  const timestamp = logTimestamp();
  const logs: Omit<DetailLogEntry, "id">[] = [{
    timestamp,
    level: "success",
    message: `${fileName} の解析が完了しました（MOD ${parsed.mods.length}件、namespace ${Object.keys(parsed.namespaces).length}件）。`,
  }];

  for (const mod of parsed.mods) {
    const name = mod.metadata.name ?? mod.metadata.modId ?? mod.jarName;
    const version = mod.metadata.version ? ` v${mod.metadata.version}` : "";
    logs.push({
      timestamp,
      level: "info",
      message: `${mod.jarPath} — ${name}${version} / ${mod.metadata.loader} / namespace: ${mod.namespaces.join(", ") || "なし"}`,
    });
  }

  for (const source of parsed.sources) {
    logs.push({
      timestamp,
      level: "info",
      message: `${source.jarPath}!/${source.englishPath ?? "英語ファイルなし"} — ${source.namespace}: 英語 ${Object.keys(source.entries).length}件、既存日本語 ${Object.keys(source.existingJapanese).length}件`,
    });
  }

  for (const warning of parsed.warnings) {
    logs.push({
      timestamp,
      level: "warning",
      message: `[${warning.code}] ${warning.path ? `${warning.path} — ` : ""}${warning.message}`,
    });
  }

  return logs;
}

const DEFAULT_GLOSSARY: Record<string, string> = {
  Copper: "銅",
  Tin: "錫",
  Lead: "鉛",
  Ingot: "インゴット",
  Nugget: "塊",
  Wrench: "レンチ",
  Energy: "エネルギー",
  Fluid: "流体",
  Tank: "タンク",
};

type TranslationModel = GemmaModel | LfmModel;

const LFM_MODEL_ID: LfmModel = "lfm2_5_1_2b_jp";
const TRANSLATION_MODELS = { [LFM_MODEL_ID]: LFM_MODEL, ...GEMMA_MODELS };
const MINECRAFT_VERSION_OPTIONS = [
  { label: "Java 26.1", packFormat: 84 },
  { label: "Java 1.21.11", packFormat: 75 },
  { label: "Java 1.21.9–1.21.10", packFormat: 69 },
  { label: "Java 1.21.7–1.21.8", packFormat: 64 },
  { label: "Java 1.21.6", packFormat: 63 },
  { label: "Java 1.21.5", packFormat: 55 },
  { label: "Java 1.21.4", packFormat: 46 },
  { label: "Java 1.21.2–1.21.3", packFormat: 42 },
  { label: "Java 1.21–1.21.1", packFormat: 34 },
  { label: "Java 1.20.5–1.20.6", packFormat: 32 },
  { label: "Java 1.20.3–1.20.4", packFormat: 22 },
  { label: "Java 1.20.2", packFormat: 18 },
  { label: "Java 1.20–1.20.1", packFormat: 15 },
] as const;
const gemmaTranslator = new GemmaTranslator();
const lfmTranslator = new LfmTranslator();

function isLfmModel(model: TranslationModel): model is LfmModel {
  return model === LFM_MODEL_ID;
}

function readGlossary(): Record<string, string> {
  try {
    const saved = localStorage.getItem("craftlingo-glossary");
    return saved ? (JSON.parse(saved) as Record<string, string>) : DEFAULT_GLOSSARY;
  } catch {
    return DEFAULT_GLOSSARY;
  }
}

function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes.slice().buffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function defaultResourcePackName(fileName: string): string {
  const baseName = fileName.replace(/\.(zip|jar)$/i, "").trim() || "modpack";
  return `${baseName}-ja_jp`;
}

function safeFileNamePart(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\.+$/g, "")
    .trim();
  return sanitized || fallback;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((value, index) => bytes[index] === value);
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function downloadProgressLabel(label: string, loaded: number, total: number): string {
  const loadedMb = (loaded / 1_000_000).toFixed(0);
  if (total <= 0) return `${label} をダウンロードしています（${loadedMb} MB）`;
  if (loaded >= total) return `${label} をメモリに読み込んでいます`;
  const percent = Math.min(100, Math.round(loaded / total * 100));
  return `${label} をダウンロードしています（${percent}% / ${loadedMb} MB）`;
}

function useModIconUrls(mods: readonly ParsedMod[]): Map<string, string> {
  const [iconUrls, setIconUrls] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    const next = new Map<string, string>();
    const createdUrls: string[] = [];
    for (const mod of mods) {
      if (!mod.icon) continue;
      try {
        const blob = new Blob([mod.icon.bytes.slice().buffer], { type: mod.icon.mimeType });
        const url = URL.createObjectURL(blob);
        next.set(mod.jarPath, url);
        createdUrls.push(url);
      } catch {
        // Keep the placeholder when this browser cannot create an image URL.
      }
    }
    setIconUrls(next);
    return () => {
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [mods]);
  return iconUrls;
}

interface ExtractedIconProps {
  alt: string;
  className: string;
  fallback: ReactNode;
  iconUrl?: string;
}

function ExtractedIcon({ alt, className, fallback, iconUrl }: ExtractedIconProps) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const showImage = Boolean(iconUrl && failedUrl !== iconUrl);

  return (
    <span className={`${className} ${showImage ? "has-image" : ""}`}>
      {showImage ? (
        <img src={iconUrl} alt={alt} onError={() => setFailedUrl(iconUrl)} />
      ) : (
        fallback
      )}
    </span>
  );
}

interface SidebarProps {
  open: boolean;
  view: View;
  onClose: () => void;
  onView: (view: View) => void;
}

function Sidebar({ open, view, onClose, onView }: SidebarProps) {
  const selectView = (nextView: View) => {
    onView(nextView);
    onClose();
  };

  return (
    <>
      <button
        className={`sidebar-backdrop ${open ? "open" : ""}`}
        aria-label="メニューを閉じる"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
      />
      <aside id="main-sidebar" className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-head">
          <div className="brand">
            <div className="brand-mark"><Blocks size={21} strokeWidth={2.5} /></div>
            <div className="brand-copy">
              <div className="brand-name">CraftLingo</div>
              <div className="brand-caption">MOD TRANSLATOR</div>
            </div>
          </div>
          <button className="sidebar-close" aria-label="メニューを閉じる" onClick={onClose}>
            <X size={19} />
          </button>
        </div>

        <div className="sidebar-label">メニュー</div>
        <nav className="sidebar-nav" aria-label="メインメニュー">
          <button
            className={`nav-item ${view === "workspace" ? "active" : ""}`}
            onClick={() => selectView("workspace")}
          >
            <Languages size={17} /><span>翻訳ワークスペース</span>
          </button>
          <button
            className={`nav-item ${view === "glossary" ? "active" : ""}`}
            onClick={() => selectView("glossary")}
          >
            <BookOpen size={17} /><span>共通用語集</span>
          </button>
          <button className="nav-item" disabled title="今後のアップデートで追加予定">
            <History size={17} /><span>翻訳履歴</span>
          </button>
        </nav>

        <div className="sidebar-spacer" />
        <div className="privacy-card">
          <div className="privacy-title">
            <LockKeyhole size={14} /><span>プライバシー保護</span>
          </div>
          <p>MODファイルと翻訳内容はブラウザ内で処理され、外部サーバーへ送信されません。</p>
        </div>
      </aside>
    </>
  );
}

function Topbar({ menuOpen, onMenuOpen, title }: { menuOpen: boolean; onMenuOpen: () => void; title: string }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="mobile-menu-button"
          aria-label="メニューを開く"
          aria-controls="main-sidebar"
          aria-expanded={menuOpen}
          onClick={onMenuOpen}
        >
          <Menu size={20} />
        </button>
        <p className="topbar-title">{title}</p>
      </div>
      <span className="local-badge"><span className="local-dot" />100% ローカル処理</span>
    </header>
  );
}

interface LandingProps {
  busy: boolean;
  error?: string;
  onInput: (input: ArchiveInputSelection) => void;
}

export interface LocalInputFile {
  file: File;
  path: string;
}

export interface ArchiveInputSelection {
  files: LocalInputFile[];
  label: string;
  source: "files" | "folder";
}

function selectionFromFileList(
  files: FileList | null,
  source: ArchiveInputSelection["source"],
): ArchiveInputSelection | undefined {
  const selected = Array.from(files ?? [], (file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
  if (selected.length === 0) return undefined;
  const root = selected[0].path.replace(/\\/g, "/").split("/")[0];
  return {
    files: selected,
    label: source === "folder"
      ? root
      : selected.length === 1 ? selected[0].file.name : `${selected.length}件のJAR`,
    source,
  };
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectory(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function collectEntryFiles(entry: FileSystemEntry): Promise<LocalInputFile[]> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    return [{ file, path: entry.fullPath.replace(/^\/+/, "") || file.name }];
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // Chromium returns directory entries in batches, so keep reading to the
  // empty batch instead of assuming the first callback contains everything.
  while (true) {
    const batch = await readDirectory(reader);
    if (batch.length === 0) break;
    children.push(...batch);
  }
  const nested = await Promise.all(children.map(collectEntryFiles));
  return nested.flat();
}

export async function selectionFromDrop(dataTransfer: DataTransfer): Promise<ArchiveInputSelection | undefined> {
  const entries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return selectionFromFileList(dataTransfer.files, "files");

  const source = entries.some((entry) => entry.isDirectory) ? "folder" : "files";
  const files = (await Promise.all(entries.map(collectEntryFiles))).flat();
  const label = source === "folder"
    ? entries.length === 1 ? entries[0].name : `${entries.length}件のフォルダー`
    : files.length === 1 ? files[0].file.name : `${files.length}件のJAR`;
  return { files, label, source };
}

export async function parseInputSelection(input: ArchiveInputSelection): Promise<ParsedModpack> {
  const jarFiles = input.files.filter(({ path }) => path.toLowerCase().endsWith(".jar"));
  const zipFiles = input.files.filter(({ path }) => path.toLowerCase().endsWith(".zip"));
  let result: ParsedModpack;

  if (input.source === "folder") {
    if (jarFiles.length === 0) {
      throw new Error("フォルダー内にMOD JARが見つかりませんでした。");
    }
    result = await parseJarFilesInWorker(await Promise.all(jarFiles.map(async ({ file, path }) => ({
      path,
      bytes: await file.arrayBuffer(),
    }))));
  } else if (input.files.length === 1 && zipFiles.length === 1) {
    result = await parseArchiveInWorker(await zipFiles[0].file.arrayBuffer());
  } else if (input.files.length > 0 && jarFiles.length === input.files.length) {
    result = await parseJarFilesInWorker(await Promise.all(jarFiles.map(async ({ file, path }) => ({
      path,
      bytes: await file.arrayBuffer(),
    }))));
  } else {
    throw new Error("ZIPファイル1件、JARファイル、またはJARを含むフォルダーを選択してください。");
  }

  if (result.warnings.some((warning) => warning.code === "INVALID_OUTER_ZIP")) {
    throw new Error("ZIPファイルを読み込めませんでした。破損していないか確認してください。");
  }
  if (result.mods.length === 0) {
    if (jarFiles.length > 0) {
      throw new Error("JARファイルを読み込めませんでした。破損していないか確認してください。");
    }
    throw new Error("ZIPの中にMOD JARが見つかりませんでした。");
  }
  if (Object.keys(result.namespaces).length === 0) {
    throw new Error("JARの中に英語・日本語の言語ファイルが見つかりませんでした。");
  }
  return result;
}

/** Keep translations for surviving keys and initialize newly bundled Japanese values. */
export function reconcileTranslations(
  parsed: ParsedModpack,
  current: JapaneseTranslations,
): JapaneseTranslations {
  const next: JapaneseTranslations = {};
  for (const [namespace, data] of Object.entries(parsed.namespaces)) {
    const values: Record<string, string> = {};
    const keys = new Set([
      ...Object.keys(data.entries),
      ...Object.keys(data.existingJapanese),
    ]);
    for (const key of keys) {
      if (Object.hasOwn(current[namespace] ?? {}, key)) {
        values[key] = current[namespace][key];
      } else if (Object.hasOwn(data.existingJapanese, key)) {
        values[key] = data.existingJapanese[key];
      }
    }
    next[namespace] = values;
  }
  return next;
}

interface ModalProps {
  children: ReactNode;
  descriptionId?: string;
  id: string;
  locked?: boolean;
  onClose: () => void;
  title: string;
}

function Modal({ children, descriptionId, id, locked = false, onClose, title }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const lockedRef = useRef(locked);
  onCloseRef.current = onClose;
  lockedRef.current = locked;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !lockedRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
      } else if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <button
            className="modal-close"
            aria-label={`${title}を閉じる`}
            disabled={locked}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface ArchiveInputPickerProps {
  busy: boolean;
  compact?: boolean;
  onInput: (input: ArchiveInputSelection) => void;
}

function ArchiveInputPicker({ busy, compact = false, onInput }: ArchiveInputPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const inputBusy = busy || collecting;

  return (
    <div
      className={`dropzone ${compact ? "compact" : ""} ${dragging ? "dragging" : ""} ${inputBusy ? "busy" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
      onDrop={async (event) => {
        event.preventDefault();
        setDragging(false);
        if (inputBusy) return;
        setCollecting(true);
        try {
          const selection = await selectionFromDrop(event.dataTransfer);
          if (selection) onInput(selection);
        } finally {
          setCollecting(false);
        }
      }}
    >
      <div className="upload-icon">
        {inputBusy ? <LoaderCircle className="spin" size={29} /> : <UploadCloud size={29} />}
      </div>
      <h2>{inputBusy ? "MODを解析しています…" : "ZIP・JAR・フォルダーをドロップ"}</h2>
      <p>MODパックの ZIP、単体 JAR、JAR を含むフォルダーに対応<br />フォルダー内はサブフォルダーまで再帰的に探します</p>
      <div className="upload-actions">
        <button className="primary-button" disabled={inputBusy} onClick={() => fileInputRef.current?.click()}>
          <FileArchive size={15} />ZIP / JARを選択
        </button>
        <button className="secondary-button" disabled={inputBusy} onClick={() => folderInputRef.current?.click()}>
          <FolderOpen size={15} />フォルダーを選択
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,.jar,application/zip,application/java-archive"
        multiple
        hidden
        onChange={(event) => {
          const selection = selectionFromFileList(event.target.files, "files");
          if (selection) onInput(selection);
          event.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(event) => {
          const selection = selectionFromFileList(event.target.files, "folder");
          if (selection) onInput(selection);
          event.target.value = "";
        }}
      />
      <div className="file-hint">処理できるサイズは端末の空きメモリに依存します</div>
    </div>
  );
}

function Landing({ busy, error, onInput }: LandingProps) {
  return (
    <main className="content">
      <section className="hero">
        <div>
          <p className="eyebrow"><Sparkles size={14} /> AI POWERED LOCALIZATION</p>
          <h1>MODパックを、<br /><span>日本語で遊ぼう。</span></h1>
          <p className="hero-copy">
            複数のMinecraft MODをまとめてアップロード。ローカルAIが自然な日本語へ翻訳し、すぐに使えるリソースパックを作ります。
          </p>
          <div className="feature-row">
            <div className="feature"><ShieldCheck size={15} />ファイルは端末の外に出ません</div>
            <div className="feature"><Zap size={15} />既存の日本語訳を自動で維持</div>
          </div>
        </div>

        <div className="upload-panel">
          <ArchiveInputPicker busy={busy} onInput={onInput} />
          {error && <div className="error-banner"><AlertTriangle size={16} />{error}</div>}
        </div>
      </section>

      <section className="process-section">
        <p className="section-kicker">かんたん 3 ステップ</p>
        <div className="process-grid">
          <article className="process-card">
            <span className="step-number">01</span>
            <h3>まとめて読み込む</h3>
            <p>ZIP・JAR・フォルダー内のすべてのJARから言語ファイルを自動抽出します。</p>
          </article>
          <article className="process-card">
            <span className="step-number">02</span>
            <h3>ローカルAIで翻訳</h3>
            <p>端末に合うローカルAIがカテゴリ単位で訳し、プレースホルダーも検証します。</p>
          </article>
          <article className="process-card">
            <span className="step-number">03</span>
            <h3>すぐに導入</h3>
            <p>全MOD分を1つのリソースパックZIPとして保存します。</p>
          </article>
        </div>
      </section>
    </main>
  );
}

interface GlossaryProps {
  glossary: Record<string, string>;
  onChange: (glossary: Record<string, string>) => void;
  onBack: () => void;
}

function Glossary({ glossary, onChange, onBack }: GlossaryProps) {
  const entries = Object.entries(glossary);
  const update = (oldKey: string, newKey: string, value: string) => {
    const next: Record<string, string> = {};
    for (const [key, translation] of entries) {
      if (key !== oldKey) next[key] = translation;
    }
    if (newKey.trim()) next[newKey.trim()] = value;
    onChange(next);
  };

  return (
    <main className="content glossary-page">
      <div className="workspace-header">
        <div>
          <p className="eyebrow"><BookOpen size={14} /> SHARED GLOSSARY</p>
          <h1>共通用語集</h1>
          <p className="workspace-subtitle">すべてのMODで同じ訳語を使い、表記ゆれを防ぎます。</p>
        </div>
        <button className="secondary-button" onClick={onBack}><ArrowLeft size={14} />ワークスペースへ</button>
      </div>

      <section className="glossary-card">
        <div className="glossary-head">
          <div>
            <h2>英語と日本語の対応</h2>
            <p>{entries.length} 語を保存中。この端末のブラウザ内にだけ保存されます。</p>
          </div>
          <button
            className="primary-button"
            onClick={() => onChange({ ...glossary, [`New term ${entries.length + 1}`]: "" })}
          >
            <Plus size={14} />用語を追加
          </button>
        </div>
        <div className="glossary-table">
          <div className="glossary-row glossary-labels"><span>英語</span><span>日本語</span><span /></div>
          {entries.map(([key, value], index) => (
            <div className="glossary-row" key={index}>
              <input aria-label="英語の用語" value={key} onChange={(event) => update(key, event.target.value, value)} />
              <input aria-label={`${key} の日本語訳`} value={value} onChange={(event) => update(key, key, event.target.value)} />
              <button className="delete-button" aria-label={`${key} を削除`} onClick={() => update(key, "", "")}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

interface WorkspaceProps {
  fileName: string;
  parsed: ParsedModpack;
  translations: JapaneseTranslations;
  onTranslations: (value: JapaneseTranslations) => void;
  translationOrigins?: TranslationOrigins;
  onTranslationOrigins?: (update: (current: TranslationOrigins) => TranslationOrigins) => void;
  onParsed: (value: ParsedModpack) => void;
  glossary: Record<string, string>;
  onReset: () => void;
}

export function Workspace({
  fileName,
  parsed,
  translations,
  onTranslations,
  translationOrigins = {},
  onTranslationOrigins,
  onParsed,
  glossary,
  onReset,
}: WorkspaceProps) {
  const namespaces = useMemo(() => Object.keys(parsed.namespaces).sort(), [parsed.namespaces]);
  const modIconUrls = useModIconUrls(parsed.mods);
  const modsByJarPath = useMemo(
    () => new Map(parsed.mods.map((mod) => [mod.jarPath, mod])),
    [parsed.mods],
  );
  const [selectedNamespace, setSelectedNamespace] = useState(namespaces[0] ?? "");
  const [query, setQuery] = useState("");
  const [model, setModel] = useState<TranslationModel>(() =>
    supportsWebGpu() ? "e2b" : LFM_MODEL_ID
  );
  const [packFormat, setPackFormat] = useState(34);
  const [progress, setProgress] = useState<TranslationProgress>();
  const [translationState, setTranslationState] = useState<TranslationState>("idle");
  const [message, setMessage] = useState<string>();
  const [showDetailLogs, setShowDetailLogs] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string>();
  const [deleteJarPath, setDeleteJarPath] = useState<string>();
  const [resourcePackName, setResourcePackName] = useState(() => defaultResourcePackName(fileName));
  const [resourcePackVersion, setResourcePackVersion] = useState("v1");
  const [resourcePackIcon, setResourcePackIcon] = useState<File>();
  const [includeBuiltinTranslations, setIncludeBuiltinTranslations] = useState(false);
  const [selectedExportJarPaths, setSelectedExportJarPaths] = useState(() =>
    parsed.mods.map((mod) => mod.jarPath)
  );
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const knownExportJarPaths = useRef(new Set(parsed.mods.map((mod) => mod.jarPath)));
  const nextLogId = useRef(0);
  const translationTask = useRef<TranslationTaskController>();
  const exportIconInputRef = useRef<HTMLInputElement>(null);
  const [detailLogs, setDetailLogs] = useState<DetailLogEntry[]>(() =>
    initialDetailLogs(parsed, fileName).map((entry) => ({ ...entry, id: nextLogId.current++ })),
  );
  const webGpu = supportsWebGpu();
  const wasmParallel = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  const validPackFormat = Number.isInteger(packFormat) && packFormat > 0;
  const validExportSettings = Boolean(
    resourcePackName.trim()
    && resourcePackVersion.trim()
    && selectedExportJarPaths.length > 0
    && validPackFormat
  );

  const appendDetailLog = useCallback((level: DetailLogLevel, logMessage: string) => {
    setDetailLogs((current) => [
      ...current,
      { id: nextLogId.current++, timestamp: logTimestamp(), level, message: logMessage },
    ]);
  }, []);

  useEffect(() => {
    if (!parsed.namespaces[selectedNamespace]) {
      setSelectedNamespace(namespaces[0] ?? "");
    }
  }, [namespaces, parsed.namespaces, selectedNamespace]);

  useEffect(() => {
    const knownPaths = knownExportJarPaths.current;
    setSelectedExportJarPaths((current) => {
      const selected = new Set(current);
      return parsed.mods
        .map((mod) => mod.jarPath)
        .filter((jarPath) => selected.has(jarPath) || !knownPaths.has(jarPath));
    });
    knownExportJarPaths.current = new Set(parsed.mods.map((mod) => mod.jarPath));
  }, [parsed.mods]);

  useEffect(() => {
    const handleDiagnostic = (diagnostic: { level: "warning" | "error"; message: string }) => {
      appendDetailLog(diagnostic.level, diagnostic.message);
    };
    gemmaTranslator.setDiagnosticListener(handleDiagnostic);
    lfmTranslator.setDiagnosticListener(handleDiagnostic);

    const handleWindowError = (event: ErrorEvent) => {
      const location = event.filename
        ? `source: ${event.filename}:${event.lineno}:${event.colno}\n`
        : "";
      const error = event.error === undefined || event.error === null
        ? `message: ${event.message}`
        : formatDebugValue(event.error);
      appendDetailLog("error", `[window.error]\n${location}${error}`);
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      appendDetailLog(
        "error",
        `[window.unhandledrejection]\nreason:\n${formatDebugValue(event.reason)}`,
      );
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      gemmaTranslator.setDiagnosticListener(undefined);
      lfmTranslator.setDiagnosticListener(undefined);
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [appendDetailLog]);

  const totalEntries = useMemo(
    () => namespaces.reduce((sum, namespace) => sum + Object.keys(parsed.namespaces[namespace].entries).length, 0),
    [namespaces, parsed.namespaces],
  );
  const translatedEntries = useMemo(
    () => namespaces.reduce((sum, namespace) => {
      const sourceKeys = Object.keys(parsed.namespaces[namespace].entries);
      return sum + sourceKeys.filter((key) => Boolean(translations[namespace]?.[key]?.trim())).length;
    }, 0),
    [namespaces, parsed.namespaces, translations],
  );
  const existingEntries = useMemo(
    () => namespaces.reduce((sum, namespace) => sum + Object.keys(parsed.namespaces[namespace].existingJapanese).length, 0),
    [namespaces, parsed.namespaces],
  );
  const selectedBuiltinEntries = useMemo(() => {
    const selectedPaths = new Set(selectedExportJarPaths);
    const builtinKeys = new Set<string>();
    for (const source of parsed.sources) {
      if (!selectedPaths.has(source.jarPath)) continue;
      for (const key of Object.keys(source.existingJapanese)) {
        builtinKeys.add(`${source.namespace}\u0000${key}`);
      }
    }
    return builtinKeys.size;
  }, [parsed.sources, selectedExportJarPaths]);

  const selected = parsed.namespaces[selectedNamespace];
  const visibleEntries = selected
    ? Object.entries(selected.entries).filter(([key, source]) =>
      `${key} ${source} ${translations[selectedNamespace]?.[key] ?? ""}`.toLowerCase().includes(query.toLowerCase()),
    )
    : [];

  const setTranslation = (namespace: string, key: string, value: string) => {
    onTranslationOrigins?.((current) => ({
      ...current,
      [namespace]: { ...current[namespace], [key]: "manual" },
    }));
    onTranslations({
      ...translations,
      [namespace]: { ...translations[namespace], [key]: value },
    });
  };

  const translationStatus = (namespace: string, key: string): TranslationStatus => {
    const value = translations[namespace]?.[key] ?? "";
    if (!value.trim()) return "untranslated";
    const trackedOrigin = translationOrigins[namespace]?.[key];
    if (trackedOrigin) return trackedOrigin;
    if (
      Object.hasOwn(parsed.namespaces[namespace].existingJapanese, key)
      && value === parsed.namespaces[namespace].existingJapanese[key]
    ) {
      return "builtin";
    }
    return "manual";
  };

  const addMods = async (input: ArchiveInputSelection) => {
    if (translationState !== "idle") return;
    setAddBusy(true);
    setAddError(undefined);
    try {
      const incoming = await parseInputSelection(input);
      const paths = new Set(parsed.mods.map((mod) => mod.jarPath));
      for (const mod of incoming.mods) {
        if (paths.has(mod.jarPath)) {
          throw new Error(`${mod.jarPath} はすでに読み込まれています。`);
        }
        paths.add(mod.jarPath);
      }
      const next = mergeParsedModpacks(parsed, incoming);
      onParsed(next);
      setShowAddModal(false);
      setMessage(`${incoming.mods.length}件のMODを追加しました。`);
      appendDetailLog(
        "success",
        `${input.label} からMOD ${incoming.mods.length}件を追加しました（合計 ${next.mods.length}件）。`,
      );
    } catch (cause) {
      const errorMessage = cause instanceof Error ? cause.message : String(cause);
      setAddError(errorMessage);
      appendDetailLog("error", `MODを追加できませんでした: ${errorMessage}`);
    } finally {
      setAddBusy(false);
    }
  };

  const confirmRemoveMod = () => {
    if (!deleteJarPath || translationState !== "idle") return;
    const mod = parsed.mods.find((candidate) => candidate.jarPath === deleteJarPath);
    const next = removeModFromParsedModpack(parsed, deleteJarPath);
    onParsed(next);
    setDeleteJarPath(undefined);
    setMessage(`${mod?.metadata.name ?? mod?.jarName ?? deleteJarPath} を削除しました。`);
    appendDetailLog(
      "success",
      `${deleteJarPath} をワークスペースから削除しました（残り ${next.mods.length}件）。`,
    );
  };

  const toggleTranslationPause = () => {
    const task = translationTask.current;
    if (!task || translationState === "stopping") return;

    if (task.mode === "paused") {
      task.resume();
      setTranslationState("running");
      appendDetailLog("info", "AI翻訳を再開しました。");
      return;
    }

    task.pause();
    setTranslationState("paused");
    appendDetailLog("info", "AI翻訳を一時停止しました。モデルはメモリに保持されています。");
  };

  const stopTranslation = () => {
    const task = translationTask.current;
    if (!task || task.mode === "stopped") return;

    task.stop();
    setTranslationState("stopping");
    appendDetailLog("info", "AI翻訳を終了しています。モデルをアンロードします。");
  };

  const translateMissing = async () => {
    if (!isLfmModel(model) && !webGpu) {
      const webGpuMessage = "選択中のGemmaモデルにはWebGPUが必要です。WebGPU不要のLFM2.5を選択してください。";
      setMessage(webGpuMessage);
      appendDetailLog("error", webGpuMessage);
      return;
    }

    const batchSize = isLfmModel(model) ? getRecommendedLfmBatchSize() : 25;
    const groups: Array<{ namespace: string; entries: Array<{ key: string; source: string }> }> = [];
    for (const namespace of namespaces) {
      const byCategory = new Map<string, Array<{ key: string; source: string }>>();
      for (const [key, source] of Object.entries(parsed.namespaces[namespace].entries)) {
        if (translations[namespace]?.[key]?.trim()) continue;
        const category = categoryFromKey(key);
        byCategory.set(category, [...(byCategory.get(category) ?? []), { key, source }]);
      }
      for (const entries of byCategory.values()) {
        for (const batch of chunk(entries, batchSize)) groups.push({ namespace, entries: batch });
      }
    }

    const total = groups.reduce((sum, group) => sum + group.entries.length, 0);
    if (total === 0) {
      setMessage("すべての項目に日本語訳があります。");
      appendDetailLog("info", "未翻訳の項目がないため、AI翻訳をスキップしました。");
      return;
    }

    setMessage(undefined);
    const task = new TranslationTaskController();
    translationTask.current = task;
    setTranslationState("running");
    const modelDetails = TRANSLATION_MODELS[model];
    const activeTranslator = isLfmModel(model) ? lfmTranslator : gemmaTranslator;
    appendDetailLog("info", `${modelDetails.label} の読み込みを開始しました。翻訳対象は ${total}件です。`);
    if (isLfmModel(model) && !wasmParallel) {
      appendDetailLog("warning", "このページではWASM並列処理を利用できないため、LFMは1スレッドで動作します。スマートフォンでは最初の翻訳に時間がかかります。");
    }
    setProgress({ label: `${modelDetails.label} を読み込んでいます（初回はモデルをダウンロードします）`, current: 0, total });
    let stopped = false;
    try {
      if (isLfmModel(model)) {
        await lfmTranslator.load(model, ({ loaded, total: downloadTotal }) => {
          setProgress({
            label: downloadProgressLabel(modelDetails.label, loaded, downloadTotal),
            current: 0,
            total,
          });
        });
      }
      else await gemmaTranslator.load(model);
      appendDetailLog("success", `${modelDetails.label} の読み込みが完了しました。`);
      let current = 0;
      let rejected = 0;
      let next = translations;
      translationLoop: for (const group of groups) {
        let result;
        while (!result) {
          if (!await task.waitUntilRunnable()) {
            stopped = true;
            break translationLoop;
          }

          setProgress({ label: `${group.namespace} を翻訳しています`, current, total });
          appendDetailLog("info", `${group.namespace} の ${group.entries.length}件を翻訳しています（${current} / ${total}件完了）。`);
          const signal = task.startBatch();
          try {
            result = await activeTranslator.translate(group.entries, glossary, signal);
          } catch (error) {
            if (!signal.aborted) throw error;
          } finally {
            task.finishBatch(signal);
          }
        }

        if (!result) break;
        rejected += result.rejected.length;
        next = {
          ...next,
          [group.namespace]: { ...next[group.namespace], ...result.translations },
        };
        onTranslationOrigins?.((currentOrigins) => ({
          ...currentOrigins,
          [group.namespace]: {
            ...currentOrigins[group.namespace],
            ...Object.fromEntries(
              Object.keys(result.translations).map((key) => [key, "ai" as const]),
            ),
          },
        }));
        current += group.entries.length;
        onTranslations(next);
        setProgress({ label: `${group.namespace} を翻訳しています`, current, total });
        if (result.rejected.length > 0) {
          appendDetailLog("warning", `${group.namespace} の ${result.rejected.length}件が形式検証に通らず、未翻訳のまま残りました。`);
        }
      }
      if (!stopped) {
        setMessage(rejected > 0
          ? `${total - rejected}件を翻訳しました。${rejected}件は形式検証に通らなかったため未翻訳のままです。`
          : `${total}件の翻訳が完了しました。内容を確認してZIPを書き出してください。`);
        appendDetailLog(rejected > 0 ? "warning" : "success", `AI翻訳が完了しました（成功 ${total - rejected}件、未翻訳 ${rejected}件）。`);
      }
    } catch (error) {
      if (task.mode === "stopped") {
        stopped = true;
      } else {
        const errorMessage = `翻訳を続行できませんでした: ${error instanceof Error ? error.message : String(error)}`;
        setMessage(errorMessage);
        appendDetailLog("error", `[AI translation]\n${formatDebugValue(error)}`);
      }
    } finally {
      try {
        await activeTranslator.dispose();
        if (task.mode === "stopped" || stopped) {
          setMessage("AI翻訳を終了しました。完了済みの翻訳は保持され、モデルはアンロードされました。");
          appendDetailLog("success", "AI翻訳を終了し、モデルをアンロードしました。完了済みの翻訳は保持されています。");
        } else {
          appendDetailLog("info", `${modelDetails.label} をアンロードしました。`);
        }
      } catch (error) {
        if (task.mode === "stopped" || stopped) {
          setMessage(`AI翻訳は終了しましたが、モデルをアンロードできませんでした: ${error instanceof Error ? error.message : String(error)}`);
        }
        appendDetailLog("error", `[model unload]\n${formatDebugValue(error)}`);
      }
      if (translationTask.current === task) translationTask.current = undefined;
      setTranslationState("idle");
      setProgress(undefined);
    }
  };

  const savePack = async () => {
    if (!validPackFormat) {
      setExportError("pack_format には1以上の整数を指定してください。");
      return;
    }
    const packName = resourcePackName.trim();
    const packVersion = resourcePackVersion.trim();
    if (!packName || !packVersion) {
      setExportError("リソースパック名とバージョンを入力してください。");
      return;
    }
    if (selectedExportJarPaths.length === 0) {
      setExportError("リソースパックに含めるMODを1件以上選択してください。");
      return;
    }

    setExportBusy(true);
    setExportError(undefined);
    try {
      const iconBytes = resourcePackIcon
        ? new Uint8Array(await resourcePackIcon.arrayBuffer())
        : undefined;
      if (iconBytes && !hasPngSignature(iconBytes)) {
        throw new Error("リソースパックアイコンにはPNG画像を選択してください。");
      }
      const bytes = buildJapaneseResourcePack(parsed, translations, {
        packFormat,
        description: `${packName} ${packVersion}`,
        selectedJarPaths: selectedExportJarPaths,
        includeBuiltinTranslations,
        iconBytes,
      });
      const outputName = `${safeFileNamePart(packName, "resource-pack")}-${safeFileNamePart(packVersion, "v1")}.zip`;
      downloadBytes(bytes, outputName);
      setShowExportModal(false);
      setMessage(`${outputName} を書き出しました。`);
      appendDetailLog(
        "success",
        `${outputName} を生成しました（MOD ${selectedExportJarPaths.length}件、ビルトイン ${includeBuiltinTranslations ? "含む" : "除外"}、pack_format: ${packFormat}）。`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setExportError(errorMessage);
      appendDetailLog("error", `リソースパックを書き出せませんでした: ${errorMessage}`);
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <main className="content">
      <div className="workspace-header">
        <div>
          <p className="eyebrow"><CheckCircle2 size={14} /> ARCHIVE READY</p>
          <h1>翻訳ワークスペース</h1>
          <p className="workspace-subtitle">{fileName} — 抽出した訳文はその場で編集できます。</p>
        </div>
        <div className="workspace-actions">
          <button className="secondary-button" disabled={translationState !== "idle"} onClick={onReset}><RotateCcw size={14} />別の入力を開く</button>
          <button
            className="secondary-button"
            aria-controls="detail-log-panel"
            aria-expanded={showDetailLogs}
            onClick={() => setShowDetailLogs((visible) => !visible)}
          >
            <ScrollText size={14} />詳細ログを{showDetailLogs ? "隠す" : "表示"}
            {showDetailLogs ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          <button
            className="primary-button"
            disabled={!validPackFormat}
            onClick={() => {
              setExportError(undefined);
              setShowExportModal(true);
            }}
          >
            <Download size={15} />リソースパックを書き出す
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card"><div className="stat-label"><PackageOpen size={13} />MOD JAR</div><div className="stat-value">{parsed.mods.length}</div></div>
        <div className="stat-card"><div className="stat-label"><Boxes size={13} />NAMESPACE</div><div className="stat-value">{namespaces.length}</div></div>
        <div className="stat-card"><div className="stat-label"><ListChecks size={13} />翻訳キー</div><div className="stat-value">{totalEntries.toLocaleString()}</div></div>
        <div className="stat-card"><div className="stat-label"><Check size={13} />日本語あり</div><div className="stat-value">{translatedEntries.toLocaleString()}<small> / {totalEntries.toLocaleString()}</small></div></div>
      </div>

      <section className="mod-manager" aria-labelledby="loaded-mods-title">
        <div className="mod-manager-head">
          <div>
            <h2 id="loaded-mods-title">読み込み済みMOD</h2>
            <p>{parsed.mods.length}件のJARをリソースパックへ含めます。</p>
          </div>
          <button
            className="secondary-button"
            disabled={translationState !== "idle"}
            onClick={() => {
              setAddError(undefined);
              setShowAddModal(true);
            }}
          >
            <Plus size={14} />MODを追加
          </button>
        </div>
        {parsed.mods.length > 0 ? (
          <ul className="mod-list">
            {parsed.mods.map((mod) => {
              const name = mod.metadata.name ?? mod.metadata.modId ?? mod.jarName;
              return (
                <li className="mod-list-item" key={mod.jarPath}>
                  <ExtractedIcon
                    className="mod-list-icon"
                    iconUrl={modIconUrls.get(mod.jarPath)}
                    alt={`${name} のアイコン`}
                    fallback={<PackageOpen size={17} aria-hidden="true" />}
                  />
                  <div className="mod-list-copy">
                    <div className="mod-list-name">
                      <span>{name}</span>
                      {mod.metadata.version && <small>v{mod.metadata.version}</small>}
                    </div>
                    <div className="mod-list-meta">
                      <span>{mod.jarPath}</span>
                      <span>{mod.metadata.loader}</span>
                      <span>{mod.namespaces.length} namespace</span>
                    </div>
                  </div>
                  <button
                    className="mod-remove-button"
                    aria-label={`${mod.jarPath} を削除`}
                    title={`${name} を削除`}
                    disabled={translationState !== "idle"}
                    onClick={() => setDeleteJarPath(mod.jarPath)}
                  >
                    <Minus size={16} strokeWidth={3} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mod-list-empty">MODがありません。「MODを追加」からJARを読み込めます。</p>
        )}
      </section>

      {parsed.warnings.length > 0 && (
        <div className="notice-banner"><AlertTriangle size={16} />
          {parsed.warnings.length}件の読み込み警告があります。正常な言語ファイルはそのまま利用できます。
        </div>
      )}
      {message && <div className="notice-banner"><Sparkles size={16} />{message}</div>}
      {progress && (
        <div className={`progress-strip ${translationState}`}>
          <div className="progress-copy">
            <span>{translationState === "paused"
              ? "一時停止中（モデルはメモリに保持されています）"
              : translationState === "stopping"
                ? "終了処理中（モデルをアンロードしています）"
                : progress.label}</span>
            <span>{progress.current} / {progress.total}</span>
          </div>
          <div className="progress-track"><div className="progress-bar" style={{ width: `${Math.max(2, progress.current / progress.total * 100)}%` }} /></div>
        </div>
      )}
      <section id="detail-log-panel" className="detail-log-panel" aria-label="詳細ログ" hidden={!showDetailLogs}>
        <div className="detail-log-head">
          <div><ScrollText size={15} /><h2>詳細ログ</h2></div>
          <span>{detailLogs.length}件</span>
        </div>
        <ol className="detail-log-list" role="log" aria-live="polite">
          {detailLogs.map((entry) => (
            <li className={`detail-log-entry ${entry.level}`} key={entry.id}>
              <time>{entry.timestamp}</time>
              <span className="detail-log-level">{DETAIL_LOG_LABELS[entry.level]}</span>
              <span className="detail-log-message">{entry.message}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="translator-toolbar">
        <div className="model-control">
          <label htmlFor="model">翻訳モデル</label>
          <select id="model" className="select-control" value={model} onChange={(event) => setModel(event.target.value as TranslationModel)} disabled={translationState !== "idle"}>
            {Object.entries(TRANSLATION_MODELS).map(([value, details]) => (
              <option
                value={value}
                key={value}
                disabled={!webGpu && !isLfmModel(value as TranslationModel)}
              >
                {details.label} — {details.description}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar-right">
          {isLfmModel(model) ? (
            <span className={`runtime-state ${wasmParallel ? "ready" : ""}`}>
              <Cpu size={13} />WASM / CPU（{wasmParallel ? "並列" : "1スレッド"}・WebGPU不要）
            </span>
          ) : (
            <span className={`runtime-state ${webGpu ? "ready" : ""}`}><Cpu size={13} />WebGPU {webGpu ? "対応" : "非対応"}</span>
          )}
          {translationState === "idle" ? (
            <button className="primary-button" onClick={translateMissing}>
              <Sparkles size={14} />未翻訳をAI翻訳
            </button>
          ) : (
            <div className="translation-actions" aria-label="AI翻訳の操作">
              <button
                className="secondary-button"
                disabled={translationState === "stopping"}
                aria-pressed={translationState === "paused"}
                onClick={toggleTranslationPause}
              >
                {translationState === "paused" ? <Play size={14} /> : <Pause size={14} />}
                {translationState === "paused" ? "再開" : "一時停止"}
              </button>
              <button className="danger-button" disabled={translationState === "stopping"} onClick={stopTranslation}>
                {translationState === "stopping" ? <LoaderCircle className="spin" size={14} /> : <Square size={13} />}
                {translationState === "stopping" ? "終了中…" : "終了"}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="workspace-grid">
        <aside className="namespace-panel">
          <p className="panel-title">NAMESPACES</p>
          <div className="namespace-list">
            {namespaces.map((namespace) => {
              const iconMod = parsed.namespaces[namespace].jarPaths
                .map((jarPath) => modsByJarPath.get(jarPath))
                .find((mod) => mod?.icon);
              return (
                <button
                  className={`namespace-button ${namespace === selectedNamespace ? "active" : ""}`}
                  key={namespace}
                  onClick={() => setSelectedNamespace(namespace)}
                >
                  <ExtractedIcon
                    className="namespace-icon"
                    iconUrl={iconMod ? modIconUrls.get(iconMod.jarPath) : undefined}
                    alt={`${namespace} のアイコン`}
                    fallback={<Blocks size={14} aria-hidden="true" />}
                  />
                  <span className="namespace-name">{namespace}</span>
                  <span className="namespace-count">{Object.keys(parsed.namespaces[namespace].entries).length}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="editor-panel">
          <div className="editor-head">
            <div>
              <h2>{selectedNamespace || "翻訳ファイルがありません"}</h2>
              <p>{selected ? `${selected.jarPaths.length} JAR・既存日本語 ${Object.keys(selected.existingJapanese).length} 件` : ""}</p>
            </div>
            <div className="search-box"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="キーや訳文を検索" /></div>
          </div>

          {selected ? (
            <div className="translation-table-wrap">
              <table className="translation-table">
                <thead><tr><th>翻訳キー</th><th>英語</th><th>日本語</th></tr></thead>
                <tbody>
                  {visibleEntries.map(([key, source]) => {
                    const status = translationStatus(selectedNamespace, key);
                    return (
                      <tr key={key}>
                        <td className="key-cell">
                          <span className="key-text">{key}</span>
                          <span className={`translation-status ${status}`}>
                            {TRANSLATION_STATUS_LABELS[status]}
                          </span>
                        </td>
                        <td className="source-cell">{source}</td>
                        <td>
                          <textarea
                            className={`translation-input ${status === "builtin" ? "existing" : ""}`}
                            aria-label={`${key} の日本語訳`}
                            value={translations[selectedNamespace]?.[key] ?? ""}
                            placeholder="未翻訳"
                            onChange={(event) => setTranslation(selectedNamespace, key, event.target.value)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {visibleEntries.length === 0 && <div className="empty-editor">検索条件に一致する項目がありません。</div>}
            </div>
          ) : (
            <div className="empty-editor">英語の言語ファイルが見つかりませんでした。</div>
          )}
        </section>
      </div>
      {existingEntries > 0 && (
        <p className="workspace-footnote">
          元のMODに含まれる既存日本語 {existingEntries} 件は「ビルトイン」として維持し、編集後は「手動修正」として表示します。
        </p>
      )}

      {showExportModal && (
        <Modal
          id="export-pack"
          title="リソースパックを書き出す"
          descriptionId="export-pack-description"
          locked={exportBusy}
          onClose={() => setShowExportModal(false)}
        >
          <p id="export-pack-description" className="modal-copy">
            パックの情報と収録するMODを確認して、Minecraft用のZIPを作成します。
          </p>
          <form
            className="export-form"
            onSubmit={(event) => {
              event.preventDefault();
              void savePack();
            }}
          >
            <div className="export-field-grid">
              <label className="export-field" htmlFor="resource-pack-name">
                <span>リソースパック名</span>
                <input
                  id="resource-pack-name"
                  value={resourcePackName}
                  required
                  onChange={(event) => setResourcePackName(event.target.value)}
                />
              </label>
              <label className="export-field" htmlFor="resource-pack-version">
                <span>リソースパックバージョン</span>
                <input
                  id="resource-pack-version"
                  value={resourcePackVersion}
                  required
                  onChange={(event) => setResourcePackVersion(event.target.value)}
                />
              </label>
            </div>

            <label className="export-field" htmlFor="target-minecraft-version">
              <span>対象Minecraftバージョン</span>
              <select
                id="target-minecraft-version"
                className="select-control"
                style={{ width: "100%" }}
                value={packFormat}
                onChange={(event) => setPackFormat(Number(event.target.value))}
              >
                {MINECRAFT_VERSION_OPTIONS.map((option) => (
                  <option value={option.packFormat} key={option.packFormat}>
                    Minecraft {option.label}（pack format {option.packFormat}）
                  </option>
                ))}
              </select>
            </label>

            <label className="export-field" htmlFor="resource-pack-icon">
              <span>リソースパックアイコン <small>任意・PNG</small></span>
              <input
                id="resource-pack-icon"
                ref={exportIconInputRef}
                className="export-file-control"
                type="file"
                accept=".png,image/png"
                onChange={(event) => {
                  setResourcePackIcon(event.target.files?.[0]);
                  setExportError(undefined);
                }}
              />
            </label>
            {resourcePackIcon && (
              <div className="selected-icon-row">
                <span>{resourcePackIcon.name}</span>
                <button
                  className="icon-clear-button"
                  type="button"
                  aria-label="選択したアイコンを解除"
                  onClick={() => {
                    setResourcePackIcon(undefined);
                    if (exportIconInputRef.current) exportIconInputRef.current.value = "";
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            )}

            <details className="export-mod-picker">
              <summary>
                <span>
                  <PackageOpen size={15} />リソースパックに含めるMOD
                </span>
                <small>{selectedExportJarPaths.length} / {parsed.mods.length}件</small>
              </summary>
              <div className="export-mod-options">
                <label className="export-check-row builtin-option">
                  <input
                    type="checkbox"
                    checked={includeBuiltinTranslations}
                    onChange={(event) => setIncludeBuiltinTranslations(event.target.checked)}
                  />
                  <span>
                    <strong>ビルトインのキーを含める</strong>
                    <small>選択したMODに元から含まれる日本語訳 {selectedBuiltinEntries}件も収録します。</small>
                  </span>
                </label>
                <div className="export-mod-list">
                  {parsed.mods.map((mod) => {
                    const name = mod.metadata.name ?? mod.metadata.modId ?? mod.jarName;
                    const selectedForExport = selectedExportJarPaths.includes(mod.jarPath);
                    return (
                      <label className="export-check-row" key={mod.jarPath}>
                        <input
                          type="checkbox"
                          checked={selectedForExport}
                          onChange={(event) => setSelectedExportJarPaths((current) =>
                            event.target.checked
                              ? [...current, mod.jarPath]
                              : current.filter((jarPath) => jarPath !== mod.jarPath)
                          )}
                        />
                        <span>
                          <strong>{name}</strong>
                          <small>{mod.jarPath}{mod.metadata.version ? `・${mod.metadata.version}` : ""}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </details>

            {exportError && <div className="error-banner" role="alert"><AlertTriangle size={16} />{exportError}</div>}
            {selectedExportJarPaths.length === 0 && !exportError && (
              <p className="export-validation">書き出すMODを1件以上選択してください。</p>
            )}
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={exportBusy}
                onClick={() => setShowExportModal(false)}
              >
                キャンセル
              </button>
              <button className="primary-button" type="submit" disabled={!validExportSettings || exportBusy}>
                {exportBusy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                {exportBusy ? "ZIPを作成中…" : "ZIPを書き出す"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showAddModal && (
        <Modal
          id="add-mod"
          title="MODを追加"
          descriptionId="add-mod-description"
          locked={addBusy}
          onClose={() => setShowAddModal(false)}
        >
          <p id="add-mod-description" className="modal-copy">
            ZIP、JAR、またはJARを含むフォルダーを選択してください。現在の翻訳内容は維持されます。
          </p>
          <ArchiveInputPicker busy={addBusy} compact onInput={addMods} />
          {addError && (
            <div className="error-banner" role="alert">
              <AlertTriangle size={16} />{addError}
            </div>
          )}
        </Modal>
      )}

      {deleteJarPath && (
        <Modal
          id="remove-mod"
          title="MODを削除"
          descriptionId="remove-mod-description"
          onClose={() => setDeleteJarPath(undefined)}
        >
          <p id="remove-mod-description" className="modal-copy">
            <strong>{deleteJarPath}</strong> を削除します。このMODだけが持つ翻訳キーと既存日本語訳は、出力するリソースパックからも削除されます。
          </p>
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setDeleteJarPath(undefined)}>
              キャンセル
            </button>
            <button className="danger-button" onClick={confirmRemoveMod}>
              <Trash2 size={14} />削除する
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

export default function App() {
  const [view, setView] = useState<View>("workspace");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedModpack>();
  const [fileName, setFileName] = useState("");
  const [translations, setTranslations] = useState<JapaneseTranslations>({});
  const [translationOrigins, setTranslationOrigins] = useState<TranslationOrigins>({});
  const [glossary, setGlossary] = useState<Record<string, string>>(readGlossary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileMenuOpen]);

  const updateGlossary = (value: Record<string, string>) => {
    setGlossary(value);
    localStorage.setItem("craftlingo-glossary", JSON.stringify(value));
  };

  const updateParsed = (value: ParsedModpack) => {
    setParsed(value);
    setTranslations((current) => reconcileTranslations(value, current));
    setTranslationOrigins((current) => {
      const next: TranslationOrigins = {};
      for (const [namespace, origins] of Object.entries(current)) {
        if (!value.namespaces[namespace]) continue;
        const surviving = Object.fromEntries(
          Object.entries(origins).filter(([key]) => Object.hasOwn(value.namespaces[namespace].entries, key)),
        );
        if (Object.keys(surviving).length > 0) next[namespace] = surviving;
      }
      return next;
    });
  };

  const openInput = async (input: ArchiveInputSelection) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await parseInputSelection(input);
      setParsed(result);
      setFileName(input.label);
      setTranslations(reconcileTranslations(result, {}));
      setTranslationOrigins({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setParsed(undefined);
    setFileName("");
    setTranslations({});
    setTranslationOrigins({});
    setError(undefined);
  };

  return (
    <div className="app-shell">
      <Sidebar
        open={mobileMenuOpen}
        view={view}
        onClose={() => setMobileMenuOpen(false)}
        onView={setView}
      />
      <div className="main-area">
        <Topbar
          menuOpen={mobileMenuOpen}
          onMenuOpen={() => setMobileMenuOpen(true)}
          title={view === "glossary" ? "共通用語集" : "翻訳ワークスペース"}
        />
        {view === "glossary" ? (
          <Glossary glossary={glossary} onChange={updateGlossary} onBack={() => setView("workspace")} />
        ) : parsed ? (
          <Workspace
            fileName={fileName}
            parsed={parsed}
            translations={translations}
            onTranslations={setTranslations}
            translationOrigins={translationOrigins}
            onTranslationOrigins={setTranslationOrigins}
            onParsed={updateParsed}
            glossary={glossary}
            onReset={reset}
          />
        ) : (
          <Landing busy={busy} error={error} onInput={openInput} />
        )}
      </div>
    </div>
  );
}
