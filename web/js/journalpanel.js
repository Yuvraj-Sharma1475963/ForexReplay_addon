// The journal box under the trade lists: the note, tags and screenshots of the trade you picked.
//
// It is rebuilt only when you pick another trade or its tags or pictures change, never on
// every candle, so typing a note is not interrupted while the replay plays.

import { MAX_NOTE } from "./tradenotes.js";
import { canonicalTag, GROUPS, groupOf, loadTagSets, saveTagSets, setsToText, textToList } from "./tagsets.js";

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const KEY_AUTO = "forexreplay.autoscreenshots";

export class JournalPanel {
  /**
   * @param {HTMLElement} root  the journal section
   * @param {object} options { notes: TradeNotes, describe(id) -> "#3 BUY · +1.20R" or null,
   *   journal() -> current journal name or null, onScreenshot(id), onRemoveScreenshot(id, name), onPick(id) }
   */
  constructor(root, { notes, describe, journal, onScreenshot, onRemoveScreenshot, onPick, store }) {
    this.store = store;
    this.root = root;
    this.notes = notes;
    this.describe = describe;
    this.journal = journal;
    this.onPick = onPick || (() => {});
    this.id = null;
    this.el = (id) => root.querySelector(`#${id}`);
    this.noteBox = this.el("journal-note");
    this.noteBox.maxLength = MAX_NOTE;

    this.typing = null; // a note waiting to be saved
    this.noteBox.addEventListener("input", () => { // saved a moment after you stop typing
      clearTimeout(this.typing);
      const id = this.id;
      this.typing = setTimeout(() => { this.typing = null; if (id === this.id) this.saveNote(); }, 400);
    });
    this.noteBox.addEventListener("blur", () => this.saveNote());
    this.sets = loadTagSets();
    this.el("journal-tags").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-tag]");
      if (chip && this.id !== null) this.toggle(chip.dataset.tag);
    });
    this.el("journal-tag-input").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || this.id === null) return;
      event.preventDefault();
      const tag = canonicalTag(event.target.value, this.sets, this.notes.tagChoices()); // "ob retest" becomes "OB retest"
      event.target.value = "";
      if (tag && !this.notes.get(this.id).tags.includes(tag)) this.toggle(tag);
    });
    this.setupTagLists();
    this.el("journal-shot").addEventListener("click", () => { if (this.id !== null) onScreenshot(this.id); });
    this.el("journal-shots").addEventListener("click", (event) => {
      const x = event.target.closest("[data-remove]");
      if (x && this.id !== null) { event.preventDefault(); onRemoveScreenshot(this.id, x.dataset.remove); }
    });
    const auto = this.el("journal-auto");
    if (!store.screenshots) { // online: no screenshots (browser storage is too small for pictures)
      this.el("journal-shot").hidden = true;
      const label = auto.closest("label");
      label.hidden = true;
      const note = document.createElement("p");
      note.className = "muted small";
      note.textContent = "Screenshots are kept only in the desktop app.";
      label.after(note);
    }
    auto.checked = this.autoScreenshots;
    auto.addEventListener("change", () => {
      try { localStorage.setItem(KEY_AUTO, auto.checked ? "on" : "off"); } catch { /* private mode: not kept */ }
    });
    this.render();
  }

  /** Screenshots at entry and exit are taken automatically unless this is switched off. */
  get autoScreenshots() {
    if (!this.store.screenshots) return false;
    try { return localStorage.getItem(KEY_AUTO) !== "off"; } catch { return true; }
  }

  /** Save the text box now if it differs from what is stored. */
  saveNote() {
    clearTimeout(this.typing);
    this.typing = null;
    if (this.id !== null && this.noteBox.value !== this.notes.get(this.id).note) this.notes.setNote(this.id, this.noteBox.value);
  }

  /** Show this trade's journal (null: none). */
  pick(id) {
    this.saveNote();
    this.id = id;
    this.onPick(id);
    this.render();
  }

  /** The notes changed: redraw tags and pictures; leave the text box alone while it is being typed in. */
  refresh() {
    if (this.id !== null && !this.describe(this.id)) { this.pick(null); return; } // the trade is gone (a new run)
    this.render(document.activeElement === this.noteBox || this.typing !== null); // never wipe text not yet saved
  }

  render(keepText = false) {
    const id = this.id;
    const title = id === null ? null : this.describe(id);
    this.el("journal-editor").hidden = !title;
    this.el("journal-empty").hidden = !!title;
    this.el("journal-title").textContent = title || "";
    if (!title) return;
    const entry = this.notes.get(id);
    if (!keepText) this.noteBox.value = entry.note;
    const chip = (t) => `<button class="chip${entry.tags.includes(t) ? " on" : ""}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`;
    const other = [...new Set([...this.notes.tagChoices(), ...entry.tags])].filter((t) => !groupOf(t, this.sets));
    this.el("journal-tags").innerHTML = GROUPS.map((g) => `<div class="tag-group"><span class="tag-group-label">${g.label}${g.single ? " (one)" : ""}</span>${this.sets[g.id].map(chip).join("")}</div>`).join("") +
      (other.length ? `<div class="tag-group"><span class="tag-group-label">Other</span>${other.map(chip).join("")}</div>` : "");
    const journal = this.journal();
    this.el("journal-shots").innerHTML = !journal ? "" : entry.screenshots.map((name) => {
      const url = this.store.screenshotUrl(journal, name);
      const kind = name.includes("-entry") ? "entry" : name.includes("-exit") ? "exit" : "added";
      return `<a class="shot" href="${url}" target="_blank" rel="noopener" title="Open full size (${kind})">` +
        `<img src="${url}" alt="Chart at ${kind}" loading="lazy"><span>${kind}</span>` +
        `<b data-remove="${escapeHtml(name)}" title="Remove this screenshot">&times;</b></a>`;
    }).join("");
  }

  /** Tag or untag the picked trade. A grade replaces the trade's other grade. */
  toggle(tag) {
    const id = this.id;
    const group = GROUPS.find((g) => g.id === groupOf(tag, this.sets));
    const on = this.notes.get(id).tags.includes(tag);
    if (group && group.single && !on) {
      for (const t of this.notes.get(id).tags) if (groupOf(t, this.sets) === group.id) this.notes.toggleTag(id, t);
    }
    this.notes.toggleTag(id, tag);
  }

  /** "Edit tag lists": the four lists, comma separated. */
  setupTagLists() {
    const dialog = document.getElementById("tags-dialog");
    if (!dialog) return;
    const open = this.el("journal-tag-lists");
    open.addEventListener("click", () => {
      const text = setsToText(this.sets);
      for (const g of GROUPS) dialog.querySelector(`[data-tagset="${g.id}"]`).value = text[g.id];
      dialog.showModal();
    });
    dialog.querySelector("#tags-save").addEventListener("click", () => {
      const raw = Object.fromEntries(GROUPS.map((g) => [g.id, textToList(dialog.querySelector(`[data-tagset="${g.id}"]`).value)]));
      this.sets = saveTagSets(raw);
      dialog.close();
      if (this.id !== null) this.render(true);
    });
    dialog.querySelector("#tags-reset").addEventListener("click", () => {
      const text = setsToText(saveTagSets(null));
      for (const g of GROUPS) dialog.querySelector(`[data-tagset="${g.id}"]`).value = text[g.id];
    });
    dialog.querySelector("#tags-close").addEventListener("click", () => dialog.close());
  }
}
