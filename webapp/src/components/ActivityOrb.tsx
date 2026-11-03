import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { getLoadingOrbState } from './activity-orb-state';

interface ActivityOrbProps {
  label: string;
  state?: OrbState;
  compact?: boolean;
  loading?: boolean;
  size?: 20 | 64;
  className?: string;
}

export default function ActivityOrb({ label, state = 'working', compact = false, loading = false, size = 20, className = '' }: ActivityOrbProps) {
  return (
    <ThinkingOrb
      state={loading ? getLoadingOrbState() : state}
      size={size}
      role="img"
      aria-label={label}
      className={`activity-orb${compact ? ' activity-orb-compact' : ''}${className ? ` ${className}` : ''}`}
      style={compact ? { width: 14, height: 14 } : size === 64 ? { width: 38, height: 38 } : undefined}
    />
  );
}
