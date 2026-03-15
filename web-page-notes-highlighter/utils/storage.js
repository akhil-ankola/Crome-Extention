// utils/storage.js — Shared storage utilities

const Storage = {
  // ── Notes ─────────────────────────────────────────────────
  async getNotes() {
    return new Promise(resolve => {
      chrome.storage.local.get('notes', data => resolve(data.notes || {}));
    });
  },

  async getNote(url) {
    const notes = await this.getNotes();
    return notes[url] || null;
  },

  async saveNote(url, title, text) {
    const notes = await this.getNotes();
    const now = new Date().toISOString();
    const existing = notes[url];
    notes[url] = {
      title,
      note: text,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    return new Promise(resolve => {
      chrome.storage.local.set({ notes }, resolve);
    });
  },

  async deleteNote(url) {
    const notes = await this.getNotes();
    delete notes[url];
    return new Promise(resolve => {
      chrome.storage.local.set({ notes }, resolve);
    });
  },

  // ── Highlights ────────────────────────────────────────────
  async getHighlights() {
    return new Promise(resolve => {
      chrome.storage.local.get('highlights', data => resolve(data.highlights || {}));
    });
  },

  async getHighlightsForUrl(url) {
    const highlights = await this.getHighlights();
    return highlights[url] || [];
  },

  async saveHighlight(url, highlight) {
    const highlights = await this.getHighlights();
    if (!highlights[url]) highlights[url] = [];
    highlight.id = highlight.id || Date.now().toString();
    highlight.createdAt = highlight.createdAt || new Date().toISOString();
    highlights[url].push(highlight);
    return new Promise(resolve => {
      chrome.storage.local.set({ highlights }, () => resolve(highlight.id));
    });
  },

  async updateHighlight(url, id, updates) {
    const highlights = await this.getHighlights();
    if (!highlights[url]) return;
    const idx = highlights[url].findIndex(h => h.id === id);
    if (idx !== -1) {
      highlights[url][idx] = { ...highlights[url][idx], ...updates };
      return new Promise(resolve => {
        chrome.storage.local.set({ highlights }, resolve);
      });
    }
  },

  async deleteHighlight(url, id) {
    const highlights = await this.getHighlights();
    if (!highlights[url]) return;
    highlights[url] = highlights[url].filter(h => h.id !== id);
    if (highlights[url].length === 0) delete highlights[url];
    return new Promise(resolve => {
      chrome.storage.local.set({ highlights }, resolve);
    });
  },

  // ── Settings ──────────────────────────────────────────────
  async getSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get('settings', data => resolve(data.settings || {
        theme: 'light',
        indicator: 'badge'
      }));
    });
  },

  async saveSettings(settings) {
    return new Promise(resolve => {
      chrome.storage.local.set({ settings }, resolve);
    });
  },

  // ── Export / Import ───────────────────────────────────────
  async exportAll() {
    return new Promise(resolve => {
      chrome.storage.local.get(['notes', 'highlights'], data => resolve(data));
    });
  },

  async importAll(data) {
    return new Promise(resolve => {
      const toSet = {};
      if (data.notes) toSet.notes = data.notes;
      if (data.highlights) toSet.highlights = data.highlights;
      chrome.storage.local.set(toSet, resolve);
    });
  },

  async deleteAll() {
    return new Promise(resolve => {
      chrome.storage.local.remove(['notes', 'highlights'], resolve);
    });
  },

  // ── Helpers ───────────────────────────────────────────────
  sanitize(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
};
