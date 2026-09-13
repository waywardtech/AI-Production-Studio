// The scene seed loop and everything else that goes through a chat tab
// (M4-10 / M4-11 / M4-12 / M4-17).
//
// Nothing here calls a model directly. Every one of these writes a
// request into a chat Dan already has open, waits for the answer and
// reads it back — the same hand-off rule Optimize follows (spec
// decisions #2 and #4), which is why they all share
// shared/roundtrip.js.
//
// The rule that makes iterating safe: an expansion pass may only touch
// blanks (decision #13). Refine is the exception, because changing
// something already written is the explicit request.

import { state, activeProduction, activeScene } from './state.js';
import { persist } from './repository.js';
import { render } from './render.js';
import { ASPECTS, BLOCK_TYPES, blankAspectIds, blankBlockTypes, blockLabel, newBlock, newScene, newId, touch } from './model.js';
import {
  buildImportRequest,
  buildRefineRequest,
  buildScriptBreakdownRequest,
  buildSeedExpansionRequest,
  normalizeFieldUpdate,
  parseAssetList,
  parseJsonReply,
  parseSceneList,
  releaseFromProfile,
  targetById,
} from './prompt.js';
import { addAssets } from './assets.js';
import { openModal } from '../../shared/modal.js';
import { showToast } from '../../shared/ui.js';
import { listChatTabs, runRoundTrip } from '../../shared/roundtrip.js';

export async function refreshChatTabs() {
  state.chatTabs = await listChatTabs();
  return state.chatTabs;
}

function tabName(tab) {
  return `${tab.platformLabel} — ${tab.title || `tab ${tab.id}`}`;
}

// Which open chat does the thinking. Defaults to a tab on the same
// platform as the chosen generator, since that's the one already
// holding the production's context more often than not.
async function chooseWorkerTab(title, hint) {
  await refreshChatTabs();

  if (state.chatTabs.length === 0) {
    showToast('Open a ChatGPT, Claude or Gemini tab for this to run in, then try again.', 'warning');
    return null;
  }

  // Generator-only pages (Sora, Flow) take a prompt but have no reply to
  // read back, so they can't do this kind of work.
  const chatTabs = state.chatTabs.filter((t) => t.kind !== 'generator');
  if (chatTabs.length === 0) {
    showToast('This needs a ChatGPT, Claude or Gemini chat open — generator pages can’t answer.', 'warning');
    return null;
  }

  const production = activeProduction();
  const targetPlatforms = targetById(production.target).platforms;
  const preferred = chatTabs.find((t) => targetPlatforms.includes(t.platform));

  const values = await openModal({
    title,
    hint,
    fields: [
      {
        name: 'tabId',
        label: 'Run it in',
        type: 'select',
        value: String((preferred || chatTabs[0]).id),
        options: chatTabs.map((t) => ({ value: String(t.id), label: tabName(t) })),
      },
    ],
    confirmLabel: 'Send',
  });
  if (values === null) return null;

  const tabId = Number(values.tabId);
  return state.chatTabs.find((t) => t.id === tabId) || null;
}

// Applies a parsed { blocks, aspects } update to a scene.
//
// Blocks are addressed by type because that's the vocabulary the
// request uses. Where a scene has more than one block of a type, a
// blanks-only pass fills the first empty one and a refine rewrites the
// first one — a type the scene doesn't have yet is appended, so a pass
// can add the Dialogue block the seed implies.
function applyFieldUpdate(scene, update, { blanksOnly }) {
  let applied = 0;

  Object.entries(update.blocks).forEach(([type, text]) => {
    const candidates = scene.blocks.filter((b) => b.type === type);
    const target = blanksOnly
      ? candidates.find((b) => !(b.text || '').trim())
      : candidates[0];

    if (target) {
      target.text = text;
    } else if (blanksOnly && candidates.length > 0) {
      return; // every block of this type is already written — leave them
    } else {
      scene.blocks.push(newBlock(type, text));
    }
    applied += 1;
  });

  Object.entries(update.aspects).forEach(([id, text]) => {
    if (blanksOnly && (scene.shot.aspects[id] || '').trim()) return;
    scene.shot.aspects[id] = text;
    // Written by a pass or a refine now, not by the job profile, so a
    // later profile switch must leave it alone.
    releaseFromProfile(scene, id);
    applied += 1;
  });

  if (applied) touch(scene);
  return applied;
}

