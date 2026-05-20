import {
  PluginSettingTab,
  Setting,
  Notice,
  setIcon,
  TFile,
  normalizePath,
} from "obsidian";
import type { App } from "obsidian";
import type {
  ZoomMapSettings,
  IconProfile,
  BaseCollection,
} from "./map";
import {
  ZoomMapSettingsExtended,
  setCssProps,
  isCrossWindowHTMLElement,
} from "./main";
import { ImageFileSuggestModal } from "./iconFileSuggest";
import { CollectionEditorModal } from "./collectionsModals";
import { JsonFileSuggestModal } from "./jsonFileSuggest";
import { FaIconPickerModal } from "./faIconPickerModal";
import { PreferencesModal } from "./preferencesModal";
import { IconOutlineModal } from "./iconOutlineModal";
import { TravelRulesManagerModal } from "./travelRulesModals";

/** Minimal plugin interface used by the settings tab (avoids a circular import). */
export interface ZoomMapPluginRef {
  app: App;
  settings: ZoomMapSettingsExtended & { icons: IconProfile[]; collections?: BaseCollection[] };
  saveSettings(): Promise<void>;
  saveLibraryToPath(path: string): Promise<void>;
  loadLibraryFromFile(file: TFile): Promise<void>;
  rescanSvgFolder(): void;
  downloadFontAwesomeZip(): Promise<void>;
  downloadRpgAwesomeZip(): Promise<void>;
}

// ---------------------------------------------------------------------------

function tintSvgMarkup(svg: string, color: string): string {
  const c = color.trim();
  if (!c) return svg;

  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.querySelector("svg");
    if (!root) return svg;

    const inner = root.querySelector("#zm-inner") ?? root;
    const base = root.querySelector("#zm-base");
    const outline = root.querySelector("#zm-outline");

    const shapes = inner.querySelectorAll<SVGElement>("path, circle, rect, polygon, polyline, line, ellipse");
    let touched = false;

    shapes.forEach((el) => {
      if (base && base.contains(el)) return;
      if (outline && outline.contains(el)) return;

      const styleFill = (el as unknown as { style?: CSSStyleDeclaration }).style?.fill;
      const styleStroke = (el as unknown as { style?: CSSStyleDeclaration }).style?.stroke;
      const fillAttr = el.getAttribute("fill");
      const strokeAttr = el.getAttribute("stroke");

      const hasFill =
        (typeof styleFill === "string" && styleFill && styleFill.toLowerCase() !== "none") ||
        (typeof fillAttr === "string" && fillAttr && fillAttr.toLowerCase() !== "none");
      const hasStroke =
        (typeof styleStroke === "string" && styleStroke && styleStroke.toLowerCase() !== "none") ||
        (typeof strokeAttr === "string" && strokeAttr && strokeAttr.toLowerCase() !== "none");

      if (hasFill) {
        (el as unknown as { style: CSSStyleDeclaration }).style.fill = c;
        el.setAttribute("fill", c);
        touched = true;
      }
      if (hasStroke) {
        (el as unknown as { style: CSSStyleDeclaration }).style.stroke = c;
        el.setAttribute("stroke", c);
        touched = true;
      }
    });

    if (!touched) {
      (inner as SVGElement).setAttribute("fill", c);
    }

    return new XMLSerializer().serializeToString(root);
  } catch {
    return svg;
  }
}

/* ---------------- Settings Tab ---------------- */

export class ZoomMapSettingTab extends PluginSettingTab {
  plugin: ZoomMapPluginRef;

  private svgFileCache = new Map<string, string>();

  constructor(app: App, plugin: ZoomMapPluginRef) {
    super(app, plugin as never);
    this.plugin = plugin;
  }

  private async addFontAwesomeIcon(file: TFile): Promise<void> {
    try {
      const svg = await this.app.vault.read(file);
      const defaultColor = "#b0b0b0";
      const tinted = tintSvgMarkup(svg, defaultColor);
      const dataUrl =
        "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(tinted);

      const icons = this.plugin.settings.icons ?? [];

      let baseKey = file.name.replace(/\.svg$/i, "");
      baseKey = baseKey.replace(/\s+/g, "-");
      let key = baseKey;
      let idx = 1;
      while (icons.some((i) => i.key === key)) {
        key = `${baseKey}-${idx++}`;
      }

      icons.unshift({
        key,
        pathOrDataUrl: dataUrl,
        size: 24,
        anchorX: 12,
        anchorY: 12,
        defaultLink: "",
		inCollections: true,
      });

      this.plugin.settings.icons = icons;
      await this.plugin.saveSettings();
      this.display();
    } catch (e) {
      console.error("Zoom Map: failed to add Font Awesome icon", e);
      new Notice("Failed to add font awesome icon.", 2500);
    }
  }

