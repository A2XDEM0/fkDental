import type { FusionRequest, FusionResponse, FusionResults, FusionTask } from './protocol.ts';

type ProgressHandler = (stage: string, iteration: number, rms: number, inliers: number) => void;

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  onProgress?: ProgressHandler;
}

export class FusionWorkerClient {
  private worker = new Worker(new URL('./fusionWorker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<FusionResponse>) => {
      const message = event.data;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.kind === 'progress') {
        entry.onProgress?.(message.stage, message.iteration, message.rms, message.inliers);
        return;
      }
      this.pending.delete(message.id);
      if (message.kind === 'error') entry.reject(new Error(message.message));
      else entry.resolve(message.result as never);
    };
    this.worker.onerror = event => {
      const error = new Error(event.message || '影像计算线程出错。');
      this.pending.forEach(entry => entry.reject(error));
      this.pending.clear();
    };
  }

  run<T extends FusionTask>(task: T, transfer: Transferable[] = [], onProgress?: ProgressHandler): Promise<FusionResults[T['type']]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject, onProgress });
      this.worker.postMessage({ ...task, id } as FusionRequest, transfer);
    });
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}
