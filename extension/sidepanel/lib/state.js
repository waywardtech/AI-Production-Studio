// Shared mutable panel state.
//
// One object rather than exported `let` bindings: modules need to
// replace these wholesale (canvasBlocks after a load, detectedTabs
// after a refresh), and an imported binding can't be reassigned from
// outside the module that declares it.

export const state = {
  projectId: null, // the active project — follows es:settings:app.activeProjectId
  projectName: '',
  canvasBlocks: [], // { id, type, text }
  blockTypes: [], // { id, label }
  detectedTabs: [], // { id, title, url, windowId, platform }
  tabLabels: {}, // { [tabId]: label }
  selectedTabIds: new Set(),
  captures: [], // staged, unsaved: { id, tabId, label, kind, text, url, capturedAt }
  activeTagFilter: null, // null = all tags
  attachmentAssetIds: new Set(), // files to send with the next Insert
  usage: { services: [] }, // { id, label, platform, unit, used, limit, thresholdPct, updatedAt, source }
};

export function newBlockId(type) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
