import React from 'react';

export const SidebarItem = ({
  icon,
  label,
  active,
  collapsed = false,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed?: boolean;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    aria-label={label}
    title={collapsed ? label : undefined}
    className={`flex h-10 w-full items-center rounded-full text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${collapsed ? 'justify-center' : 'gap-3 px-4'} ${
      active ? 'bg-teal-100 font-medium text-teal-900' : 'text-slate-700 hover:bg-slate-200'
    }`}
  >
    <span className="shrink-0">{icon}</span>
    <span className={collapsed ? 'sr-only' : 'truncate'}>{label}</span>
  </button>
);
