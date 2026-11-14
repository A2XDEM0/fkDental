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
      className={`flex h-9 w-full items-center rounded-full text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
        collapsed ? 'justify-center' : 'gap-3 px-4'
      } ${
        disabled
          ? 'cursor-not-allowed text-slate-400'
          : 'text-slate-700 hover:bg-slate-200'
      }`}
    >
      <span className="relative shrink-0">
        {icon}
        {badge && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-600 ring-2 ring-slate-100"
          />
        )}
      </span>
      <span className={collapsed ? 'sr-only' : 'truncate'}>{label}</span>
      {disabled && disabledTitle && (
        <span id={disabledDescriptionId} className="sr-only">{disabledTitle}</span>
      )}
    </button>
  );
};
