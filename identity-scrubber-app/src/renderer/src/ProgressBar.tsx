type Props = {
  percent: number;
  label?: string;
};

export function ProgressBar({ percent, label }: Props): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="progress-wrap">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${clamped}%` }} />
      </div>
      {label && <div className="progress-label">{label}</div>}
    </div>
  );
}
