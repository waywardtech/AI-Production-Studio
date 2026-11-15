// The studio UI. One page, two views of the same film:
//
//   Storyboard — scenes as strips, each shot as wide as it is long, so
//                the row reads as time.
//   Graph      — what feeds what: Story Bible → scene → shot.
//
// Both draw from /api/state and both show the same thing about a shot:
// whether the take it stands on still matches what it was made from.
// Nothing here decides anything; every rule lives in the service, and a
// refused action comes back with its reason to be shown.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  kids.flat().forEach((kid) => kid != null && node.append(kid));
  return node;
};
const api = async (path, body) => {
  const res = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};
const blobUrl = (id) => `/api/blob/${id}`;
// A take is a picture or a clip; imported clips play muted on a loop.
const media = (take, alt = '') => (take.mime?.startsWith('video/')
  ? el('video', { src: blobUrl(take.blobId), muted: true, loop: true, autoplay: true, playsInline: true, controls: false })
  : el('img', { src: blobUrl(take.blobId), alt }));
const modelsOf = (kind) => ui.state.models.filter((m) => m.kind === kind);
const modelLabel = (id) => ui.state.models.find((m) => m.id === id)?.label || id;
// A generator picker. `none` is the label for "no preference".
function generatorSelect(kind, value, none, onPick) {
  const select = el('select', {}, el('option', { value: '', textContent: none }), modelsOf(kind).map((m) => el('option', { value: m.id, textContent: m.label })));
  select.value = value || '';
  select.onclick = (e) => e.stopPropagation();
  select.onchange = act(() => onPick(select.value || null));
  return select;
}

const ui = { state: null, view: 'board', shotId: null, detail: null, openEntity: null, hoverEntity: null, cuts: {} };

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($('toast').hidden = true), 6000);
}
const act = (fn) => async (...args) => {
  try { await fn(...args); } catch (error) { toast(error.message); }
  await refresh();
};

// ---------- Story Bible ----------

function renderBible() {
  const editing = document.activeElement?.closest?.('.entity form, .entity .routing');
  if (editing) return; // don't redraw a form someone is typing in
  $('bible').replaceChildren(...ui.state.bible.map((entity) => {
    const open = ui.openEntity === entity.id;
    const card = el('div', { className: `entity${open ? ' open' : ''}` },
      el('div', { className: 'kind', textContent: entity.kind }),
      el('div', { textContent: entity.name }),
      el('div', { className: 'meta', textContent: `v${entity.version.n} · feeds ${entity.downstream} shot${entity.downstream === 1 ? '' : 's'}` }));
    // Hovering canon shows what an edit to it would reach.
    card.onmouseenter = () => { ui.hoverEntity = entity.id; markDownstream(); };
    card.onmouseleave = () => { ui.hoverEntity = null; markDownstream(); };
    card.onclick = (e) => { if (e.target.closest('form')) return; ui.openEntity = open ? null : entity.id; renderBible(); };
    if (open) {
      const form = el('form');
      Object.entries(entity.version.fields).forEach(([key, value]) => form.append(el('label', { textContent: key }), el('input', { type: 'text', name: key, value })));
      form.append(el('button', { className: 'primary', textContent: 'Save as new version' }));
      form.onsubmit = act(async (e) => {
        e.preventDefault();
        const fields = Object.fromEntries(new FormData(form));
        const { affected } = await api(`bible/${entity.id}`, { fields });
        document.activeElement.blur();
        toast(affected.length ? `${entity.name} is now v${entity.version.n + 1}. ${affected.length} shot${affected.length === 1 ? '' : 's'} downstream may be out of date — nothing was re-rendered.` : `${entity.name} saved.`);
      });
      card.append(form);
      if (entity.kind === 'look') {
        // Not part of the form: choosing a generator is not a new version.
        const pick = (kind) => generatorSelect(kind, entity.routing?.[kind], 'project default', (modelId) => api('routing', { entityId: entity.id, kind, modelId }));
        const box = el('div', { className: 'routing' }, el('label', { textContent: 'stills made with' }), pick('image'), el('label', { textContent: 'video made with' }), pick('video'),
          el('div', { className: 'meta', textContent: 'A production choice, not canon: changing it marks nothing out of sync.' }));
        box.onclick = (e) => e.stopPropagation();
        card.append(box);
      }
    }
    return card;
  }));
}