// ---------- M4-10: fill the blanks ----------

export async function expandScene() {
  const production = activeProduction();
  const scene = activeScene();
  if (!scene) return;

  const blankBlocks = blankBlockTypes(scene);
  const blankAspects = blankAspectIds(scene);

  if (blankBlocks.length === 0 && blankAspects.length === 0) {
    showToast('Nothing is blank in this scene. Use Refine to change what is already written.', 'warning');
    return;
  }
  if (!scene.seed.trim() && scene.blocks.every((b) => !(b.text || '').trim())) {
    showToast('Write a seed first — one line of what this shot is.', 'warning');
    return;
  }

  const worker = await chooseWorkerTab(
    'Fill the blanks',
    `${blankBlocks.length} blank block${blankBlocks.length === 1 ? '' : 's'} and ${blankAspects.length} blank aspect${blankAspects.length === 1 ? '' : 's'}. Anything you have already written stays exactly as it is.`
  );
  if (!worker) return;

  const reply = await runRoundTrip({
    tabId: worker.id,
    tabName: tabName(worker),
    text: buildSeedExpansionRequest(production, scene, {
      target: production.target,
      profile: production.profile,
      blankBlocks,
      blankAspects,
    }),
    title: 'Waiting for the expansion',
  });
  if (reply === null) return;

  const update = normalizeFieldUpdate(parseJsonReply(reply), {
    allowedBlocks: blankBlocks,
    allowedAspects: blankAspects,
  });
  const applied = applyFieldUpdate(scene, update, { blanksOnly: true });

  if (!applied) {
    showToast("That reply didn't contain anything usable — try sending it again.", 'warning');
    return;
  }

  scene.expansions += 1;
  touch(production);
  persist();
  render('runorder', 'shot', 'scenes');
  showToast(`Filled ${applied} blank field${applied === 1 ? '' : 's'}. Pass ${scene.expansions}.`);
}

// ---------- M4-11: chat to refine ----------

// Resolves true once the round trip has come back (whether or not it
// changed anything), false if it never ran or was cancelled — so the
// refine box only clears when the instruction was actually used.
export async function refineScene(instruction) {
  const production = activeProduction();
  const scene = activeScene();
  if (!scene) return false;

  const worker = await chooseWorkerTab('Refine this shot', `Change: ${instruction}`);
  if (!worker) return false;

  const reply = await runRoundTrip({
    tabId: worker.id,
    tabName: tabName(worker),
    text: buildRefineRequest(production, scene, instruction, {
      target: production.target,
      profile: production.profile,
    }),
    title: 'Waiting for the refinement',
  });
  if (reply === null) return false;

  // A refine is allowed to rewrite anything — that's the difference
  // between it and an expansion pass.
  const update = normalizeFieldUpdate(parseJsonReply(reply), {
    allowedBlocks: BLOCK_TYPES.map((b) => b.id),
    allowedAspects: ASPECTS.map((a) => a.id),
  });

  const changedNames = [
    ...Object.keys(update.blocks).map(blockLabel),
    ...Object.keys(update.aspects).map((id) => ASPECTS.find((a) => a.id === id)?.label || id),
  ];

  const applied = applyFieldUpdate(scene, update, { blanksOnly: false });

  scene.refinements.push({
    id: newId('ref'),
    text: instruction,
    applied,
    at: new Date().toISOString(),
  });
  touch(production);
  persist();
  render('runorder', 'shot');

  showToast(
    applied
      ? `Refined: ${changedNames.join(', ')}.`
      : "Nothing changed — the reply didn't name any fields."
  );
  return true;
}

// ---------- M4-12: rebuild scenes from a script ----------

