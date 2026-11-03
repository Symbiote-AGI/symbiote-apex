import ActivityOrb from './ActivityOrb';

export default function BrowserLoading({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <ActivityOrb label={label} state="connecting" size={compact ? 20 : 64} className={`browser-loading${compact ? ' browser-loading-compact' : ''}`} />
  );
}