  private async recolorIconSvg(icon: IconProfile, color: string): Promise<void> {
    const c = color.trim();
    if (!c) return;

    let svg: string | null = null;
    const src = icon.pathOrDataUrl ?? "";

    if (typeof src === "string" && src.startsWith("data:image/svg+xml")) {
      const idx = src.indexOf(",");
      if (idx >= 0) {
        try {
          const payload = src.slice(idx + 1);
          svg = decodeURIComponent(payload);
        } catch {
          svg = null;
        }
      }
    } else if (typeof src === "string" && src.toLowerCase().endsWith(".svg")) {
      const cached = this.svgFileCache.get(src);
      if (cached) {
        svg = cached;
      } else {
        const f = this.app.vault.getAbstractFileByPath(src);
        if (f instanceof TFile) {
          try {
            const text = await this.app.vault.read(f);
            this.svgFileCache.set(src, text);
            svg = text;
          } catch {
            svg = null;
          }
        }
      }
    }

    if (!svg) return;

    const tinted = tintSvgMarkup(svg, c);
    const dataUrl =
      "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(tinted);

    icon.pathOrDataUrl = dataUrl;
    await this.plugin.saveSettings();
  }

  private getSvgColorFromDataUrl(dataUrl: string): string | null {
    if (typeof dataUrl !== "string") return null;
    if (!dataUrl.startsWith("data:image/svg+xml")) return null;
    const idx = dataUrl.indexOf(",");
    if (idx < 0) return null;
    try {
      const payload = dataUrl.slice(idx + 1);
      const svg = decodeURIComponent(payload);

      const mFill = /fill="([^"]+)"/i.exec(svg);
      if (mFill) return mFill[1];

