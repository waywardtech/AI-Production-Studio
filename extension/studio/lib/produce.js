// Produce (M4-14) — the final step from the notes: generate the video,
// put it in the out-box, and have something to review afterwards.
//
// The extension composes and hands off. It writes the finished prompt
// into the generator's tab and records what it sent; pressing send, and
// bringing the clip's link back, stay with Dan. That's the same
// hands-off rule as everywhere else in the suite.

import { state, activeProduction, activeScene } from './state.js';
import { persistNow, saveDocument } from './repository.js';
import { render } from './render.js';
import { newId, touch } from './model.js';
import { newDocument } from '../../shared/model.js';
import { assemblePrompt, buildProductionPrompt, profileById, targetById } from './prompt.js';
import { refreshChatTabs } from './seed.js';
import { openModal } from '../../shared/modal.js';
import { showToast, copyToClipboard } from '../../shared/ui.js';
import { runRoundTrip, sendToTab, unfence } from '../../shared/roundtrip.js';
import { isChatTab, tabName } from '../../shared/tabs.js';


function scenesInScope(production, scope) {
  if (scope === 'all') return production.scenes;
  if (scope.startsWith('seq:')) {
    const sequence = production.sequences.find((s) => s.id === scope.slice(4));
    if (!sequence) return [];
    return sequence.sceneIds
      .map((id) => production.scenes.find((s) => s.id === id))
      .filter(Boolean);
  }
  const scene = activeScene();
  return scene ? [scene] : [];
}

// Notes from a rejected pass are carried into the next one rather than
// retyped — spec §7's review loop, and the whole point of writing them
// down.
function withNotes(promptText, notes) {
  if (!notes) return promptText;
  return `${promptText}\n\nChanges wanted from the last attempt: ${notes}`;
}

