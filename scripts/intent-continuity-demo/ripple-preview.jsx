import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileRippleOverlay } from 'demo:mobile-ripple-overlay';
import { parseRippleResolutionResult } from 'demo:ripple-contract';

const resolution = parseRippleResolutionResult({
  kind: 'choice', id: 'demo-input-latency', question: 'What should be faster?',
  options: [{ label: 'Input latency', value: 'input-latency' }, { label: 'Animation', value: 'animation-duration' }],
  aodlPath: 'constraints.latency', confidence: 0.8,
});
if (!resolution || resolution.kind !== 'choice') throw new Error('Invalid sample question');
const palette = {
  rootText: 'light-dark(#202123, #f0f1f4)', subduedText: 'light-dark(#62666c, #bbc0c8)',
  cardBorder: 'light-dark(#d9dde3, #464b54)', panelElevated: 'light-dark(#ffffff, #252a32)',
  cardBackground: 'light-dark(#f8f9fa, #303640)', shadow: 'none',
};
function Preview() {
  const [visible, setVisible] = useState(true);
  const [answer, setAnswer] = useState('No choice made');
  function choose(choice) {
    setAnswer(choice.value === 'input-latency'
      ? 'Selected: respond sooner to taps and typing' : 'Selected: shorten the animation');
    setVisible(false);
  }
  return (
    <div style={{ maxWidth: 420, marginInline: 'auto', color: palette.rootText, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ marginBottom: 10 }}>Sample dictated text: “Make this faster.”</div>
      {visible && <MobileRippleOverlay palette={palette} resolution={resolution} onResolve={choose}
        onDismiss={() => { setAnswer('Dismissed: no choice recorded'); setVisible(false); }} />}
      <div aria-live="polite" style={{ marginTop: 12 }}>{answer}</div>
      {!visible && <button type="button" onClick={() => { setVisible(true); setAnswer('No choice made'); }}
        style={{ minHeight: 44, padding: '0 12px', marginTop: 10, borderRadius: 12, border: `1px solid ${palette.cardBorder}`,
          background: palette.cardBackground, color: palette.rootText, font: 'inherit' }}>Try the question again</button>}
    </div>
  );
}
const mount = document.getElementById('ripple-preview-root');
if (mount) createRoot(mount).render(<Preview />);
