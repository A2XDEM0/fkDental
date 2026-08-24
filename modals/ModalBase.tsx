import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export const ModalBase = ({
  title,
  children,
  onClose,
  size = 'md',
  closeDisabled = false
}: {
  title: string;
  children?: React.ReactNode;
  onClose: () => void;
  size?: 'md' | 'lg' | 'xl' | '2xl';
  closeDisabled?: boolean;
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frameId = window.requestAnimationFrame(() => dialogRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frameId);
      previousFocusRef.current?.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !closeDisabled) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusableElements = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    const focusable = (Array.from(focusableElements ?? []) as HTMLElement[]).filter(
      element => element.getAttribute('aria-hidden') !== 'true'
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-2 sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`flex max-h-[calc(100vh-1rem)] w-full flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl outline-none ring-1 ring-white/40 focus-visible:ring-2 focus-visible:ring-teal-500 sm:max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in duration-200
          ${size === 'md' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : size === 'xl' ? 'max-w-5xl' : 'max-w-[min(1280px,calc(100vw-2rem))]'}`}
      >
        <div className="px-5 sm:px-8 py-4 sm:py-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/80 flex-shrink-0 gap-4">
          <h3 id={titleId} className="text-lg sm:text-xl font-bold text-slate-800 truncate">{title}</h3>
          <button
            type="button"
            aria-label={`关闭${title}`}
            onClick={onClose}
            disabled={closeDisabled}
            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
          >
            <X size={24}/>
          </button>
        </div>
        <div className="p-4 sm:p-6 lg:p-8 overflow-auto min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
};
