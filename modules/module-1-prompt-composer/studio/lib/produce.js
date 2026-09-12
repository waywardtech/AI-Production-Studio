// Produce (M4-14) — the final step from the notes: generate the video,
// put it in the out-box, and have something to review afterwards.
//
// The extension composes and hands off. It writes the finished prompt
// into the generator's tab and records what it sent; pressing send, and
// bringing the clip's link back, stay with Dan. That's the same
// hands-off rule as everywhere else in the suite.

import { state, activeProduction, activeScene } from './state.js';
import { persistNow } from './repository.js';
import { render } from './render.js';
import { newId, touch } from './model.js';
import { assemblePrompt, buildProductionPrompt, profileById, targetById } from './prompt.js';
import { refreshChatTabs } from './seed.js';
import { openModal } from '../../sidepanel/lib/modal.js';
import { showToast, copyToClipboard } from '../../sidepanel/lib/ui.js';
import { runRoundTrip, sendToTab, unfence } from '../../sidepanel/lib/roundtrip.js';

function tabName(tab) {
  return `${tab.platformLabel} — ${tab.title || `tab ${tab.id}`}`;
}

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
// retyped — spec §7 P1, and the whole point of writing them down.
function withNotes(promptText, notes) {
  if (!notes) return promptText;
  return `${promptText}\n\nChanges wanted from the last attempt: ${notes}`;
}

export async function produceScenes({ sceneIds = null, notes = '' } = {}) {
  const production = activeProduction();
  if (!production) return;

  await refreshChatTabs();
  if (state.chatTabs.length === 0) {
    showToast('Open the tab you generate in (ChatGPT for Sora, Gemini for Veo), then try again.', 'warning');
    return;
  }

  const target = targetById(production.target);
  const preferred = state.chatTabs.find((t) => t.platform === target.platform) || state.chatTabs[0];

  const scopeOptions = [{ value: 'scene', label: `This scene only (${activeScene()?.name || '—'})` }];
  production.sequences.forEach((sequence) => {
    scopeOptions.push({ value: `seq:${sequence.id}`, label: `Sequence — ${sequence.name} (${sequence.sceneIds.length})` });
  });
  scopeOptions.push({ value: 'all', label: `Every scene (${production.scenes.length})` });

  const setup = sceneIds
    ? { scope: 'preset', tabId: String(preferred.id), optimize: true }
    : await openModal({
        title: `Produce for ${target.label}`,
        hint: 'The prompt is written into the tab you pick. Pressing send stays with you — nothing is submitted on your behalf.',
        fields: [
          { name: 'scope', label: 'Produce', type: 'select', value: 'scene', options: scopeOptions },
          {
            name: 'tabId',
            label: 'Write it into',
            type: 'select',
            value: String(preferred.id),
            options: state.chatTabs.map((t) => ({ value: String(t.id), label: tabName(t) })),
          },
          {
            name: 'optimize',
            label: `Reword it for ${target.label} first (one round trip per shot)`,
            type: 'checkbox',
            value: true,
          },
        ],
        confirmLabel: 'Produce',
      });
  if (setup === null) return;

  const destination = state.chatTabs.find((t) => t.id === Number(setup.tabId));
  if (!destination) {
    showToast('That tab is gone. Refresh and try again.', 'warning');
    return;
  }

  const scenes = sceneIds
    ? sceneIds.map((id) => production.scenes.find((s) => s.id === id)).filter(Boolean)
    : scenesInScope(production, setup.scope);

  if (scenes.length === 0) {
    showToast('Nothing in scope to produce.', 'warning');
    return;
  }

  let produced = 0;

  for (const scene of scenes) {
    let finalPrompt = withNotes(assemblePrompt(production, scene), notes);

    if (setup.optimize) {
      const reply = await runRoundTrip({
        tabId: destination.id,
        tabName: tabName(destination),
        text: withNotes(buildProductionPrompt(production, scene), notes),
        title: `Wording "${scene.name}" for ${target.label}`,
      });
      // A cancelled or empty round trip stops the run rather than
      // quietly falling back to the unoptimized wording — sending
      // something Dan didn't see is worse than sending nothing.
      if (reply === null) break;
      finalPrompt = unfence(reply);
    }

    const written = await sendToTab(destination.id, finalPrompt);
    if (!written) {
      const copied = await copyToClipboard(finalPrompt);
      if (!copied) {
        showToast(`Couldn't write "${scene.name}" into that tab or onto the clipboard.`, 'warning');
        break;
      }
    }

    const record = {
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
    };
    scene.renders.push(record);
    production.outbox.unshift({
      id: newId('out'),
      kind: 'clip',
      renderId: record.id,
      sceneId: scene.id,
      title: scene.name,
      url: '',
      at: record.at,
    });
    touch(scene);
    produced += 1;

    if (!written) {
      showToast(`"${scene.name}" is on your clipboard — paste it into ${tabName(destination)}.`, 'warning');
      break;
    }
  }

  touch(production);
  await persistNow();
  render('scenes', 'drawer');

  if (produced > 0) {
    showToast(
      `${produced} shot${produced === 1 ? '' : 's'} written into ${tabName(destination)}. Press Enter there, then paste each clip's link into the out-box.`
    );
  }
}

// ---------- M4-16: the dailies report ----------

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

export function buildDailiesReport(production) {
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
    production.assets
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

  const body = buildDailiesReport(production);
  production.outbox.unshift({
    id: newId('out'),
    kind: 'report',
    title: `Dailies — ${new Date().toLocaleDateString()}`,
    body,
    at: new Date().toISOString(),
  });
  touch(production);
  await persistNow();
  render('drawer');
  showToast('Dailies report filed in the out-box.');
  return body;
}

export function initProduce() {
  document.getElementById('produce-btn').addEventListener('click', () => produceScenes());
}