export async function scenesFromScript(prefillText = '') {
  const production = activeProduction();

  const setup = await openModal({
    title: 'Scenes from a script',
    hint: 'Paste a script, a treatment or the description of a comic page. It comes back as an ordered shot list, one scene per shot.',
    fields: [
      { name: 'script', label: 'Source material', type: 'textarea', rows: 12, value: prefillText },
      { name: 'maxScenes', label: 'Maximum shots', value: '8' },
      {
        name: 'mode',
        label: 'Add them',
        type: 'select',
        value: 'append',
        options: [
          { value: 'append', label: 'After the scenes already here' },
          { value: 'replace', label: 'Replacing every scene here' },
        ],
      },
    ],
    confirmLabel: 'Continue',
  });
  if (setup === null) return;

  const script = setup.script.trim();
  if (!script) {
    showToast('Nothing to break down.', 'warning');
    return;
  }

  // Replacing throws away every scene and its render history, which no
  // other action in the extension does without asking. Ask before the
  // round trip, not after it, so a "no" doesn't cost a chat message.
  if (setup.mode === 'replace' && production.scenes.length > 0) {
    const renderCount = production.scenes.reduce((n, s) => n + s.renders.length, 0);
    const confirmed = await openModal({
      title: `Replace all ${production.scenes.length} scene${production.scenes.length === 1 ? '' : 's'}?`,
      body:
        `Every scene in "${production.name}" is deleted and rebuilt from the script` +
        (renderCount
          ? `, along with ${renderCount} recorded render${renderCount === 1 ? '' : 's'} and their review notes.`
          : '.') +
        ' Sequences are emptied. Filed dailies reports keep their copy. This cannot be undone.',
      confirmLabel: 'Replace scenes',
      danger: true,
    });
    if (confirmed === null) return;
  }

  const worker = await chooseWorkerTab('Break it into shots', 'The breakdown runs in a chat you already have open.');
  if (!worker) return;

  const reply = await runRoundTrip({
    tabId: worker.id,
    tabName: tabName(worker),
    text: buildScriptBreakdownRequest(script, {
      profile: production.profile,
      maxScenes: Math.max(1, Math.min(30, Number(setup.maxScenes) || 8)),
    }),
    title: 'Waiting for the breakdown',
  });
  if (reply === null) return;

  const parsed = parseSceneList(parseJsonReply(reply));
  if (parsed.length === 0) {
    showToast("Couldn't read a shot list out of that reply.", 'warning');
    return;
  }

  const built = parsed.map((entry) => {
    const scene = newScene(entry.name, entry.seed);
    applyFieldUpdate(scene, entry, { blanksOnly: true });
    return scene;
  });

  if (setup.mode === 'replace') {
    production.scenes = built;
    // Every scene a sequence pointed at is gone; an empty sequence would
    // just be a name with nothing to produce.
    production.sequences = [];
  } else {
    production.scenes.push(...built);
  }

  state.activeSceneId = built[0].id;
  touch(production);
  persist();
  render('scenes', 'runorder', 'shot', 'assets');
  showToast(`Built ${built.length} scene${built.length === 1 ? '' : 's'} from the script.`);
}

// ---------- M4-17: import existing material ----------

export async function importMaterial(prefillText = '') {
  const setup = await openModal({
    title: 'Import production material',
    hint: 'Characters, locations, wardrobe, vehicles, props, mood and lighting. Paste JSON to load it directly, or paste notes and have an open chat pull the entries out.',
    fields: [
      { name: 'text', label: 'Material', type: 'textarea', rows: 12, value: prefillText },
    ],
    confirmLabel: 'Import',
  });
  if (setup === null) return;

  const text = setup.text.trim();
  if (!text) {
    showToast('Nothing to import.', 'warning');
    return;
  }

  // JSON goes straight in — no reason to spend a chat round trip on
  // material that's already structured.
  const direct = parseAssetList(parseJsonReply(text));
  if (direct.length > 0) {
    addAssets(direct.map((a) => ({ ...a, origin: 'imported' })));
    showToast(`Imported ${direct.length} asset${direct.length === 1 ? '' : 's'}.`);
    return;
  }

  const worker = await chooseWorkerTab('Pull the entries out', 'The notes get structured in a chat you already have open.');
  if (!worker) return;

  const reply = await runRoundTrip({
    tabId: worker.id,
    tabName: tabName(worker),
    text: buildImportRequest(text),
    title: 'Waiting for the import',
  });
  if (reply === null) return;

  const parsed = parseAssetList(parseJsonReply(reply));
  if (parsed.length === 0) {
    showToast("Couldn't read any entries out of that reply.", 'warning');
    return;
  }

  addAssets(parsed.map((a) => ({ ...a, origin: 'imported' })));
  showToast(`Imported ${parsed.length} asset${parsed.length === 1 ? '' : 's'}.`);
}