      const mStroke = /stroke="([^"]+)"/i.exec(svg);
      if (mStroke) return mStroke[1];

      return null;
    } catch {
      return null;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("zoommap-settings");
    containerEl.classList.toggle(
      "zoommap-settings--imgpreview",
      !!this.plugin.settings.showImageIconPreviewInSettings,
    );

    // Storage
    new Setting(containerEl).setName("Storage").setHeading();

    new Setting(containerEl)
      .setName("Storage location by default")
      .setDesc("Store marker data in JSON beside image, or inline in the note.")
      .addDropdown((d) => {
        d.addOption("json", "JSON file (beside image)");
        d.addOption("note", "Inside the note (hidden comment)");
        d.setValue(this.plugin.settings.storageDefault ?? "json");
        d.onChange((v) => {
          this.plugin.settings.storageDefault = v === "note" ? "note" : "json";
          void this.plugin.saveSettings();
        });
      });

    // Layout
    new Setting(containerEl).setName("Layout").setHeading();

    new Setting(containerEl)
      .setName("Default width when wrapped")
      .setDesc("Initial width if wrap: true and no width is set in the code block.")
      .addText((t) => {
        const ext = this.plugin.settings as ZoomMapSettingsExtended;
        t.setPlaceholder("50%");
        t.setValue(ext.defaultWidthWrapped ?? "50%");
        t.onChange((v) => {
          ext.defaultWidthWrapped = (v || "50%").trim();
          void this.plugin.saveSettings();
        });
      });

    // Interaction
    new Setting(containerEl).setName("Interaction").setHeading();

    new Setting(containerEl)
      .setName("Mouse wheel zoom factor")
      .setDesc("Multiplier per step. 1.1 = 10% per tick.")
      .addText((t) =>
        t
          .setPlaceholder("1.1")
          .setValue(String(this.plugin.settings.wheelZoomFactor))
          .onChange((v) => {
            const n = Number(v);
            if (!Number.isNaN(n) && n > 1.001 && n < 2.5) {
              this.plugin.settings.wheelZoomFactor = n;
              void this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Panning mouse button")
      .setDesc("Which mouse button pans the map?")
      .addDropdown((d) => {
        d.addOption("left", "Left");
        d.addOption("middle", "Middle");
		d.addOption("right", "Right");
        d.setValue(this.plugin.settings.panMouseButton ?? "left");
        d.onChange((v) => {
          const next =
            v === "left" || v === "middle" || v === "right"
              ? v
              : "left";
          this.plugin.settings.panMouseButton = next;
          void this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Hover popover size")
      .setDesc("Max width and height in pixels.")
      .addToggle((tg) =>
        tg.setValue(!!this.plugin.settings.applyHoverPopoverSizeGlobally).onChange((v) => {
          this.plugin.settings.applyHoverPopoverSizeGlobally = v;
          void this.plugin.saveSettings();
        }),
      )
      .addText((t) =>
        t
          .setPlaceholder("360")
          .setValue(String(this.plugin.settings.hoverMaxWidth))
          .onChange((v) => {
            const n = Number(v);
            if (!Number.isNaN(n) && n >= 200) {
              this.plugin.settings.hoverMaxWidth = n;
              void this.plugin.saveSettings();
            }
          }),
      )
      .addText((t) =>
        t
          .setPlaceholder("260")
          .setValue(String(this.plugin.settings.hoverMaxHeight))
          .onChange((v) => {
            const n = Number(v);
            if (!Number.isNaN(n) && n >= 120) {
              this.plugin.settings.hoverMaxHeight = n;
              void this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Force popovers without ctrl")
      .setDesc("Opens preview popovers on simple hover.")
      .addToggle((t) =>
        t.setValue(!!this.plugin.settings.forcePopoverWithoutModKey).onChange((v) => {
          this.plugin.settings.forcePopoverWithoutModKey = v;
          void this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Open editor when placing pin from menu")
      .setDesc("When enabled, placing a pin from the pins menu opens the marker editor.")
      .addToggle((t) =>
        t.setValue(!!this.plugin.settings.pinPlaceOpensEditor).onChange((v) => {
          this.plugin.settings.pinPlaceOpensEditor = v;
          void this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Preferences")
      .setDesc("Global defaults for marker creation and behavior.")
      .addButton((b) =>
        b.setButtonText("Open…").onClick(() => {
          new PreferencesModal(this.app, this.plugin).open();
        }),
      );

    // Ruler
    new Setting(containerEl).setName("Ruler").setHeading();

    const applyStyleToAll = () => {
      const color = (this.plugin.settings.measureLineColor ?? "var(--text-accent)").trim();
      const widthPx = Math.max(1, this.plugin.settings.measureLineWidth ?? 2);
      const uiDoc = this.plugin.app.workspace.containerEl.ownerDocument;
      const uiWin = uiDoc.defaultView;
      if (!uiWin) return;

      uiDoc.querySelectorAll(".zm-root").forEach((el) => {
        if (isCrossWindowHTMLElement(el, uiWin)) {
          setCssProps(el, {
            "--zm-measure-color": color,
            "--zm-measure-width": `${widthPx}px`,
          });
        }
      });
    };

    const colorRow = new Setting(containerEl)
      .setName("Line color")
      .setDesc("CSS color, e.g. #ff0055.");

    colorRow.addText((t) =>
      t
        .setPlaceholder("Default")
        .setValue(this.plugin.settings.measureLineColor ?? "var(--text-accent)")
        .onChange((v) => {
          this.plugin.settings.measureLineColor = v?.trim() || "var(--text-accent)";
          void this.plugin.saveSettings();
          applyStyleToAll();
        }),
    );

    const picker = colorRow.controlEl.createEl("input", {
      attr: {
        type: "color",
        style: "margin-left:8px; vertical-align: middle;",
      },
    });

    const setPickerFromValue = (val: string) => {
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(val)) picker.value = val;
      else picker.value = "#ff0000";
    };
    setPickerFromValue(this.plugin.settings.measureLineColor ?? "");
    picker.oninput = () => {
      this.plugin.settings.measureLineColor = picker.value;
      void this.plugin.saveSettings();
      applyStyleToAll();
    };

    new Setting(containerEl)
      .setName("Line width")
      .setDesc("Stroke width in pixels.")
      .addText((t) =>
        t
          .setPlaceholder("2")
          .setValue(String(this.plugin.settings.measureLineWidth ?? 2))
          .onChange((v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0 && n <= 20) {
              this.plugin.settings.measureLineWidth = n;
              void this.plugin.saveSettings();
              applyStyleToAll();
            }
          }),
      );

    // Travel rules
    new Setting(containerEl).setName("Travel rules").setHeading();
    new Setting(containerEl)
      .setName("Manage travel rules packs")
      .setDesc("Custom units + distance→time presets are managed in packs (import/export supported).")
      .addButton((b) =>
        b.setButtonText("Open…").onClick(() => {
          new TravelRulesManagerModal(this.app, this.plugin, () => {
            this.display();
          }).open();
        }),
      );

    /* ---------------- Collections ---------------- */

    new Setting(containerEl).setName("Collections (base-bound)").setHeading();

    const collectionsWrap = containerEl.createDiv();
    const renderCollections = () => {
      collectionsWrap.empty();

      const hint = collectionsWrap.createEl("div", {
        text: "Collections bundle pins, favorites and stickers for specific base images. Create a 'global' collection without bindings for items that should be available everywhere.",
      });
      hint.addClass("zoommap-collections-hint");

      const list = collectionsWrap.createDiv();
      const cols = this.plugin.settings.baseCollections ?? [];
      if (cols.length === 0) {
        list.createEl("div", { text: "No collections yet." });
      } else {
        cols.forEach((c) => {
          const row = list.createDiv({ cls: "zoommap-collections-row" });
          const left = row.createDiv();

          const name = left.createEl("div", { text: c.name || "(unnamed collection)" });
          name.addClass("zoommap-collections-name");

          const meta = left.createEl("div", {
            text:
              `${c.bindings?.basePaths?.length ?? 0} bases` +
              ` • ${c.include?.pinKeys?.length ?? 0} pins` +
              ` • ${c.include?.favorites?.length ?? 0} favorites` +
              ` • ${c.include?.stickers?.length ?? 0} stickers` +
              ` • ${c.include?.swapPins?.length ?? 0} swap pins`,
          });
          meta.addClass("zoommap-collections-meta");

          const edit = row.createEl("button", { text: "Edit" });
          edit.onclick = () => {
            new CollectionEditorModal(this.app, this.plugin, c, ({ updated, deleted }) => {
              if (deleted) {
                const arr = this.plugin.settings.baseCollections ?? [];
                const pos = arr.indexOf(c);
                if (pos >= 0) arr.splice(pos, 1);
                void this.plugin.saveSettings().then(() => renderCollections());
                return;
              }
              if (updated) {
                void this.plugin.saveSettings().then(() => renderCollections());
              }
            }).open();
          };

          const del = row.createEl("button", { text: "Delete" });
          del.onclick = () => {
            const arr = this.plugin.settings.baseCollections ?? [];
            const pos = arr.indexOf(c);
            if (pos >= 0) arr.splice(pos, 1);
            void this.plugin.saveSettings().then(() => renderCollections());
          };
        });
      }

      const actions = collectionsWrap.createDiv({ cls: "zoommap-collections-actions" });
      const add = actions.createEl("button", { text: "Add collection" });
      add.onclick = () => {
        const fresh: BaseCollection = {
          id: `col-${Math.random().toString(36).slice(2, 8)}`,
          name: "New Collection",
          bindings: { basePaths: [] },
          include: { pinKeys: [], favorites: [], stickers: [], swapPins: [], pingPins: [] },
        };

        new CollectionEditorModal(this.app, this.plugin, fresh, ({ updated, deleted }) => {
          if (deleted) return;
          if (updated) {
            this.plugin.settings.baseCollections = this.plugin.settings.baseCollections ?? [];
            this.plugin.settings.baseCollections.push(fresh);
            void this.plugin.saveSettings().then(() => renderCollections());
          }
        }).open();
      };
    };
    renderCollections();

    /* ---------------- Marker icons (library) ---------------- */

    new Setting(containerEl).setName("Marker icons (library)").setHeading();

    const libRow = new Setting(containerEl)
      .setName("Library file (icons + collections)")
      .setDesc("Save/load your icons and collections to/from a JSON file.");

    libRow.addText((t) => {
      const ext = this.plugin.settings as ZoomMapSettingsExtended;
      t.setPlaceholder("ZoomMap/library.json");
      t.setValue(ext.libraryFilePath ?? "ZoomMap/library.json");
      t.onChange((v) => {
        (this.plugin.settings as ZoomMapSettingsExtended).libraryFilePath =
          v.trim() || "ZoomMap/library.json";
        void this.plugin.saveSettings();
      });
    });

    libRow.addButton((b) =>
      b.setButtonText("Pick…").onClick(() => {
        new JsonFileSuggestModal(this.app, (file) => {
          (this.plugin.settings as ZoomMapSettingsExtended).libraryFilePath = file.path;
          void this.plugin.saveSettings().then(() => this.display());
        }).open();
      }),
    );

    libRow.addButton((b) =>
      b.setButtonText("Save now").onClick(() => {
        const p = (this.plugin.settings as ZoomMapSettingsExtended).libraryFilePath?.trim() ?? "ZoomMap/library.json";
        void this.plugin.saveLibraryToPath(p);
      }),
    );

    libRow.addButton((b) =>
      b.setButtonText("Load…").onClick(() => {
        new JsonFileSuggestModal(this.app, (file) => {
          void this.plugin.loadLibraryFromFile(file).then(() => this.display());
        }).open();
      }),
    );

	new Setting(containerEl).setName("SVG icon sources").setHeading();

    const svgFolderRow = new Setting(containerEl)
      .setName("SVG icon folder in vault")
      .setDesc("Folder that contains SVG packs.");

    svgFolderRow.addText((t) => {
      const ext = this.plugin.settings as ZoomMapSettingsExtended;
      t.setPlaceholder("e.g. ZoomMap/SVGs");
      t.setValue(ext.faFolderPath ?? "ZoomMap/SVGs");
      t.onChange((v) => {
        ext.faFolderPath = (v || "ZoomMap/SVGs").trim();
        void this.plugin.saveSettings();
      });
    });

    svgFolderRow.addButton((b) =>
      b.setButtonText("Ensure folder").onClick(() => {
        const ext = this.plugin.settings as ZoomMapSettingsExtended;
        const folder = normalizePath(ext.faFolderPath?.trim() || "ZoomMap/SVGs");
        if (!this.app.vault.getAbstractFileByPath(folder)) {
          void this.app.vault.createFolder(folder).then(() => {
            new Notice(`Created folder: ${folder}`, 2000);
          });
        } else {
          new Notice("Folder already exists.", 1500);
        }
      }),
    );

    svgFolderRow.addButton((b) =>
      b.setButtonText("Rescan icons").onClick(() => {
        this.plugin.rescanSvgFolder();
      }),
    );

    const svgDownloadRow = new Setting(containerEl)
      .setName("Download icon packs")
      .setDesc("Download common SVG packs into the configured folder.");

    svgDownloadRow.addButton((b) =>
      b.setButtonText("Download font awesome free").onClick(() => {
        void this.plugin.downloadFontAwesomeZip();
      }),
    );

    svgDownloadRow.addButton((b) =>
      b.setButtonText("Download rpg awesome").onClick(() => {
        void this.plugin.downloadRpgAwesomeZip();
      }),
    );

    type IconLinkSuggestion = { label: string; value: string };

    const buildLinkSuggestions = (): IconLinkSuggestion[] => {
      const files = this.app.vault.getFiles().filter((f) => f.extension?.toLowerCase() === "md");
      const suggestions: IconLinkSuggestion[] = [];

      const active = this.app.workspace.getActiveFile();
      const fromPath = active?.path ?? files[0]?.path ?? "";

      for (const file of files) {
        const baseLink = this.app.metadataCache.fileToLinktext(file, fromPath);
        suggestions.push({ label: baseLink, value: baseLink });

        const cache = this.app.metadataCache.getCache(file.path);
        const headings = cache?.headings ?? [];
        for (const h of headings) {
          const full = `${baseLink}#${h.heading}`;
          suggestions.push({ label: `${baseLink} › ${h.heading}`, value: full });
        }
      }

      return suggestions;
    };

    const allLinkSuggestions = buildLinkSuggestions();

    const attachLinkAutocomplete = (
      input: HTMLInputElement,
      getValue: () => string,
      setValue: (val: string) => void,
    ): void => {
      const wrapper = input.parentElement;
      if (!wrapper) return;

      wrapper.classList.add("zoommap-link-input-wrapper");
      const listEl = wrapper.createDiv({ cls: "zoommap-link-suggestions is-hidden" });

      const hide = () => listEl.classList.add("is-hidden");
      const show = () => listEl.classList.remove("is-hidden");

      const updateList = (query: string) => {
        const q = query.trim().toLowerCase();
        listEl.empty();
        if (!q) { hide(); return; }

        const matches = allLinkSuggestions
          .filter((s) => s.value.toLowerCase().includes(q) || s.label.toLowerCase().includes(q))
          .slice(0, 20);

        if (matches.length === 0) { hide(); return; }
        show();

        matches.forEach((s) => {
          const row = listEl.createDiv({ cls: "zoommap-link-suggestion-item" });
          row.setText(s.label);
          row.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            setValue(s.value);
            hide();
          });
        });
      };

      input.addEventListener("input", () => updateList(input.value));
      input.addEventListener("blur", () => { window.setTimeout(() => hide(), 150); });
      updateList(getValue());
    };

    const isSvgIcon = (icon: IconProfile): boolean => {
      const src = icon.pathOrDataUrl ?? "";
      if (typeof src !== "string") return false;
      const lower = src.toLowerCase();
      return lower.startsWith("data:image/svg+xml") || lower.endsWith(".svg");
    };

	new Setting(containerEl).setName("SVG icons").setHeading();

    const addSvgSetting = new Setting(containerEl)
      .setName("Add SVG icon or sort the list")
      .setDesc("Create a pin icon from an SVG file in the configured folder, or sort the SVG icon list alphabetically.");

    const infoIcon = addSvgSetting.controlEl.createDiv({ cls: "zoommap-info-icon" });
    setIcon(infoIcon, "info");
    infoIcon.setAttr(
      "title",
      "Rendering many SVG files in the picker can cause noticeable delays while all previews are generated. Once the icons are cached, searching and adding should feel much faster.",
    );

    addSvgSetting.addButton((b) =>
      b.setButtonText("Sort a→z").onClick(() => {
        const icons = this.plugin.settings.icons ?? [];
        if (icons.length === 0) return;

        const svgIcons = icons.filter((i) => isSvgIcon(i));
        if (svgIcons.length <= 1) { new Notice("No SVG icons to sort.", 2000); return; }

        const keyOf = (i: IconProfile) => String(i.key ?? "").trim();
        const sorted = [...svgIcons].sort((a, b) =>
          keyOf(a).localeCompare(keyOf(b), undefined, { sensitivity: "base", numeric: true }),
        );

        let j = 0;
        const next = icons.map((ico) => (isSvgIcon(ico) ? sorted[j++] : ico));
        this.plugin.settings.icons = next;
        void this.plugin.saveSettings().then(() => {
          renderIcons?.();
          new Notice(`Sorted ${sorted.length} SVG icons.`, 2000);
        });
      }),
    );

    addSvgSetting.addButton((b) =>
      b.setButtonText("Add SVG icon").onClick(() => {
        const ext = this.plugin.settings as ZoomMapSettingsExtended;
        const folder = ext.faFolderPath?.trim() || "ZoomMap/SVGs";
        new FaIconPickerModal(this.app, folder, (file: TFile) => {
          void this.addFontAwesomeIcon(file);
        }).open();
      }),
    );

    const svgIconsHead = containerEl.createDiv({ cls: "zm-icons-grid-head zm-grid" });
	svgIconsHead.createSpan();
    svgIconsHead.createSpan({ text: "Name" });
    svgIconsHead.createSpan({ text: "Preview / color / link" });
    svgIconsHead.createSpan({ text: "Size" });

    const headSvgAX = svgIconsHead.createSpan({ cls: "zm-icohead" });
    const svgAxIco = headSvgAX.createSpan();
    setIcon(svgAxIco, "anchor");
    headSvgAX.appendText(" X");

    const headSvgAY = svgIconsHead.createSpan({ cls: "zm-icohead" });
    const svgAyIco = headSvgAY.createSpan();
    setIcon(svgAyIco, "anchor");
    headSvgAY.appendText(" Y");

    svgIconsHead.createSpan({ text: "Angle" });

    const headSvgTrash = svgIconsHead.createSpan();
    setIcon(headSvgTrash, "trash");

    const svgIconsGrid = containerEl.createDiv({ cls: "zm-icons-grid zm-grid" });

    new Setting(containerEl).setName("Image icons").setHeading();

    new Setting(containerEl)
      .setName("Add new icon or sort the list")
      .setDesc("Create a new image-based icon entry, or sort the image icon list alphabetically.")
      .addButton((b) =>
        b.setButtonText("Sort a→z").onClick(() => {
          const icons = this.plugin.settings.icons ?? [];
          if (icons.length === 0) return;

          const imgIcons = icons.filter((i) => !isSvgIcon(i));
          if (imgIcons.length <= 1) { new Notice("No image icons to sort.", 2000); return; }

          const keyOf = (i: IconProfile) => String(i.key ?? "").trim();
          const sorted = [...imgIcons].sort((a, b) =>
            keyOf(a).localeCompare(keyOf(b), undefined, { sensitivity: "base", numeric: true }),
          );

          let j = 0;
          const next = icons.map((ico) => (isSvgIcon(ico) ? ico : sorted[j++]));
          this.plugin.settings.icons = next;
          void this.plugin.saveSettings().then(() => {
            renderIcons?.();
            new Notice(`Sorted ${sorted.length} image icons.`, 2000);
          });
        }),
      )
      .addButton((b) =>
        b.setButtonText("Add").onClick(() => {
          const idx = this.plugin.settings.icons.length + 1;
          this.plugin.settings.icons.unshift({
            key: `pin-${idx}`,
            pathOrDataUrl: "",
            size: 24,
            anchorX: 12,
            anchorY: 12,
			inCollections: true,
          });
          void this.plugin.saveSettings();
          renderIcons?.();
        }),
      );

    const imgIconsHead = containerEl.createDiv({ cls: "zm-icons-grid-head zm-grid zm-icons-grid-head--img" });
	imgIconsHead.createSpan();
    imgIconsHead.createSpan({ text: "Name" });
    if (this.plugin.settings.showImageIconPreviewInSettings) {
      imgIconsHead.createSpan();
    }
    imgIconsHead.createSpan({ text: "Path / data:URL + default link" });
    imgIconsHead.createSpan({ text: "Size" });

    const headImgAX = imgIconsHead.createSpan({ cls: "zm-icohead" });
    const axIco = headImgAX.createSpan();
    setIcon(axIco, "anchor");
    headImgAX.appendText(" X");

    const headImgAY = imgIconsHead.createSpan({ cls: "zm-icohead" });
    const ayIco = headImgAY.createSpan();
    setIcon(ayIco, "anchor");
    headImgAY.appendText(" Y");

    imgIconsHead.createSpan({ text: "Angle" });

    const headImgTrash = imgIconsHead.createSpan();
    setIcon(headImgTrash, "trash");

    const imgIconsGrid = containerEl.createDiv({ cls: "zm-icons-grid zm-grid zm-icons-grid--img" });

	let renderIcons: () => void;

    renderIcons = () => {
      svgIconsGrid.empty();
      imgIconsGrid.empty();

      for (const icon of this.plugin.settings.icons) {
        if (isSvgIcon(icon)) {
          const row = svgIconsGrid.createDiv({ cls: "zm-row" });

          const enabled = row.createEl("input", { type: "checkbox" });
          enabled.addClass("zoommap-settings__icon-collections-toggle");
          enabled.checked = icon.inCollections !== false;
          enabled.onchange = () => {
            icon.inCollections = enabled.checked;
            void this.plugin.saveSettings();
          };

          const name = row.createEl("input", { type: "text" });
          name.classList.add("zm-name");
          name.value = icon.key;
          name.oninput = () => {
            icon.key = name.value.trim();
            void this.plugin.saveSettings();
          };

          const previewCell = row.createDiv({ cls: "zoommap-settings__preview-cell" });

          const img = previewCell.createEl("img");
          img.addClass("zoommap-settings__icon-preview");

          let src = icon.pathOrDataUrl ?? "";
          if (typeof src === "string" && !src.startsWith("data:") && src) {
            const f = this.app.vault.getAbstractFileByPath(src);
            if (f instanceof TFile) src = this.app.vault.getResourcePath(f);
          }
          img.src = typeof src === "string" ? src : "";

          const applyRotationPreview = () => {
            const deg = icon.rotationDeg ?? 0;
            setCssProps(img, { transform: deg ? `rotate(${deg}deg)` : null });
          };
          applyRotationPreview();

          const rawSrc = icon.pathOrDataUrl ?? "";
          const isSvgData = typeof rawSrc === "string" && rawSrc.startsWith("data:image/svg+xml");
          let currentColor = "";
          if (isSvgData) {
            const c = this.getSvgColorFromDataUrl(rawSrc);
            if (c) currentColor = c;
          }

          const colorInput = previewCell.createEl("input", { type: "text" });
          colorInput.addClass("zoommap-settings__color-input");
          colorInput.placeholder = "Color";
          colorInput.value = currentColor;

          const colorPicker = previewCell.createEl("input", { type: "color" });
          colorPicker.addClass("zoommap-settings__color-picker");

          if (currentColor && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(currentColor)) {
            if (currentColor.length === 4) {
              const r = currentColor[1], g = currentColor[2], b = currentColor[3];
              colorPicker.value = `#${r}${r}${g}${g}${b}${b}`;
            } else {
              colorPicker.value = currentColor;
            }
          }

          const applyColor = (val: string) => {
            const c = val.trim();
            if (!c) return;
            void this.recolorIconSvg(icon, c).then(() => {
              const updated = icon.pathOrDataUrl ?? "";
              let out = updated;
              if (typeof out === "string" && !out.startsWith("data:") && out) {
                const f = this.app.vault.getAbstractFileByPath(out);
                if (f instanceof TFile) out = this.app.vault.getResourcePath(f);
              }
              img.src = typeof out === "string" ? out : "";
            });
          };

          colorInput.addEventListener("change", () => {
            const val = colorInput.value;
            applyColor(val);
            if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(val)) {
              if (val.length === 4) {
                const r = val[1], g = val[2], b = val[3];
                colorPicker.value = `#${r}${r}${g}${g}${b}${b}`;
              } else {
                colorPicker.value = val;
              }
            }
          });

          colorPicker.addEventListener("input", () => {
            const hex = colorPicker.value;
            colorInput.value = hex;
            applyColor(hex);
          });

          const linkInput = previewCell.createEl("input", { type: "text" });
          linkInput.addClass("zoommap-settings__link-input--small");
          linkInput.placeholder = "Default link (optional)";
          linkInput.value = icon.defaultLink ?? "";
          linkInput.oninput = () => {
            icon.defaultLink = linkInput.value.trim() || undefined;
            void this.plugin.saveSettings();
          };

          attachLinkAutocomplete(
            linkInput,
            () => icon.defaultLink ?? "",
            (val) => { icon.defaultLink = val; linkInput.value = val; void this.plugin.saveSettings(); },
          );

		  const outlineBtn = previewCell.createEl("button", { attr: { title: "SVG outline…" } });
		  outlineBtn.classList.add("zm-icon-btn");
		  setIcon(outlineBtn, "gear");
		  outlineBtn.onclick = () => {
			new IconOutlineModal(this.app, this.plugin, icon, (newDataUrl) => {
			    img.src = newDataUrl;
			}).open();
		  };

          const size = row.createEl("input", { type: "number" });
          size.classList.add("zm-num");
          size.value = String(icon.size);
          size.oninput = () => {
            const n = Number(size.value);
            if (!Number.isNaN(n) && n > 0) { icon.size = n; void this.plugin.saveSettings(); }
          };

          const ax = row.createEl("input", { type: "number" });
          ax.classList.add("zm-num");
          ax.value = String(icon.anchorX);
          ax.oninput = () => {
            const n = Number(ax.value);
            if (!Number.isNaN(n)) { icon.anchorX = n; void this.plugin.saveSettings(); }
          };

          const ay = row.createEl("input", { type: "number" });
          ay.classList.add("zm-num");
          ay.value = String(icon.anchorY);
          ay.oninput = () => {
            const n = Number(ay.value);
            if (!Number.isNaN(n)) { icon.anchorY = n; void this.plugin.saveSettings(); }
          };

          const angle = row.createEl("input", { type: "number" });
          angle.classList.add("zm-num");
          angle.value = String(icon.rotationDeg ?? 0);
          angle.oninput = () => {
            const n = Number(angle.value);
            if (!Number.isNaN(n)) {
              icon.rotationDeg = n || 0;
              void this.plugin.saveSettings();
              applyRotationPreview();
            }
          };

          const del = row.createEl("button", { attr: { title: "Delete" } });
          del.classList.add("zm-icon-btn");
          setIcon(del, "trash");
          del.onclick = () => {
            this.plugin.settings.icons = this.plugin.settings.icons.filter((i) => i !== icon);
            void this.plugin.saveSettings();
            renderIcons();
          };
        } else {
          const row = imgIconsGrid.createDiv({ cls: "zm-row" });

          const enabled = row.createEl("input", { type: "checkbox" });
          enabled.addClass("zoommap-settings__icon-collections-toggle");
          enabled.checked = icon.inCollections !== false;
          enabled.onchange = () => {
            icon.inCollections = enabled.checked;
            void this.plugin.saveSettings();
          };

          const name = row.createEl("input", { type: "text" });
          name.classList.add("zm-name");
          name.value = icon.key;
          name.oninput = () => {
            icon.key = name.value.trim();
            void this.plugin.saveSettings();
          };

          const showPreview = !!this.plugin.settings.showImageIconPreviewInSettings;
          let previewImg: HTMLImageElement | null = null;
          const refreshPreview = () => {
            if (!previewImg) return;
            let src = (icon.pathOrDataUrl ?? "").trim();
            if (!src) { previewImg.src = ""; return; }
            if (src.startsWith("data:")) { previewImg.src = src; return; }
            const f = this.app.vault.getAbstractFileByPath(src);
            if (f instanceof TFile) { previewImg.src = this.app.vault.getResourcePath(f); return; }
            previewImg.src = src;
          };

          if (showPreview) {
            previewImg = row.createEl("img", { cls: "zoommap-settings__icon-preview zoommap-settings__icon-preview--img" });
            refreshPreview();
          }

          const pathWrap = row.createDiv({ cls: "zm-path-wrap" });

          const path = pathWrap.createEl("input", { type: "text" });
          path.addClass("zoommap-settings__icon-path-input");
          path.value = icon.pathOrDataUrl ?? "";
          path.oninput = () => {
            icon.pathOrDataUrl = path.value.trim();
            void this.plugin.saveSettings();
			refreshPreview();
          };

          const pick = pathWrap.createEl("button", { attr: { title: "Choose file…" } });
          pick.classList.add("zm-icon-btn");
          setIcon(pick, "folder-open");
          pick.onclick = () => {
            new ImageFileSuggestModal(this.app, (file: TFile) => {
              icon.pathOrDataUrl = file.path;
              void this.plugin.saveSettings();
              path.value = file.path;
              refreshPreview();
              renderIcons();
            }).open();
          };

          const linkInput = pathWrap.createEl("input", { type: "text" });
          linkInput.addClass("zoommap-settings__link-input--medium");
          linkInput.placeholder = "Default link (optional)";
          linkInput.value = icon.defaultLink ?? "";
          linkInput.oninput = () => {
            icon.defaultLink = linkInput.value.trim() || undefined;
            void this.plugin.saveSettings();
          };

          attachLinkAutocomplete(
            linkInput,
            () => icon.defaultLink ?? "",
            (val) => { icon.defaultLink = val; linkInput.value = val; void this.plugin.saveSettings(); },
          );

          const size = row.createEl("input", { type: "number" });
          size.classList.add("zm-num");
          size.value = String(icon.size);
          size.oninput = () => {
            const n = Number(size.value);
            if (!Number.isNaN(n) && n > 0) { icon.size = n; void this.plugin.saveSettings(); }
          };

          const ax = row.createEl("input", { type: "number" });
          ax.classList.add("zm-num");
          ax.value = String(icon.anchorX);
          ax.oninput = () => {
            const n = Number(ax.value);
            if (!Number.isNaN(n)) { icon.anchorX = n; void this.plugin.saveSettings(); }
          };

          const ay = row.createEl("input", { type: "number" });
          ay.classList.add("zm-num");
          ay.value = String(icon.anchorY);
          ay.oninput = () => {
            const n = Number(ay.value);
            if (!Number.isNaN(n)) { icon.anchorY = n; void this.plugin.saveSettings(); }
          };

          const angle = row.createEl("input", { type: "number" });
          angle.classList.add("zm-num");
          angle.value = String(icon.rotationDeg ?? 0);
          angle.oninput = () => {
            const n = Number(angle.value);
            if (!Number.isNaN(n)) { icon.rotationDeg = n || 0; void this.plugin.saveSettings(); }
          };

          const del = row.createEl("button", { attr: { title: "Delete" } });
          del.classList.add("zm-icon-btn");
          setIcon(del, "trash");
          del.onclick = () => {
            this.plugin.settings.icons = this.plugin.settings.icons.filter((i) => i !== icon);
            void this.plugin.saveSettings();
            renderIcons();
          };
        }
      }
    };

    renderIcons();
  }
}
