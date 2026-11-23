import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { boot } from './boot';
import './styles.css';

function Root() {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setPhase('loading');
    boot().then(
      () => setPhase('ready'),
      (e: Error) => {
        setError(e.message);
        setPhase('error');
      },
    );
  }, [attempt]);

  if (phase === 'ready') return <App />;
  return (
    <div className="boot">
      {phase === 'loading' ? (
        <span>Loading board…</span>
      ) : (
        <>
          <div>Cannot reach the board server ({error}).</div>
          <div className="boot-sub">Start it with start.bat (or npm run dev), then retry.</div>
          <button className="btn primary" onClick={() => setAttempt((a) => a + 1)}>Retry</button>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Root />);
