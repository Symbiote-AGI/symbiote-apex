import { createRoot } from 'react-dom/client';
import { ThinkingOrb } from 'thinking-orbs';
import { useEffect, useState } from 'react';
import { getLoadingOrbState } from './components/activity-orb-state';
import './startup-splash.css';

function StartupSplash() {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor(performance.now() / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const takingLonger = elapsedSeconds >= 15;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <main className="startup-card" role="status" aria-live="polite">
      <ThinkingOrb
        state={getLoadingOrbState()}
        size={64}
        paused={reducedMotion}
        role="img"
        aria-label="Symbiote is starting"
        className="activity-orb startup-orb"
      />
      <div className="startup-mark">SYMBIOTE</div>
      <div className="startup-status">
        <span className="startup-pulse" aria-hidden="true" />
        {takingLonger ? 'Gateway is taking longer than expected' : 'Connecting to Symbiote Gateway...'}
      </div>
      {takingLonger && (
        <div className="startup-elapsed">
          Still connecting ({elapsedSeconds}s). Gateway startup will continue automatically.
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StartupSplash />);