export async function produceScenes({ sceneIds = null, notes = '' } = {}) {
  const production = activeProduction();
  if (!production) return;

  await refreshChatTabs();
  if (state.chatTabs.length === 0) {
    showToast('Open the tab you generate in (Sora or ChatGPT for Sora, Flow or Gemini for Veo), then try again.', 'warning');
    return;
  }

  const target = targetById(production.target);
  const remembered = production.produceSetup || {};
  const byId = (id) => state.chatTabs.find((t) => t.id === id);

  // Where the prompt goes: last time's tab if it's still open, else a tab
  // on one of this generator's platforms, in the order the target lists
  // them (a dedicated generator page before a chat that can also do it).
  const generatorTab =
    target.platforms.map((p) => state.chatTabs.find((t) => t.platform === p)).find(Boolean) || null;
  const defaultDestination = byId(remembered.destinationTabId) || generatorTab || state.chatTabs[0];

  // Where the rewording happens. Deliberately NOT the generator tab by
  // default: a reword request sent there costs a generation-quota
  // message and leaves a meta-conversation in the session the clips are
  // made in. With no other chat open, the safe default is not to reword.
  const chatTabs = state.chatTabs.filter(isChatTab);
  const rememberedReword = remembered.rewordTabId === 'none' ? null : byId(remembered.rewordTabId);
  const defaultReword =
    remembered.rewordTabId === 'none'
      ? 'none'
      : String(
          (rememberedReword && isChatTab(rememberedReword) && rememberedReword.id) ||
            chatTabs.find((t) => t.id !== defaultDestination.id)?.id ||
            'none'
        );

  const fields = [];
  if (!sceneIds) {
    const scopeOptions = [{ value: 'scene', label: `This scene only (${activeScene()?.name || '—'})` }];
    production.sequences.forEach((sequence) => {
      scopeOptions.push({
        value: `seq:${sequence.id}`,
        label: `Sequence — ${sequence.name} (${sequence.sceneIds.length})`,
      });
    });
    scopeOptions.push({ value: 'all', label: `Every scene (${production.scenes.length})` });
    fields.push({ name: 'scope', label: 'Produce', type: 'select', value: 'scene', options: scopeOptions });
  }

  fields.push(
    {
      name: 'destinationTabId',
      label: `Generate in`,
      type: 'select',
      value: String(defaultDestination.id),
      options: state.chatTabs.map((t) => ({ value: String(t.id), label: tabName(t) })),
    },
    {
      name: 'rewordTabId',
      label: `Reword for ${target.label} first, in`,
      type: 'select',
      value: defaultReword,
      options: [
        { value: 'none', label: "Don't reword — send the assembled shot as it is" },
        ...chatTabs.map((t) => ({
          value: String(t.id),
          label: t.id === defaultDestination.id ? `${tabName(t)} (same tab — uses its quota)` : tabName(t),
        })),
      ],
    }
  );

  const setup = await openModal({
    title: sceneIds ? `Regenerate for ${target.label}` : `Produce for ${target.label}`,
    hint:
      'Each shot is written into the generator tab and then waits for you: press Enter there, come back, and continue to the next. Nothing is submitted on your behalf.',
    fields,
    confirmLabel: sceneIds ? 'Regenerate' : 'Produce',
  });
  if (setup === null) return;

  const destination = byId(Number(setup.destinationTabId));
  if (!destination) {
    showToast('That tab is gone. Refresh and try again.', 'warning');
    return;
  }
  const rewordTab = setup.rewordTabId === 'none' ? null : byId(Number(setup.rewordTabId));
  if (setup.rewordTabId !== 'none' && !rewordTab) {
    showToast('The tab chosen for rewording is gone. Refresh and try again.', 'warning');
    return;
  }

  production.produceSetup = {
    destinationTabId: destination.id,
    rewordTabId: rewordTab ? rewordTab.id : 'none',
  };

  const scenes = sceneIds
    ? sceneIds.map((id) => production.scenes.find((s) => s.id === id)).filter(Boolean)
    : scenesInScope(production, setup.scope);

  if (scenes.length === 0) {
    showToast('Nothing in scope to produce.', 'warning');
    return;
  }

  let produced = 0;
  let stoppedEarly = false;

  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i];
    const isLast = i === scenes.length - 1;
    let finalPrompt = withNotes(assemblePrompt(production, scene, { assets: state.assets }), notes);

    if (rewordTab) {
      const reply = await runRoundTrip({
        tabId: rewordTab.id,
        tabName: tabName(rewordTab),
        text: withNotes(buildProductionPrompt(production, scene, { assets: state.assets }), notes),
        title: `Wording "${scene.name}" for ${target.label} (${i + 1} of ${scenes.length})`,
      });
      // A cancelled or empty round trip stops the run rather than
      // quietly falling back to the unoptimized wording — sending
      // something Dan didn't see is worse than sending nothing.
      if (reply === null) {
        stoppedEarly = true;
        break;
      }
      finalPrompt = unfence(reply);
    }

    const written = await sendToTab(destination.id, finalPrompt);
    if (!written) {
      const copied = await copyToClipboard(finalPrompt);
      if (!copied) {
        showToast(`Couldn't write "${scene.name}" into that tab or onto the clipboard.`, 'warning');
        stoppedEarly = true;
        break;
      }
    }

    // Recorded once the prompt has actually been handed over. The
    // out-box lists renders straight off their scenes, so there's no
    // second copy to keep in step.
    scene.renders.push({
      id: newId('rnd'),
      sceneId: scene.id,
      sceneName: scene.name,
      target: production.target,
      profile: production.profile,
      prompt: finalPrompt,
      url: '',
      notes,
      verdict: 'pending',
      at: new Date().toISOString(),
    });
    touch(scene);
    touch(production);
    produced += 1;
    await persistNow(production);
    render('scenes', 'drawer');

    if (isLast) break;

    // The next write would replace this shot in the generator's input
    // box before it was ever sent, so the run waits here until Dan has
    // sent it.
    const where = written ? `is in ${tabName(destination)}` : 'is on your clipboard';
    const action = written ? 'Press Enter there to generate it' : `Paste it into ${tabName(destination)} and send it`;
    const next = await openModal({
      title: `Shot ${i + 1} of ${scenes.length} is ready`,
      body: `"${scene.name}" ${where}. ${action}, then continue — the next shot goes into the same input box and would replace this one.`,
      confirmLabel: `Next shot (${i + 2} of ${scenes.length})`,
    });
    if (next === null) {
      stoppedEarly = true;
      break;
    }
  }

  await persistNow(production);
  render('scenes', 'drawer');

  if (produced === 0) return;

  const plural = `${produced} shot${produced === 1 ? '' : 's'}`;
  showToast(
    stoppedEarly
      ? `Stopped after ${plural}. The rest weren't sent. Paste each clip's link into the out-box as it arrives.`
      : `${plural} handed to ${tabName(destination)}. Send the last one there, then paste each clip's link into the out-box.`,
    stoppedEarly ? 'warning' : 'success'
  );
}

