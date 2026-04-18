type Props = {
  percent: number;
  label?: string;
};

export function ProgressBar({ percent, label }: Props): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex flex-col gap-2">
      <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
        <div
          className="h-full bg-primary transition-[width] duration-150"
          style={{ width: `${clamped}%` }}
        />
      </div>
      {label && <div className="text-xs text-muted-foreground">{label}</div>}
    </div>
  );
}
