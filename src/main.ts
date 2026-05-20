import {
  Plugin,
  parseYaml,
  stringifyYaml,
  normalizePath,
  TFile,
  Notice,
  requestUrl,
  MarkdownView,
} from "obsidian";
import type { App, MarkdownPostProcessorContext } from "obsidian";
import { MapInstance } from "./map";
import type {
  ZoomMapConfig,
  ZoomMapSettings,
  IconProfile,
  BaseCollection,
  CustomUnitDef,
  TerrainDef,
  TravelTimePreset,
  TravelRulesPack,
} from "./map";

import { ViewEditorModal, type ViewEditorConfig } from "./viewEditorModal";
import { ImageCache } from "./imageCache";
import { ZoomMapSettingTab } from "./settingsTab";

/* ---------------- Utils ---------------- */

function svgPinDataUrl(color = "#d23c3c"): string {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <path fill="${color}" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7m0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/>
</svg>`;
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

export interface ZoomMapSettingsExtended extends ZoomMapSettings {
  defaultWidthWrapped?: string;
  libraryFilePath?: string; // Single library file in the vault that stores icons + collections
  faFolderPath?: string; // Folder in vault containing SVG icon packs
}

export interface TravelPerDayConfig {
  value: number;
  unit: string; // must match preset.timeUnit (string)
}

interface LibraryFileData {
  version: 1;
  icons: IconProfile[];
  baseCollections: BaseCollection[];
  travelRulesPacks?: TravelRulesPack[];
  exportedAt?: string;
}

function toCssSize(v: unknown, fallback: string): string {
  if (typeof v === "number" && Number.isFinite(v)) return `${v}px`;
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return fallback;
}

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

const DEFAULT_FA_ZIP_URL =
  "https://use.fontawesome.com/releases/v6.4.0/fontawesome-free-6.4.0-web.zip";

const DEFAULT_RPG_ZIP_URL =
  "https://github.com/nagoshiashumari/rpg-awesome-raw/archive/refs/heads/master.zip";

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function setCssProps(el: HTMLElement, props: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null) el.style.removeProperty(key);
    else el.style.setProperty(key, value);
  }
}

interface CrossWindowInstanceOfElement extends Element {
  instanceOf(ctor: Window["HTMLElement"]): this is HTMLElement;
}

interface CrossWindowWindow extends Window {
  HTMLElement: Window["HTMLElement"];
}

export function isCrossWindowHTMLElement(
  el: Element,
  uiWin: Window,
): el is HTMLElement {
  const candidate = el as CrossWindowInstanceOfElement;
  const crossWin = uiWin as CrossWindowWindow;
  if (typeof crossWin.HTMLElement !== "function") {
    return false;
  }
  return candidate.instanceOf(crossWin.HTMLElement);
}

/* ---------------- Defaults ---------------- */

const DEFAULT_SETTINGS: ZoomMapSettingsExtended = {
  icons: [
    {
      key: "pinRed",
      pathOrDataUrl: svgPinDataUrl("#d23c3c"),
      size: 24,
      anchorX: 12,
      anchorY: 12,
	  inCollections: true,
    },
    {
      key: "pinBlue",
      pathOrDataUrl: svgPinDataUrl("#3c62d2"),
      size: 24,
      anchorX: 12,
      anchorY: 12,
	  inCollections: true,
    },
  ],
  defaultIconKey: "pinRed",
  wheelZoomFactor: 1.1,
  panMouseButton: "left",
  hoverMaxWidth: 360,
  applyHoverPopoverSizeGlobally: false,
  hoverMaxHeight: 260,
  showLinkFileNameInTooltip: false,
  presets: [],
  stickerPresets: [],
  defaultWidth: "100%",
  defaultHeight: "480px",
  defaultResizable: false,
  defaultResizeHandle: "right",
  forcePopoverWithoutModKey: true,
  measureLineColor: "var(--text-accent)",
  measureLineWidth: 2,
  storageDefault: "json",
  defaultWidthWrapped: "50%",
  baseCollections: [],
  pinPlaceOpensEditor: false,
  libraryFilePath: "ZoomMap/library.json",
  faFolderPath: "ZoomMap/SVGs",
  customUnits: [],
  travelTimePresets: [],
  travelPerDay: { value: 8, unit: "h" },
  travelRulesPacks: [],
  defaultScaleLikeSticker: false,
  enableDrawing: false,
  preferActiveLayerInEditor: false,
  enableTextLayers: false,
  enableMeasurePro: false,
  enableSessionImageCache: false,
  sessionImageCacheMb: 512,
  keepOverlaysLoaded: false,
  preferCanvasImagesWhenCaching: false, 
  svgRasterMaxScale: 8,
  showImageIconPreviewInSettings: false,
  enableGrid: false,
  middleClickOpensLinkInNewTab: false,
  enableSecondScreen: false,
  secondScreenFolder: "ZoomMap/SecondScreen",
};

/* ---------------- YAML parsing helpers ---------------- */

interface YamlBase {
  path: string;
  name?: string;
}
interface YamlOverlay {
  path: string;
  name?: string;
  visible?: boolean;
}

interface YamlOptions {
  image?: string;
  imageVar?: string;
  imageBasesVar?: string;
  imageOverlaysVar?: string;
  markers?: string;
  minZoom?: number | string;
  maxZoom?: number | string;
  height?: string | number;
  width?: string | number;
  resizable?: boolean;
  resizeHandle?: string; // parsed
  render?: string; // parsed
  responsive?: boolean;
  responsiv?: boolean; // legacy alias

  storage?: string; // parsed to json|note
  id?: string;

  align?: string; // parsed to left|center|right
  wrap?: boolean;

  classes?: string | string[];

  imageBases?: (YamlBase | string)[];
  imageOverlays?: (YamlOverlay | string)[];

  scale?: { metersPerPixel?: number; pixelsPerMeter?: number };
  
  markerLayers?: (string | { name: string })[];
  
  view?: {
    zoom?: number | string;
    centerX?: number;
    centerY?: number;
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
    fit?: "cover" | "contain";
  };


  viewportFrame?: string;
  viewportFrameInsets?: {
    unit?: "framePx" | "percent";
    top?: number | string;
    right?: number | string;
    bottom?: number | string;
    left?: number | string;
  };
  displayOnly?: boolean;
}

function parseBasesYaml(v: unknown): YamlBase[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .map((it) => {
      if (typeof it === "string") return { path: it };
      if (it && typeof it === "object" && "path" in it) {
        const obj = it as { path?: unknown; name?: unknown };
        if (typeof obj.path === "string") {
          return {
            path: obj.path,
            name: typeof obj.name === "string" ? obj.name : undefined,
          };
        }
      }
      return null;
    })
    .filter((b): b is YamlBase => b !== null);
}

function parseOverlaysYaml(v: unknown): YamlOverlay[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[])
    .map((it) => {
      if (typeof it === "string") return { path: it };
      if (it && typeof it === "object" && "path" in it) {
        const obj = it as {
          path?: unknown;
          name?: unknown;
          visible?: unknown;
        };
        if (typeof obj.path === "string") {
          return {
            path: obj.path,
            name: typeof obj.name === "string" ? obj.name : undefined,
            visible: typeof obj.visible === "boolean" ? obj.visible : undefined,
          };
        }
      }
      return null;
    })
    .filter((o): o is YamlOverlay => o !== null);
}

function parseScaleYaml(v: unknown): number | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as { metersPerPixel?: unknown; pixelsPerMeter?: unknown };
  const mpp =
    typeof obj.metersPerPixel === "number" && obj.metersPerPixel > 0
      ? obj.metersPerPixel
      : undefined;
  const ppm =
    typeof obj.pixelsPerMeter === "number" && obj.pixelsPerMeter > 0
      ? 1 / obj.pixelsPerMeter
      : undefined;
  return mpp ?? ppm;
}

function parseZoomYaml(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    let s = value.trim();
    if (!s) return fallback;
    const hasPercent = s.endsWith("%");
    if (hasPercent) s = s.slice(0, -1).trim();
    s = s.replace(",", ".");
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) {
      return hasPercent ? n / 100 : n;
    }
  }
  return fallback;
}

function parsePxNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return fallback;
    const m = /^(-?\d+(?:[.,]\d+)?)\s*px$/i.exec(s) ?? /^(-?\d+(?:[.,]\d+)?)$/.exec(s);
    if (m) {
      const n = Number(m[1].replace(",", "."));
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

function parseFrameInsetsYaml(v: unknown):
  | { unit: "framePx" | "percent"; top: number; right: number; bottom: number; left: number }
  | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;

  const unit = o.unit === "percent" ? "percent" : "framePx";

  const parsePercent = (x: unknown): number => {
    if (typeof x === "number") return x;
    if (typeof x === "string") {
      let s = x.trim();
      if (!s) return Number.NaN;
      if (s.endsWith("%")) s = s.slice(0, -1).trim();
      const n = Number(s.replace(",", "."));
      return n;
    }
    return Number.NaN;
  };

  const parseFramePx = (x: unknown): number => {
    return parsePxNumber(x, Number.NaN);
  };

  const top = unit === "percent" ? parsePercent(o.top) : parseFramePx(o.top);
  const right = unit === "percent" ? parsePercent(o.right) : parseFramePx(o.right);
  const bottom = unit === "percent" ? parsePercent(o.bottom) : parseFramePx(o.bottom);
  const left = unit === "percent" ? parsePercent(o.left) : parseFramePx(o.left);

  if (![top, right, bottom, left].every((n) => Number.isFinite(n) && n >= 0)) {
    return undefined;
  }

  return { unit, top, right, bottom, left };
}


function parseAlign(v: unknown): "left" | "center" | "right" | undefined {
  if (v === "left" || v === "center" || v === "right") return v;
  return undefined;
}

function parseResizeHandle(v: unknown): "left" | "right" | "both" | "native" {
  return v === "left" || v === "right" || v === "both" || v === "native"
    ? v
    : "right";
}

async function readSavedFrame(
  app: App,
  markersPath: string,
): Promise<{ w: number; h: number } | null> {
  try {
    const file = app.vault.getAbstractFileByPath(normalizePath(markersPath));
    if (!(file instanceof TFile)) return null;

    const raw = await app.vault.read(file);
    const parsed = JSON.parse(raw) as unknown;

    let fw = Number.NaN;
    let fh = Number.NaN;

    if (isPlainObject(parsed)) {
      const frame = (parsed as { frame?: unknown }).frame;
      if (frame && typeof frame === "object") {
        const fr = frame as { w?: unknown; h?: unknown };
        fw = typeof fr.w === "number" ? fr.w : Number(fr.w);
        fh = typeof fr.h === "number" ? fr.h : Number(fr.h);
      }
    }

    if (Number.isFinite(fw) && Number.isFinite(fh) && fw >= 48 && fh >= 48) {
      return { w: Math.round(fw), h: Math.round(fh) };
    }
  } catch {
    // ignore
  }
  return null;
}

/* ---------------- Plugin ---------------- */

export default class ZoomMapPlugin extends Plugin {
  settings: ZoomMapSettings = DEFAULT_SETTINGS;
  imageCache: ImageCache | null = null;

  activeMap: MapInstance | null = null;

  setActiveMap(inst: MapInstance): void {
    this.activeMap = inst;
  }
  
  private getUiDocument(): Document {
    return this.app.workspace.containerEl.ownerDocument;
  }

  private clearGlobalHoverPopoverSettings(): void {
    const doc = this.getUiDocument();
    const root = doc.documentElement;
    const body = doc.body;
    if (!root || !body) return;

    body.classList.remove("zm-global-hover-popover-size");

    root.style.removeProperty("--zm-hover-popover-max-width");
    root.style.removeProperty("--zm-hover-popover-max-height");
    root.style.removeProperty("--popover-width");
    root.style.removeProperty("--popover-height");
    root.style.removeProperty("--popover-max-height");

    body.style.removeProperty("--zm-hover-popover-max-width");
    body.style.removeProperty("--zm-hover-popover-max-height");
    body.style.removeProperty("--popover-width");
    body.style.removeProperty("--popover-height");
    body.style.removeProperty("--popover-max-height");
  }

  public applyGlobalHoverPopoverSettings(): void {
    const doc = this.getUiDocument();
    const root = doc.documentElement;
    const body = doc.body;
    if (!root || !body) return;

    if (!this.settings.applyHoverPopoverSizeGlobally) {
      this.clearGlobalHoverPopoverSettings();
      return;
    }

    const maxW = Math.max(200, this.settings.hoverMaxWidth ?? 360);
    const maxH = Math.max(120, this.settings.hoverMaxHeight ?? 260);

    body.classList.add("zm-global-hover-popover-size");
    root.style.setProperty("--zm-hover-popover-max-width", `${maxW}px`);
    root.style.setProperty("--zm-hover-popover-max-height", `${maxH}px`);
  }

  async onload(): Promise<void> {
    await this.loadSettings();
	this.applyGlobalHoverPopoverSettings();
    this.applyImageCacheSettings();
	
	this.addCommand({
    id: "insert-new-map",
    name: "Insert new map…",
    editorCallback: (editor, view) => {
      const file = (view as MarkdownView).file;
      if (!file) return;

      const initialConfig: ViewEditorConfig = {
        imageBases: [{ path: "", name: "" }],
        overlays: [],
        markersPath: "",
        renderMode: "dom",
        minZoom: 0.25,
        maxZoom: 8,
        wrap: false,
        responsive: false,
        width: "100%",
        height: "480px",
		useWidth: true,
		useHeight: true,
        resizable: false,
        resizeHandle: "native",
        align: undefined,
        markerLayers: ["Default"],
		id: `map-${Date.now().toString(36)}`,

        viewportFrame: "",
        viewportFrameInsets: {
          unit: "framePx",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
        },
      };

      new ViewEditorModal(this.app, initialConfig, (res) => {
        if (res.action !== "save" || !res.config) return;
        const yaml = this.buildYamlFromViewConfig(res.config);
        const block = "```zoommap\n" + yaml + "\n```\n";

        // If user inserts inside a callout / blockquote line, prefix all inserted lines
        // with the same quote prefix ("> ", "> > ", etc.).
        const cur = editor.getCursor();
        const curLineText = editor.getLine(cur.line) ?? "";
        const m = /^(\s*(?:>\s*)+)/.exec(curLineText);
        const quotePrefix = m?.[1] ?? "";

        if (!quotePrefix) {
          editor.replaceRange(block, cur);
          return;
        }

        const cursorAfterPrefix = cur.ch >= quotePrefix.length;
        const lines = block.split("\n");
        const quoted = lines
          .map((ln, idx) => {
            if (idx === 0 && cursorAfterPrefix) return ln;
            return quotePrefix + ln;
          })
          .join("\n");

        editor.replaceRange(quoted, cur);
      }).open();
    },
  });

    this.addCommand({
      id: "toggle-measure-mode",
      name: "Toggle measure mode",
      checkCallback: (checking) => {
        const map = this.activeMap;
        if (!map) return false;
        if (!checking) map.toggleMeasureFromCommand();
        return true;
      },
    });
	
    this.addCommand({
      id: "clear-measurement",
      name: "Clear measurement",
      checkCallback: (checking) => {
        const map = this.activeMap;
        if (!map) return false;
        if (!checking) map.clearMeasurementFromCommand();
        return true;
      },
    });

    this.registerMarkdownCodeBlockProcessor(
      "zoommap",
      async (src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        let opts: Partial<YamlOptions> = {};

        try {
          const parsed: unknown = parseYaml(src);
          if (parsed && typeof parsed === "object") {
            opts = parsed as Partial<YamlOptions>;
          }
        } catch (error) {
          console.error("Zoom Map: failed to parse zoommap block", error);
        }

        const yamlBases = parseBasesYaml(opts.imageBases);
        if (yamlBases.length === 0 && typeof opts.imageBasesVar === "string" && opts.imageBasesVar.trim()) {
          // Read imageBases from a named frontmatter key.
          const fmKey = opts.imageBasesVar.trim();
          const noteFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (noteFile instanceof TFile) {
            const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
            const fmVal = fm?.[fmKey];
            const stripBrackets = (s: string): string => {
              const t = s.trim();
              return t.startsWith("[[") && t.endsWith("]]") ? t.slice(2, -2).trim() : t;
            };
            const baseName = (p: string): string => {
              const name = p.split("/").pop() ?? p;
              return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
            };
            // Plain strings become { path, name } objects so parseBasesYaml receives
            // a name derived from the file basename.
            const normalise = (v: unknown): unknown =>
              typeof v === "string"
                ? { path: stripBrackets(v), name: baseName(stripBrackets(v)) }
                : Array.isArray(v) ? v.map(normalise)
                : v && typeof v === "object" && "path" in v
                  ? { ...(v as object), path: stripBrackets(String((v as Record<string, unknown>).path ?? "")) }
                  : v;
            yamlBases.push(...parseBasesYaml(Array.isArray(fmVal) ? normalise(fmVal) as unknown[] : [normalise(fmVal)]));
          }
        }
        const yamlOverlays = parseOverlaysYaml(opts.imageOverlays);
        if (yamlOverlays.length === 0 && typeof opts.imageOverlaysVar === "string" && opts.imageOverlaysVar.trim()) {
          // Read imageOverlays from a named frontmatter key.
          const fmKey = opts.imageOverlaysVar.trim();
          const noteFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (noteFile instanceof TFile) {
            const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
            const fmVal = fm?.[fmKey];
            const stripBrackets = (s: string): string => {
              const t = s.trim();
              return t.startsWith("[[") && t.endsWith("]]") ? t.slice(2, -2).trim() : t;
            };
            const baseName = (p: string): string => {
              const name = p.split("/").pop() ?? p;
              return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
            };
            // Plain strings become { path, name } objects so parseOverlaysYaml receives
            // a name derived from the file basename.
            const normalise = (v: unknown): unknown =>
              typeof v === "string"
                ? { path: stripBrackets(v), name: baseName(stripBrackets(v)) }
                : Array.isArray(v) ? v.map(normalise)
                : v && typeof v === "object" && "path" in v
                  ? { ...(v as object), path: stripBrackets(String((v as Record<string, unknown>).path ?? "")) }
                  : v;
            yamlOverlays.push(...parseOverlaysYaml(Array.isArray(fmVal) ? normalise(fmVal) as unknown[] : [normalise(fmVal)]));
          }
        }
        const yamlMetersPerPixel = parseScaleYaml(opts.scale);
        const yamlFrameInsets = parseFrameInsetsYaml(opts.viewportFrameInsets);
		
		let initialZoom: number | undefined;
		let initialCenter: { x: number; y: number } | undefined;
		let initialViewRect:
		  | { left: number; top: number; right: number; bottom: number }
		  | undefined;

		const viewOpt = opts.view;
		if (viewOpt && typeof viewOpt === "object") {
		  // Zoom: Zahl oder Prozent-String
		  const rawZoom = parseZoomYaml(viewOpt.zoom, NaN);
		  if (!Number.isFinite(rawZoom) || rawZoom <= 0) {
			initialZoom = undefined;
		  } else {
			initialZoom = rawZoom;
		  }

		  const cx = typeof viewOpt.centerX === "number" ? viewOpt.centerX : NaN;
		  const cy = typeof viewOpt.centerY === "number" ? viewOpt.centerY : NaN;
		  if (Number.isFinite(cx) && Number.isFinite(cy)) {
			initialCenter = {
			  x: Math.min(Math.max(cx, 0), 1),
			  y: Math.min(Math.max(cy, 0), 1),
			};
		  }

		  const left = typeof viewOpt.left === "number" ? viewOpt.left : Number.NaN;
		  const top = typeof viewOpt.top === "number" ? viewOpt.top : Number.NaN;
		  const right = typeof viewOpt.right === "number" ? viewOpt.right : Number.NaN;
		  const bottom = typeof viewOpt.bottom === "number" ? viewOpt.bottom : Number.NaN;

		  if (
			Number.isFinite(left) &&
			Number.isFinite(top) &&
			Number.isFinite(right) &&
			Number.isFinite(bottom) &&
			right > left &&
			bottom > top
		  ) {
			initialViewRect = { left, top, right, bottom };
		  }
		}

        const preferCanvas =
          !!this.settings.enableSessionImageCache &&
          !!this.settings.preferCanvasImagesWhenCaching;

        const yamlRender =
          typeof opts.render === "string" ? opts.render.trim().toLowerCase() : "";

        const renderMode: "dom" | "canvas" =
          yamlRender === "canvas" ? "canvas"
          : yamlRender === "dom" ? "dom"
          : preferCanvas ? "canvas"
          : "dom";

        let image = typeof opts.image === "string" ? opts.image.trim() : "";
        if (!image && typeof opts.imageVar === "string" && opts.imageVar.trim()) {
          // `imageVar` names a frontmatter key to read the image path from.
          const fmKey = opts.imageVar.trim();
          const noteFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (noteFile instanceof TFile) {
            const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
            const fmImage = fm?.[fmKey];
            if (typeof fmImage === "string" && fmImage.trim()) {
              const raw = fmImage.trim();
              image = raw.startsWith("[[") && raw.endsWith("]]") ? raw.slice(2, -2).trim() : raw;
            }
          }
        }
        if (!image && yamlBases.length > 0) image = yamlBases[0].path;
        if (!image) {
          el.createEl("div", { text: "Image is missing." });
          return;
        }

        const responsive = !!(opts.responsive ?? opts.responsiv);

        const storageRaw =
          typeof opts.storage === "string" ? opts.storage.toLowerCase() : "";
        const storageMode: "json" | "note" =
          storageRaw === "note" || storageRaw === "inline" || storageRaw === "in-note"
            ? "note"
            : storageRaw === "json"
              ? "json"
              : (this.settings.storageDefault ?? "json");

        const sectionInfo = ctx.getSectionInfo(el);
        const defaultId = `map-${sectionInfo?.lineStart ?? Date.now()}`;
        const idFromYaml = opts.id;
        const mapId =
          typeof idFromYaml === "string" && idFromYaml.trim()
            ? idFromYaml.trim()
            : defaultId;

        const markersPathRaw =
          typeof opts.markers === "string" ? opts.markers : undefined;

        const minZoom = responsive ? 1e-6 : parseZoomYaml(opts.minZoom, 0.25);
        const maxZoom = responsive ? 1e6 : parseZoomYaml(opts.maxZoom, 8);

        const markersPath = normalizePath(markersPathRaw ?? `${image}.markers.json`);

        const align = parseAlign(opts.align);
        const wrap = !!opts.wrap;

        const classesValue = opts.classes;
        const extraClasses: string[] = Array.isArray(classesValue)
          ? (classesValue as unknown[]).map((c) => String(c))
          : typeof classesValue === "string"
            ? classesValue
              .split(/\s+/)
              .map((c) => c.trim())
              .filter(Boolean)
            : [];

        const resizable = responsive
          ? false
          : typeof opts.resizable === "boolean"
            ? opts.resizable
            : this.settings.defaultResizable;

        const resizeHandle = responsive ? "right" : parseResizeHandle(opts.resizeHandle);

        const widthFromYaml = Object.prototype.hasOwnProperty.call(opts, "width");
        const heightFromYaml = Object.prototype.hasOwnProperty.call(opts, "height");

        const extSettings = this.settings as ZoomMapSettingsExtended;
        const widthDefault = wrap
          ? (extSettings.defaultWidthWrapped ?? "50%")
          : this.settings.defaultWidth;

        let widthCss = responsive ? "100%" : toCssSize(opts.width, widthDefault);
        let heightCss = responsive ? "auto" : toCssSize(opts.height, this.settings.defaultHeight);

        if (!responsive && storageMode === "json" && !widthFromYaml && !heightFromYaml) {
          const saved = await readSavedFrame(this.app, markersPath);
          if (saved) {
            widthCss = `${Math.max(220, saved.w)}px`;
            heightCss = `${Math.max(220, saved.h)}px`;
            el.style.width = widthCss;
            el.style.height = heightCss;
          }
        }

        const markerLayersFromYaml: string[] | undefined = Array.isArray(opts.markerLayers)
		  ? (opts.markerLayers as unknown[])
			  .map((v) => {
				if (typeof v === "string") {
				  return v.trim();
				}

				if (v && typeof v === "object" && "name" in v) {
				  const name = (v as { name?: unknown }).name;
				  return typeof name === "string" ? name.trim() : "";
				}

				return "";
			  })
			  .filter((s) => s.length > 0)
		  : undefined;

		const cfg: ZoomMapConfig = {
		  imagePath: image,
		  markersPath,
		  minZoom,
		  maxZoom,
		  sourcePath: ctx.sourcePath,
		  width: widthCss,
		  height: heightCss,
		  resizable,
		  resizeHandle,
		  align,
		  wrap,
		  extraClasses,
		  renderMode,
		  yamlBases,
		  yamlOverlays,
		  yamlMetersPerPixel,
		  sectionStart: sectionInfo?.lineStart,
		  sectionEnd: sectionInfo?.lineEnd,
		  widthFromYaml,
		  heightFromYaml,
		  storageMode,
		  mapId,
		  responsive,
		  yamlMarkerLayers: markerLayersFromYaml,
          displayOnly: !!opts.displayOnly,
		  initialZoom,
		  initialCenter,
          initialViewRect,
          viewportFrame: typeof opts.viewportFrame === "string" ? opts.viewportFrame.trim() : undefined,
          viewportFrameInsets: yamlFrameInsets,
		};

        const inst = new MapInstance(this.app, this, el, cfg);
        ctx.addChild(inst);
      },
    );

    this.addSettingTab(new ZoomMapSettingTab(this.app, this));
  }
  
  getIconDefaultLink(iconKey: string): string | undefined {
    const key = (iconKey ?? "").trim();
    if (!key) return undefined;
    const icon = this.settings.icons?.find((i) => i.key === key);
    const raw = icon?.defaultLink;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed.length ? trimmed : undefined;
  }

  private getEnabledTravelPacks(): TravelRulesPack[] {
    const packsRaw = this.settings.travelRulesPacks ?? [];
    const packs = packsRaw.filter((p): p is TravelRulesPack => {
      if (!p || typeof p !== "object") return false;
      if (Array.isArray(p)) return false;
      const r = p as Record<string, unknown>;
      return typeof r.id === "string";
    });
    return packs.filter((p) => p.enabled === true);
  }

  getActiveCustomUnits(): CustomUnitDef[] {
    const packs = this.getEnabledTravelPacks();
    return packs.flatMap((p) => p.customUnits ?? []);
  }
  
  getActiveTerrains(): TerrainDef[] {
    const packs = this.getEnabledTravelPacks();
    return packs.flatMap((p) => p.terrains ?? []);
  }

  getActiveTravelTimePresets(): TravelTimePreset[] {
    const packs = this.getEnabledTravelPacks();
    return packs.flatMap((p) => p.travelTimePresets ?? []);
  }

  getActiveTravelPerDayPresets(): { presets: { id: string; name: string; value: number; unit: string }[]; packName?: string; multipleEnabled?: boolean } | null {
    const packs = this.getEnabledTravelPacks();
    if (packs.length === 0) return null;

    const first = packs[0];
    const presets = (first.travelPerDayPresets ?? []).filter((x) => !!x && typeof x.id === "string");
    return {
      presets,
      packName: first.name,
      multipleEnabled: packs.length > 1,
    };
  }
  
  onunload(): void {
	this.clearGlobalHoverPopoverSettings();
    this.imageCache?.clear();
    this.imageCache = null;
  }

  builtinIcon(): IconProfile {
    return (
      this.settings.icons[0] ?? {
        key: "builtin",
        pathOrDataUrl: svgPinDataUrl("#d23c3c"),
        size: 24,
        anchorX: 12,
        anchorY: 12,
		inCollections: true,
      }
    );
  }

  async loadSettings(): Promise<void> {
    const savedUnknown: unknown = await this.loadData();

    const merged: ZoomMapSettings = { ...DEFAULT_SETTINGS };
    if (isPlainObject(savedUnknown)) {
      Object.assign(merged, savedUnknown);
    }
    this.settings = merged;

    const ext = this.settings as ZoomMapSettingsExtended;
    this.settings.baseCollections ??= [];
    ext.defaultWidthWrapped ??= "50%";
    ext.libraryFilePath ??= "ZoomMap/library.json";
    ext.faFolderPath ??= "ZoomMap/SVGs";
    this.settings.customUnits ??= [];
	this.settings.travelTimePresets ??= [];
    this.settings.travelPerDay ??= { value: 8, unit: "h" };
    this.settings.travelRulesPacks ??= [];
	
    // Normalize travel packs (back-compat + safety defaults)
    if (Array.isArray(this.settings.travelRulesPacks)) {
      for (const p of this.settings.travelRulesPacks) {
        if (typeof p.enabled !== "boolean") {
          p.enabled = true;
        }

        p.customUnits ??= [];
		p.terrains ??= [];
        p.travelTimePresets ??= [];
        p.travelPerDay ??= { value: 8, unit: "h" };

        const perDay = p.travelPerDay;
        if (!Number.isFinite(perDay.value) || perDay.value <= 0) perDay.value = 8;
        perDay.unit = (perDay.unit ?? "").trim() || "h";
      }
    }

    // Migration: move legacy customUnits/travelTimePresets/travelPerDay into a default pack
    if ((this.settings.travelRulesPacks?.length ?? 0) === 0) {
      const legacyUnits = this.settings.customUnits ?? [];
      const legacyPresets = this.settings.travelTimePresets ?? [];
      const legacyPerDay = this.settings.travelPerDay ?? { value: 8, unit: "h" };

      // Only create the default pack if we have legacy content OR we want a default container.
      const shouldCreate = legacyUnits.length > 0 || legacyPresets.length > 0 || !!legacyPerDay;
      if (shouldCreate) {
        const pack: TravelRulesPack = {
          id: `trp-${Math.random().toString(36).slice(2, 8)}`,
          name: "Default travel rules",
          enabled: true,
          customUnits: legacyUnits,
          travelTimePresets: legacyPresets,
          travelPerDay: legacyPerDay,
        };
        this.settings.travelRulesPacks = [pack];
      }
    }
    if (!Number.isFinite(this.settings.travelPerDay.value) || this.settings.travelPerDay.value <= 0) {
      this.settings.travelPerDay.value = 8;
    }
    this.settings.travelPerDay.unit = (this.settings.travelPerDay.unit ?? "").trim() || "h";
	this.settings.enableTextLayers ??= false;
	this.settings.enableMeasurePro ??= false;
	this.settings.showLinkFileNameInTooltip ??= false;
	this.settings.enableGrid ??= false;
	this.settings.applyHoverPopoverSizeGlobally ??= false;
	
    this.settings.enableSessionImageCache ??= false;
    this.settings.sessionImageCacheMb ??= 512;
    this.settings.keepOverlaysLoaded ??= false;
    this.settings.preferCanvasImagesWhenCaching ??= false;
	this.settings.svgRasterMaxScale ??= 8;
	this.settings.showImageIconPreviewInSettings ??= false;
	this.settings.middleClickOpensLinkInNewTab ??= false;
    this.settings.enableSecondScreen ??= false;
    this.settings.secondScreenFolder ??= "ZoomMap/SecondScreen";
    // Icons: collection filter toggle
    for (const ico of (this.settings.icons ?? [])) {
      if (typeof (ico as { inCollections?: unknown }).inCollections !== "boolean") {
        (ico as { inCollections: boolean }).inCollections = true;
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
	this.applyGlobalHoverPopoverSettings();
    this.applyImageCacheSettings();
  }
  
  private applyImageCacheSettings(): void {
    const enabled = !!this.settings.enableSessionImageCache;
    if (!enabled) {
      this.imageCache?.clear();
      this.imageCache = null;
      return;
    }

    const mbRaw = this.settings.sessionImageCacheMb ?? 512;
    const mb = Number.isFinite(mbRaw) && mbRaw > 0 ? mbRaw : 512;
    const bytes = Math.round(mb * 1024 * 1024);

    if (!this.imageCache) {
      this.imageCache = new ImageCache(this.app, bytes);
    } else {
      this.imageCache.setMaxBytes(bytes);
    }
  } 

  /* -------- Library file (icons + collections) -------- */

  private async ensureFolder(path: string): Promise<void> {
    const folder = folderOf(path);
    if (!folder) return;
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
  }

  async saveLibraryToPath(path: string): Promise<void> {
    const p = normalizePath(path);
    const ext = this.settings as ZoomMapSettingsExtended;

    const payload: LibraryFileData = {
      version: 1,
      icons: this.settings.icons ?? [],
      baseCollections: this.settings.baseCollections ?? [],
	  travelRulesPacks: this.settings.travelRulesPacks ?? [],
      exportedAt: new Date().toISOString(),
    };

    try {
      await this.ensureFolder(p);
      const existing = this.app.vault.getAbstractFileByPath(p);
      const json = JSON.stringify(payload, null, 2);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, json);
      } else {
        await this.app.vault.create(p, json);
      }
      ext.libraryFilePath = p;
      await this.saveSettings();
      new Notice(`Library saved to ${p}`, 2000);
    } catch (e) {
      console.error("Save library failed", e);
      new Notice("Failed to save library.", 2500);
    }
  }

  async loadLibraryFromFile(file: TFile): Promise<void> {
    try {
      const raw = await this.app.vault.read(file);
      const obj: unknown = JSON.parse(raw);
      if (!isPlainObject(obj)) {
        new Notice("Invalid library file.", 2500);
        return;
      }

      const hasIcons = (x: unknown): x is { icons: unknown } =>
        isPlainObject(x) && "icons" in x;
      const hasBaseCollections = (x: unknown): x is { baseCollections: unknown } =>
        isPlainObject(x) && "baseCollections" in x;

      let icons: IconProfile[] = [];
      if (hasIcons(obj) && Array.isArray(obj.icons)) {
        icons = obj.icons as IconProfile[];
      }

      let cols: BaseCollection[] = [];
      if (hasBaseCollections(obj) && Array.isArray(obj.baseCollections)) {
        cols = obj.baseCollections as BaseCollection[];
      }

      this.settings.icons = icons;
      this.settings.baseCollections = cols;
      (this.settings as ZoomMapSettingsExtended).libraryFilePath = file.path;

      await this.saveSettings();
      new Notice(`Library loaded from ${file.path}`, 2000);
    } catch (e) {
      console.error("Load library failed", e);
      new Notice("Failed to load library.", 2500);
    }
  }

  async downloadFontAwesomeZip(): Promise<void> {
    const ext = this.settings as ZoomMapSettingsExtended;
    const folder = normalizePath(ext.faFolderPath?.trim() || "ZoomMap/SVGs");
    const zipPath = normalizePath(`${folder}/fontawesome-free.zip`);

    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }

      new Notice("Downloading font awesome free zip…", 2500);

      const res = await requestUrl({
        url: DEFAULT_FA_ZIP_URL,
        method: "GET",
      });

      // @ts-expect-error writeBinary is available on desktop adapters
      await this.app.vault.adapter.writeBinary(zipPath, res.arrayBuffer);

      new Notice(
        `Downloaded Font Awesome ZIP to ${zipPath}. Please unzip it so that SVG files are available in this folder.`,
        6000,
      );
    } catch (e) {
      console.error("Download Font Awesome ZIP failed", e);
      new Notice("Failed to download font awesome zip.", 4000);
    }
  }

  async downloadRpgAwesomeZip(): Promise<void> {
    const ext = this.settings as ZoomMapSettingsExtended;
    const folder = normalizePath(ext.faFolderPath?.trim() || "ZoomMap/SVGs");
    const zipPath = normalizePath(`${folder}/rpg-awesome.zip`);

    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }

      new Notice("Downloading rpg awesome SVG pack…", 2500);

      const res = await requestUrl({
        url: DEFAULT_RPG_ZIP_URL,
        method: "GET",
      });

      // @ts-expect-error writeBinary is available on desktop adapters
      await this.app.vault.adapter.writeBinary(zipPath, res.arrayBuffer);

      new Notice(
        `Downloaded RPG Awesome ZIP to ${zipPath}. Please unzip it so that the SVG files are available in this folder.`,
        6000,
      );
    } catch (e) {
      console.error("Download RPG Awesome ZIP failed", e);
      new Notice("Failed to download rpg awesome zip.", 4000);
    }
  }

  rescanSvgFolder(): number {
    const ext = this.settings as ZoomMapSettingsExtended;
    const folder = normalizePath(ext.faFolderPath?.trim() || "ZoomMap/SVGs");
    const files = this.app.vault.getFiles();
    const prefix = folder.endsWith("/") ? folder : folder + "/";

    const count = files.filter((f) => {
      if (f.extension?.toLowerCase() !== "svg") return false;
      return f.path === folder || f.path.startsWith(prefix);
    }).length;

    new Notice(
      `Found ${count} SVG files under ${folder}. They will be available in the “Add SVG icon” picker.`,
      4000,
    );
    return count;
  }
  
  private buildYamlFromViewConfig(cfg: ViewEditorConfig): string {
    const obj: Record<string, unknown> = {};

    const bases = (cfg.imageBases ?? []).filter(
      (b) => b.path && b.path.trim().length > 0,
    );
    if (bases.length > 0) {
      obj.imageBases = bases.map((b) =>
        b.name ? { path: b.path, name: b.name } : { path: b.path },
      );
    }

    const overlays = (cfg.overlays ?? []).filter(
	  (o) => o.path && o.path.trim().length > 0,
	);
	if (overlays.length > 0) {
	  obj.imageOverlays = overlays.map((o) => {
		const r: { path: string; name?: string; visible?: boolean } = {
		  path: o.path,
		};
		if (o.name) r.name = o.name;
		if (typeof o.visible === "boolean") r.visible = o.visible;
		return r;
	  });
	}

    let markersPath = cfg.markersPath?.trim();
    if ((!markersPath || !markersPath.length) && bases.length > 0) {
      const first = bases[0].path;
      const dot = first.lastIndexOf(".");
      const base = dot >= 0 ? first.slice(0, dot) : first;
      markersPath = `${base}.markers.json`;
    }
    if (markersPath) obj.markers = markersPath;

    if (cfg.markerLayers && cfg.markerLayers.length > 0) {
      obj.markerLayers = cfg.markerLayers
        .map((n) => n.trim())
        .filter((n) => n.length > 0);
    }

    obj.minZoom = cfg.minZoom;
    obj.maxZoom = cfg.maxZoom;
    obj.wrap = !!cfg.wrap;
    obj.responsive = !!cfg.responsive;

    if (cfg.useWidth && cfg.width && cfg.width.trim().length > 0) {
      obj.width = cfg.width;
    }
    if (cfg.useHeight && cfg.height && cfg.height.trim().length > 0) {
      obj.height = cfg.height;
    }

    obj.resizable = !!cfg.resizable;
    obj.resizeHandle = cfg.resizeHandle;
    obj.render = cfg.renderMode;
    if (cfg.align) obj.align = cfg.align;

    if (cfg.id && cfg.id.trim().length > 0) {
      obj.id = cfg.id.trim();
    }

    const frame = cfg.viewportFrame?.trim();
    if (frame) {
      obj.viewportFrame = frame;

      if (cfg.viewportFrameInsets) {
        obj.viewportFrameInsets = {
          unit: cfg.viewportFrameInsets.unit,
          top: cfg.viewportFrameInsets.top,
          right: cfg.viewportFrameInsets.right,
          bottom: cfg.viewportFrameInsets.bottom,
          left: cfg.viewportFrameInsets.left,
        };
      }
    }

    return stringifyYaml(obj).trimEnd();
  }
}

// tintSvgMarkup and ZoomMapSettingTab moved to settingsTab.ts
