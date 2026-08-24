import React, { useId } from 'react';

export const SidebarActionButton = ({
  icon,
  label,
  collapsed = false,
  onClick,
  disabled = false,
  badge = false,
  disabledTitle
}: {
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
  onClick: () => void;
  disabled?: boolean;
  badge?: boolean;
  disabledTitle?: string;
}) => {
  const disabledDescriptionId = useId();
  const accessibleLabel = badge ? `${label}，发现新版本` : label;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={accessibleLabel}
      aria-describedby={disabled && disabledTitle ? disabledDescriptionId : undefined}
      title={collapsed || disabled ? (disabled && disabledTitle ? disabledTitle : label) : undefined}
      className={`flex w-full items-center rounded-lg py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
        collapsed ? 'justify-center px-2' : 'gap-3 px-4'
      } ${
        disabled
          ? 'cursor-not-allowed text-slate-600'
          : 'text-slate-400 hover:bg-white/10 hover:text-white'
      }`}
    >
      <span className="relative shrink-0">
        {icon}
        {badge && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-slate-900"
          />
        )}
      </span>
      <span className={collapsed ? 'sr-only' : 'font-medium'}>{label}</span>
      {disabled && disabledTitle && (
        <span id={disabledDescriptionId} className="sr-only">{disabledTitle}</span>
      )}
    </button>
  );
};
