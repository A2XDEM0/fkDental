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
    className={`flex w-full items-center rounded-xl py-3 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${collapsed ? 'justify-center px-2' : 'gap-3 px-4'} ${
      active ? 'bg-teal-600 text-white shadow-[0_10px_24px_rgba(8,35,30,0.28)]' : 'text-slate-300 hover:bg-white/10 hover:text-white'
    }`}
  >
    <span className="shrink-0">{icon}</span>
    <span className={collapsed ? 'sr-only' : 'font-medium'}>{label}</span>
  </button>
);
