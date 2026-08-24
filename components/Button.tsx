import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'accent' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  size = 'md', 
  className = '', 
  ...props 
}) => {
  const baseStyles = "inline-flex items-center justify-center rounded-lg font-medium shadow-sm transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
  
  const variants = {
    primary: "bg-teal-600 text-white hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md focus-visible:ring-teal-500",
    accent: "bg-clay-600 text-white hover:-translate-y-0.5 hover:bg-clay-700 hover:shadow-md focus-visible:ring-clay-400",
    secondary: "border border-slate-300 bg-surface text-slate-700 hover:border-teal-300 hover:bg-teal-50 focus-visible:ring-teal-500",
    danger: "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500",
    ghost: "shadow-none text-slate-600 hover:bg-slate-100 focus-visible:ring-slate-400"
  };

  const sizes = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-sm",
    lg: "px-6 py-3 text-base"
  };

  return (
    <button 
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