function markDownstream() {
  const edges = ui.state.graph.edges;
  const scenes = new Set(edges.filter((e) => e.from === ui.hoverEntity).map((e) => e.to));
  const entity = ui.state.bible.find((b) => b.id === ui.hoverEntity);
  document.querySelectorAll('.shot').forEach((card) => {
    const hit = !!entity && (entity.kind === 'look' || entity.kind === 'format'
      || edges.some((e) => e.to === card.dataset.id && (e.from === ui.hoverEntity || scenes.has(e.from))));
    card.classList.toggle('downstream', hit);
  });
}

// ---------- storyboard ----------

function renderBoard() {
  $('board').replaceChildren(...ui.state.board.map((scene) => el('div', { className: 'scene' },
    el('h3', { textContent: scene.name }),
    el('div', { className: 'beat', textContent: `${scene.beat} · ${scene.timeOfDay}, ${scene.lighting}` }),
    el('div', { className: 'strip' }, scene.shots.map((shot) => {
      const shown = shot.master || shot.take;
      const card = el('div', { className: `shot is-${shot.status.state}${ui.shotId === shot.id ? ' selected' : ''}` },
        el('div', { className: 'thumb' }, shown ? media(shown, shot.name) : 'no take yet'),
        el('div', { className: 'name' }, el('span', { textContent: shot.name }), el('span', { className: `badge state-${shot.status.state}`, textContent: shot.status.state === 'stale' ? 'out of sync' : shot.status.state === 'review' ? 'new take to review' : shot.status.state })),
        el('div', { className: 'sub', textContent: `${shot.kind} · ${shot.durationS}s · ${shot.takeCount} take${shot.takeCount === 1 ? '' : 's'}${shown ? ` · ${shown.tier}` : ''}` }),
        shot.status.reasons.length ? el('div', { className: 'ripple', textContent: `↯ ${shot.status.reasons.map((r) => r.message).join('; ')}` }) : null);
      card.style.setProperty('--dur', shot.durationS);
      card.dataset.id = shot.id;
      card.onclick = () => selectShot(shot.id);
      return card;
    })))));
  markDownstream();
}

// ---------- graph ----------

