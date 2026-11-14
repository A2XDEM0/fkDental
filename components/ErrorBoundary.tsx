import React from 'react';

// 把某一块界面的渲染错误拦在这一块里，不让整个应用白屏。
// 项目没有装 @types/react，基类的成员在这里手动声明。
export class ErrorBoundary extends React.Component {
  declare props: { title: string; hint?: string; children?: React.ReactNode };
  declare setState: (state: { error: Error | null }) => void;
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`${this.props.title}：`, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <h2 className="text-xl font-medium text-slate-900">{this.props.title}</h2>
        {this.props.hint && <p className="max-w-md text-sm leading-6 text-slate-600">{this.props.hint}</p>}
        <p className="max-w-md break-words font-mono text-xs text-slate-500">{error.message}</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="mt-2 rounded-full border border-slate-300 px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-100"
        >
          重试
        </button>
      </div>
    );
  }
}
