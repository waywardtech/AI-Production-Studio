// Every read and write the panel makes.
//
// This is the CORE-4 seam: swapping these for Drive API calls is what
// wires the real repository in, and nothing outside this file needs to
// change when that happens.

export async function getLibrary() {
  const { library } = await chrome.storage.local.get('library');
  return library || [];
}

export async function saveLibrary(library) {
  await chrome.storage.local.set({ library });
}

export async function getResponses() {
  const { responses } = await chrome.storage.local.get('responses');
  return responses || [];
}

export async function saveResponses(responses) {
  await chrome.storage.local.set({ responses });
}

export async function getStoredBlockTypes() {
  const { blockTypes } = await chrome.storage.local.get('blockTypes');
  return blockTypes || null;
}

export async function saveBlockTypes(blockTypes) {
  await chrome.storage.local.set({ blockTypes });
}

export async function getRememberedValues() {
  const { variableValues } = await chrome.storage.local.get('variableValues');
  return variableValues || {};
}

export async function saveRememberedValues(variableValues) {
  await chrome.storage.local.set({ variableValues });
}

// Tab labels live in storage.session, not storage.local, and that's
// deliberate. They're keyed by Chrome tab ID, and tab IDs are only
// unique within a single browser session — Chrome hands the same IDs
// out again after a restart. Persisting them to storage.local meant a
// label saved against tab 42 today would reappear on an unrelated tab
// 42 tomorrow, quietly mislabelling a destination. storage.session is
// cleared when the browser closes, which matches M1-6's "labels persist
// per tab session" acceptance criterion exactly and makes the ID reuse
// unreachable. (Labels that survive a restart would need a stable key
// such as the conversation URL — that's a feature, not this fix.)

export async function getTabLabels() {
  const { tabLabels } = await chrome.storage.session.get('tabLabels');
  return tabLabels || {};
}

export async function saveTabLabels(tabLabels) {
  await chrome.storage.session.set({ tabLabels });
}