function renderGraph() {
  const { nodes, edges } = ui.state.graph;
  const cols = { bible: nodes.filter((n) => n.type === 'bible'), scene: nodes.filter((n) => n.type === 'scene'), shot: nodes.filter((n) => n.type === 'shot') };
  const W = 190, H = 34, GAP = 14, X = { bible: 20, scene: 330, shot: 640 };
  const pos = {};
  Object.entries(cols).forEach(([type, list]) => list.forEach((n, i) => (pos[n.id] = { x: X[type], y: 40 + i * (H + GAP) })));
  const height = 60 + Math.max(...Object.values(cols).map((l) => l.length)) * (H + GAP);
  const ns = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); if (text) n.textContent = text; return n; };
  const svg = s('svg', { viewBox: `0 0 850 ${height}`, height });
  [['bible', 'Story Bible'], ['scene', 'Scenes'], ['shot', 'Shots']].forEach(([t, label]) => svg.append(s('text', { x: X[t], y: 22, class: 'col' }, label)));
  edges.filter((e) => pos[e.from] && pos[e.to]).forEach((e) => {
    const a = pos[e.from], b = pos[e.to], x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mid = (x1 + x2) / 2;
    svg.append(s('path', { d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`, class: `edge${e.stale ? ' stale' : ''}` }));
  });
  nodes.forEach((n) => {
    const g = s('g', { class: `node ${n.type} ${n.state || ''}`, transform: `translate(${pos[n.id].x},${pos[n.id].y})` });
    g.append(s('rect', { width: W, height: H }), s('text', { x: 10, y: 21 }, `${n.label}${n.type === 'bible' ? `  · v${n.version}` : n.state === 'stale' ? '  ↯' : n.state === 'review' ? '  ?' : ''}`));
    if (n.type === 'shot') g.onclick = () => selectShot(n.id);
    svg.append(g);
  });
  $('graph').replaceChildren(svg);
}

// ---------- inspector ----------

async function selectShot(id) {
  ui.shotId = id;
  await refresh();
}

function renderInspector() {
  const d = ui.detail;
  if (!d) return;
  if ($('inspector').contains(document.activeElement) && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
  const { shot, compiled } = d;
  const root = el('div');

  const note = el('textarea', { rows: 3, value: shot.notes });
  const camera = el('input', { type: 'text', value: shot.camera, placeholder: 'camera' });
  const saveShot = act(() => api(`shots/${shot.id}`, { notes: note.value, camera: camera.value }));
  note.onchange = saveShot; camera.onchange = saveShot;
  const via = { shot: 'chosen for this shot', look: 'the look\'s generator', project: 'project default', default: 'built-in mock' }[d.routedBy] || '';
  root.append(el('h2', { textContent: `${shot.name} · ${d.model.label}` }), el('div', { className: 'meta', textContent: `${via}${d.model.mode === 'handoff' ? ' · by hand, through your subscription' : ''}` }), note, el('div', { className: 'row' }, camera));

  root.append(el('h3', {}, 'Compiled prompt', el('span', { className: `budget${compiled.overBudget ? ' over' : ''}`, textContent: `${compiled.tokens} / ${compiled.budget} tokens` })));
  compiled.clauses.filter((c) => c.text).forEach((c) => {
    const lock = el('button', { className: 'small', textContent: c.locked ? 'unlock' : 'lock', title: c.locked ? 'Go back to the compiled text' : 'Keep this text exactly, whatever changes upstream' });
    lock.onclick = act(async () => {
      if (c.locked) return api(`shots/${shot.id}/lock`, { key: c.key, text: null });
      const text = prompt(`Lock "${c.key}" as:`, c.text);
      if (text !== null) await api(`shots/${shot.id}/lock`, { key: c.key, text });
    });
    root.append(el('div', { className: `clause${c.dropped ? ' dropped' : ''}${c.locked ? ' locked' : ''}` },
      el('span', { className: 'key', textContent: c.key }),
      el('div', {}, el('div', { className: 'text', textContent: c.text }), el('div', { className: 'src', textContent: c.dropped ? `${c.source} — left out to fit the budget` : c.source })),
      lock));
  });
  if (compiled.negativePrompt) root.append(el('div', { className: 'note info', textContent: `Negative: ${compiled.negativePrompt}` }));

  if (d.diff.length) {
    root.append(el('h3', { textContent: 'Changed since the current take' }));
    d.diff.forEach((x) => root.append(el('div', { className: 'diff' }, el('b', { textContent: `${x.key}: ` }), x.before ? el('del', { textContent: x.before }) : null, ' ', x.after ? el('ins', { textContent: x.after }) : null)));
  }

  const notes = [...d.issues, ...d.continuity];
  if (notes.length) {
    root.append(el('h3', { textContent: 'Before you render' }));
    notes.forEach((n) => root.append(el('div', { className: `note ${n.severity}`, textContent: n.message })));
  }

  const fixable = d.issues.some((i) => i.fixable);
  const render = el('button', { className: 'primary', textContent: 'Render proxy', disabled: d.blockers.length > 0, title: d.blockers[0] || 'A fast draft at proxy resolution' });
  render.onclick = act(() => api(`shots/${shot.id}/render`, {}));
  const refineBtn = el('button', { textContent: 'Critic → refine', disabled: !fixable, title: fixable ? 'Apply the fixes that need no decision' : 'Nothing to fix automatically' });
  refineBtn.onclick = act(async () => { const r = await api(`shots/${shot.id}/refine`, {}); toast(r.changes.join(' · ') || 'Nothing to change.'); });
  const byHand = d.model.mode === 'handoff';
  if (byHand) { render.textContent = 'Hand off proxy'; if (!d.blockers.length) render.title = 'Writes the prompt and attachment list for you to send'; }
  const rivals = modelsOf(d.model.kind).filter((m) => m.mode === 'handoff');
  const bake = el('button', { textContent: 'Compare generators', disabled: d.blockers.length > 0 || rivals.length < 2, title: `The same shot and seed to ${rivals.map((m) => m.label.split(' (')[0]).join(' and ')}, to judge side by side` });
  bake.onclick = act(async () => { await api(`shots/${shot.id}/bakeoff`, { modelIds: rivals.map((m) => m.id) }); showView('handoffs'); toast(`${rivals.length} hand-offs written for ${shot.name}. Nothing is sent for you.`); });
  render.onclick = act(async () => { await api(`shots/${shot.id}/render`, {}); if (byHand) showView('handoffs'); });
  root.append(el('div', { className: 'row' }, render, refineBtn, bake));

  if (d.references.length) {
    root.append(el('h3', { textContent: 'References attached automatically' }));
    root.append(el('div', { className: 'refs' }, d.references.map((r) => el('figure', {}, r.missing ? 'missing' : el('img', { src: blobUrl(r.assetId) }), el('figcaption', { textContent: `${r.from} · ${r.role}` })))));
  }

  root.append(el('h3', { textContent: `Takes (${d.takes.length})` }));
  [...d.takes].reverse().filter((t) => !t.promotedFromTakeId).forEach((take) => root.append(takeCard(take, shot, d.status)));
  $('inspector').replaceChildren(root);
}

function takeCard(take, shot, status) {
  const approved = shot.approvedTakeId === take.id;
  const card = el('div', { className: `take${approved ? ' approved' : ''}` },
    el('div', { className: 'head' }, el('span', { textContent: `Take ${take.n} · ${modelLabel(take.modelId).split(' (')[0]}${take.imported ? ' · imported' : ` · seed ${take.seed}`}${take.parentTakeId ? ' · branched' : ''}` }), el('span', { textContent: approved ? (status?.state === 'review' || status?.state === 'stale' ? 'approved · out of date' : 'approved') : status?.candidateTakeId === take.id ? 'matches current canon — approve to replace' : '' })));

  if (take.master) {
    // Proxy underneath, master on top, clipped at the slider.
    const wipe = el('div', { className: 'wipe' }, media(take),
      el('div', { className: 'top' }, media(take.master)), el('div', { className: 'bar' }),
      el('span', { className: 'tag a', textContent: 'proxy' }), el('span', { className: 'tag b', textContent: 'master' }));
    const slider = el('input', { type: 'range', min: 0, max: 100, value: ui.cuts[take.id] ?? 50 });
    const cut = () => { ui.cuts[take.id] = slider.value; wipe.style.setProperty('--cut', `${slider.value}%`); };
    slider.oninput = cut; cut();
    card.append(wipe, slider);
    card.append(el('div', { className: 'note info', textContent: take.master.composition == null ? 'Imported master: the studio cannot measure drift on files made elsewhere. Drag the wipe and check the framing yourself.' : take.master.composition === take.composition ? 'Same composition as the proxy — only the resolution changed.' : 'Composition differs from the proxy.' }));
  } else {
    card.append(media(take));
  }

  const row = el('div', { className: 'row' });
  if (!approved) { const b = el('button', { className: 'small', textContent: 'Approve' }); b.onclick = act(() => api(`shots/${shot.id}/approve`, { takeId: take.id })); row.append(b); }
  if (!take.master) {
    const check = take.promotion;
    const b = el('button', { className: 'small', textContent: 'Promote to master', disabled: !!check?.blockers?.length, title: check?.blockers?.[0] || 'Re-run this exact recipe at master resolution' });
    b.onclick = act(async () => { const r = await api(`takes/${take.id}/promote`, {}); toast(`Promoting: only ${r.changed.join(', ')} change.${r.warnings.length ? ` ${r.warnings[0]}` : ''}`); });
    row.append(b);
    [...(check?.blockers || []), ...(check?.warnings || [])].forEach((w) => card.append(el('div', { className: `note ${check.blockers.includes(w) ? 'block' : ''}`, textContent: w })));
  }
  const branch = el('button', { className: 'small', textContent: 'Branch (new seed)', title: 'Another take from the same locked prompt. This one is kept.' });
  branch.onclick = act(() => api(`takes/${take.id}/branch`, {}));
  row.append(branch);
  if (ui.detail && ui.detail.model.id !== take.modelId && take.tier === 'proxy') {
    const prefer = el('button', { className: 'small', textContent: `Use ${modelLabel(take.modelId).split(' (')[0]} from now on`, title: 'Make this take\'s generator the one this look uses. Approves nothing.' });
    prefer.onclick = act(async () => { const r = await api(`takes/${take.id}/prefer`, {}); toast(`${modelLabel(r.modelId)} is now the ${r.kind === 'image' ? 'stills' : 'video'} generator for ${r.lookName || 'the project'}.`); });
    row.append(prefer);
  }
  card.append(row);
  return card;
}

// ---------- jobs ----------

function renderJobs() {
  const jobs = ui.state.jobs;
  const failedBatches = [...new Set(jobs.filter((j) => j.status === 'failed' && j.batchId).map((j) => j.batchId))];
  const rows = jobs.map((job) => {
    const buttons = el('span', { className: 'row' });
    if (job.status === 'failed') {
      const retry = el('button', { className: 'small', textContent: 'Retry' }); retry.onclick = act(() => api(`jobs/${job.id}/retry`, {})); buttons.append(retry);
      if (!job.byHand) { const fb = el('button', { className: 'small', textContent: 'Retry with fallback model' }); fb.onclick = act(() => api(`jobs/${job.id}/fallback`, {})); buttons.append(fb); }
    }
    return el('div', { className: 'job' },
      el('span', { className: `s-${job.status}`, textContent: job.status === 'queued' && job.error ? `retrying (${job.attempts}/${job.maxAttempts})` : job.status === 'waiting' ? 'waiting for you' : job.status }),
      el('div', {}, el('div', { textContent: `${job.label}${job.fallbackOf ? ' · fallback' : ''}${job.recoveredAt ? ' · recovered after restart' : ''}` }),
        job.error ? el('div', { className: 'advice', textContent: `${job.error.class}: ${job.error.message} ${job.error.advice}` }) : null),
      buttons);
  });
  const resume = failedBatches.map((id) => { const b = el('button', { className: 'small warn', textContent: 'Resume failed batch' }); b.onclick = act(() => api(`batches/${id}/resume`, {})); return b; });
  $('jobs').replaceChildren(...(resume.length ? [el('div', { className: 'row' }, resume)] : []), ...(rows.length ? rows : [el('p', { className: 'empty', textContent: 'Nothing has been rendered yet.' })]));
}

// ---------- hand-offs ----------
//
// One card per take that is waiting on a person. The studio has written
// the message and gathered the attachments; sending is done by hand, in
// the platform's own page.

function renderHandoffs() {
  const list = ui.state.handoffs;
  $('handoffs-tab').textContent = list.length ? `Hand-offs (${list.length})` : 'Hand-offs';
  // Redrawing would drop a text selection or a half-chosen file, so only
  // redraw when the set of hand-offs has actually changed.
  const signature = list.map((h) => h.jobId).join(',');
  if (renderHandoffs.signature === signature) return;
  renderHandoffs.signature = signature;
  if (!list.length) return $('handoffs').replaceChildren(el('p', { className: 'empty', textContent: 'Nothing is waiting on you. Route stills or video to ChatGPT or Gemini (top right, or on the look) and render a shot: the prompt and attachments will appear here for you to send.' }));
  $('handoffs').replaceChildren(...list.map((h) => {
    const copy = el('button', { className: 'primary', textContent: 'Copy message' });
    copy.onclick = async () => { await navigator.clipboard.writeText(h.message); toast('Copied. Paste it into the chat and send it yourself.'); };
    const open = el('a', { className: 'button', href: h.url, target: '_blank', rel: 'noopener', textContent: `Open ${h.generator.split(' (')[0]} ↗` });
    const file = el('input', { type: 'file', accept: h.accepts, hidden: true });
    const importBtn = el('button', { className: 'primary', textContent: 'Import the result…' });
    importBtn.onclick = () => file.click();
    file.onchange = act(async () => {
      const picked = file.files[0];
      if (!picked) return;
      const res = await fetch(`/api/jobs/${h.jobId}/deliver?name=${encodeURIComponent(picked.name)}`, { method: 'POST', headers: { 'Content-Type': picked.type || 'application/octet-stream' }, body: picked });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      ui.shotId = h.shotId;
      toast(`Imported as take ${data.take.n} of ${h.shotName}.`);
    });
    const refused = el('button', { className: 'small', textContent: 'It refused', title: 'Record that the platform would not make this' });
    refused.onclick = act(() => api(`jobs/${h.jobId}/refused`, {}));
    const cancel = el('button', { className: 'small', textContent: 'Withdraw' });
    cancel.onclick = act(() => api(`jobs/${h.jobId}/cancel`, {}));
    return el('div', { className: 'handoff' },
      el('h3', { textContent: `${h.shotName} · ${h.tier} · ${h.generator}` }),
      el('ol', {}, h.steps.map((step) => el('li', { textContent: step }))),
      h.attachments.length ? el('div', { className: 'refs' }, h.attachments.map((a) => el('a', { href: `${blobUrl(a.blobId)}?download=${encodeURIComponent(a.label)}`, title: `Download — ${a.why}` },
        el('figure', {}, el('img', { src: blobUrl(a.blobId) }), el('figcaption', { textContent: `↓ ${a.label}` }))))) : null,
      el('pre', { textContent: h.message }),
      el('div', { className: 'row' }, copy, open, importBtn, file, el('span', { className: 'spacer' }), refused, cancel));
  }));
}

function showView(view) {
  ui.view = view;
  document.querySelectorAll('.views button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  ['board', 'graph', 'handoffs'].forEach((id) => ($(id).hidden = id !== view));
}

// ---------- header ----------

function renderHeader() {
  const shots = ui.state.board.flatMap((s) => s.shots);
  const stale = shots.filter((s) => s.status.state === 'stale');
  const promotable = shots.filter((s) => s.status.state === 'approved' && s.take?.tier === 'proxy');
  $('rerender-stale').hidden = stale.length === 0;
  $('rerender-stale').textContent = `Re-render ${stale.length} out-of-sync shot${stale.length === 1 ? '' : 's'}`;
  $('rerender-stale').onclick = act(async () => { await api('rerender', { shotIds: stale.map((s) => s.id) }); toast(`Queued ${stale.length} proxy re-render${stale.length === 1 ? '' : 's'}. Approved takes stay approved until you approve a replacement.`); });
  $('promote-approved').hidden = promotable.length === 0;
  $('promote-approved').textContent = `Promote ${promotable.length} approved to master`;
  $('promote-approved').onclick = act(async () => {
    const r = await api('promote-approved', {});
    const skipped = r.skipped || [];
    toast(`Promoting ${r.results.length} to master.${skipped.length ? ` Skipped ${skipped.length}: ${skipped.map((s) => `${s.name} — ${s.reason}`).join(' ')}` : ''}`);
  });
  const d = ui.state.delivery;
  $('delivery').textContent = `${d.rows.filter((r) => r.state === 'mastered').length}/${d.rows.length} shots mastered · ${d.totalS}s`;
  $('chaos').value = ui.state.chaos;
  // Project-wide generators. Left alone while one is open.
  ['image', 'video'].forEach((kind) => {
    const select = $(`route-${kind}`);
    if (document.activeElement === select) return;
    select.replaceChildren(el('option', { value: '', textContent: 'built-in mock' }), ...modelsOf(kind).map((m) => el('option', { value: m.id, textContent: m.label })));
    select.value = ui.state.routing[kind] || '';
    select.onchange = act(async () => { await api('routing', { kind, modelId: select.value || null }); select.blur(); });
  });
}

async function refresh() {
  ui.state = await api('state');
  ui.detail = ui.shotId ? await api(`shots/${ui.shotId}`) : null;
  renderHeader(); renderBible(); renderJobs(); renderInspector(); renderHandoffs();
  if (ui.view === 'board') renderBoard();
  if (ui.view === 'graph') renderGraph();
}

document.querySelectorAll('.views button').forEach((button) => {
  button.onclick = () => { showView(button.dataset.view); refresh(); };
});
$('chaos').onchange = act(() => api('chaos', { mode: $('chaos').value }));

refresh();
setInterval(() => refresh().catch(() => {}), 1200);