// ---------- M4-16: the dailies report ----------

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

export function buildDailiesReport(production, assets = []) {
  const renders = production.scenes.flatMap((scene) =>
    scene.renders.map((entry) => ({ ...entry, scene }))
  );
  const counts = renders.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});

  const lines = [
    `# Dailies — ${production.name}`,
    '',
    `Generated ${formatDate(new Date().toISOString())}`,
    `Status: ${production.status} · Generator: ${targetById(production.target).label} · Profile: ${profileById(production.profile).label}`,
    '',
    `**${renders.length} render${renders.length === 1 ? '' : 's'}** — ` +
      ['keep', 'reject', 'regen', 'pending']
        .map((verdict) => `${counts[verdict] || 0} ${verdict}`)
        .join(' · '),
    '',
  ];

  if (production.sequences.length) {
    lines.push('## Sequences', '');
    production.sequences.forEach((sequence) => {
      const names = sequence.sceneIds
        .map((id) => production.scenes.find((s) => s.id === id)?.name)
        .filter(Boolean);
      lines.push(`- **${sequence.name}** — ${names.join(' → ') || '(empty)'}`);
    });
    lines.push('');
  }

  lines.push('## Shots', '');

  production.scenes.forEach((scene, i) => {
    lines.push(`### ${String(i + 1).padStart(2, '0')} · ${scene.name}`, '');
    lines.push(`Status: ${scene.status}${scene.seed ? ` · Seed: ${scene.seed}` : ''}`, '');

    if (scene.renders.length === 0) {
      lines.push('_Not produced yet._', '');
      return;
    }

    scene.renders.forEach((record) => {
      lines.push(
        `- **${record.verdict.toUpperCase()}** · ${targetById(record.target).label} · ${formatDate(record.at)}`
      );
      if (record.url) lines.push(`  - Clip: ${record.url}`);
      if (record.notes) lines.push(`  - Notes: ${record.notes}`);
      lines.push('  - Prompt:', '', '    ```', ...record.prompt.split('\n').map((l) => `    ${l}`), '    ```', '');
    });
  });

  const referenced = new Set(production.scenes.flatMap((s) => s.assetIds));
  if (referenced.size) {
    lines.push('## References used', '');
    assets
      .filter((a) => referenced.has(a.id))
      .forEach((asset) => {
        lines.push(`- **${asset.name}** (${asset.category})${asset.sourceUrl ? ` — ${asset.sourceUrl}` : ''}`);
      });
    lines.push('');
  }

  return lines.join('\n');
}

export async function fileDailiesReport() {
  const production = activeProduction();
  if (!production) return;

  const body = buildDailiesReport(production, state.assets);
  // Filed as a document in the production's out-box — with Google Docs
  // connected, a Google Doc in its Out-box folder.
  await saveDocument(
    newDocument({
      projectId: state.projectId,
      productionId: production.id,
      box: 'outbox',
      kind: 'report',
      title: `Dailies — ${production.name} — ${new Date().toLocaleDateString()}`,
      text: body,
    })
  );
  render('drawer');
  showToast('Dailies report filed in the out-box.');
  return body;
}

export function initProduce() {
  document.getElementById('produce-btn').addEventListener('click', () => produceScenes());
}
