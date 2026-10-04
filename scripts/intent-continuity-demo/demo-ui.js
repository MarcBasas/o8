const id = 'demo-' + crypto.randomUUID();
const result = document.getElementById('result');
const descriptions = {
  check: 'Accepted by the actual AODL checker. This checks document rules, not task correctness.',
  save: 'Original saved. Version 0 now has its own record.',
  replay: 'Same original returned. The first saved timestamp stays the same.',
  overwrite: 'Overwrite refused (409). The original instructions stayed unchanged.',
  'new-version': 'Version 1 saved. Both versions now exist.',
  'read-original': 'Original read from disk. It still says 150 ms.',
};
for (const button of document.querySelectorAll('nav button')) button.addEventListener('click', () => {
  for (const tab of document.querySelectorAll('nav button')) {
    const selected = tab === button;
    tab.setAttribute('aria-selected', String(selected));
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
});
for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', async () => {
  const buttons = Array.from(document.querySelectorAll('[data-action]'));
  const prior = buttons.map(item => item.disabled);
  buttons.forEach(item => { item.disabled = true; });
  result.textContent = 'Running the pinned code…';
  let saved = false;
  try {
    const response = await fetch('/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: button.dataset.action, id }) });
    const value = await response.json();
    const expected = button.dataset.action === 'overwrite'
      ? value.status === 409 && value.error === 'intent_revision_conflict' : value.status === 200;
    result.dataset.error = String(!expected);
    result.textContent = expected ? descriptions[button.dataset.action]
      : 'Result: ' + (value.error || response.status);
    if (value.record) {
      const prefix = value.record.ref.revision === 0 ? 'original' : 'revised';
      document.getElementById(prefix + '-goal').textContent = JSON.parse(value.record.document).constraints.goal;
      document.getElementById(prefix + '-stamp').textContent = 'Saved at ' + value.record.createdAt;
      saved = value.record.ref.revision === 0;
    }
  } catch {
    result.dataset.error = 'true';
    result.textContent = 'The local demo server is unavailable.';
  } finally {
    buttons.forEach((item, index) => { item.disabled = saved ? false : prior[index]; });
  }
});

const steps = [
  ['Save the original request', 'Goal R1: respond faster, keep layout and behavior, do not deploy.',
    'Expected: the agreed target and verification procedure are saved once.'],
  ['Worker A begins', 'Worker A reads the relevant source and makes its own implementation plan.',
    'Expected: the worker plan cannot redefine goal R1.'],
  ['Hand the task to worker B', 'Carry R1, unfinished work and source-backed current facts to another supported runtime.',
    'Expected: the operator does not need to repeat the request.'],
  ['Change a relevant file', 'Deliberately modify the fixture source after the handoff snapshot.',
    'Expected: the carried claim becomes stale before worker B edits.'],
  ['Worker B refreshes', 'Worker B checks the changed source, then continues using current evidence.',
    'Expected: observation happens before the first edit based on the changed source.'],
  ['Verify against R1', 'Check response time, unchanged layout and behavior, and no deployment.',
    'Expected: real receipts establish success. An unchanged-source control avoids unnecessary refresh.'],
];
let step = 0;
const previous = document.getElementById('previous-step');
const next = document.getElementById('next-step');
function showStep() {
  document.getElementById('step-count').textContent = 'Planned step ' + (step + 1) + ' of ' + steps.length;
  document.getElementById('step-title').textContent = steps[step][0];
  document.getElementById('step-scene').textContent = steps[step][1];
  document.getElementById('step-detail').textContent = steps[step][2];
  previous.disabled = step === 0;
  next.disabled = step === steps.length - 1;
}
previous.addEventListener('click', () => { step -= 1; showStep(); });
next.addEventListener('click', () => { step += 1; showStep(); });
showStep();
